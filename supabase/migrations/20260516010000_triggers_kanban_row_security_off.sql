-- =============================================================================
-- HOTFIX: ingestão ainda quebrando após correção do seed
--
-- Causa em cadeia:
-- 1) INSERT em chat_messages → AFTER trigger `trg_chat_messages_coerce_lead_kanban`
--    faz UPDATE em leads (status).
-- 2) BEFORE UPDATE em leads dispara `trg_leads_validate_kanban_status` como
--    SECURITY INVOKER → no contexto do UPDATE disparado pelo definer do chat,
--    o papel efetivo não enxerga `crm_kanban_columns` (policies só TO authenticated).
-- 3) SELECT first_slug retorna NULL → RAISE EXCEPTION → ROLLBACK de tudo,
--    inclusive o INSERT em chat_messages.
--
-- Correção: ambas as funções de trigger passam a SECURITY DEFINER + row_security off.
-- Escopo de dados continua restrito a new.user_id / lead_id da própria linha.
-- =============================================================================

create or replace function public.trg_leads_validate_kanban_status()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  first_slug text;
begin
  perform public.crm_seed_default_kanban_columns(new.user_id);

  if exists (
    select 1
    from public.crm_kanban_columns k
    where k.user_id = new.user_id
      and k.key_slug = new.status
  ) then
    return new;
  end if;

  select k.key_slug
    into first_slug
  from public.crm_kanban_columns k
  where k.user_id = new.user_id
  order by k.sort_order asc nulls last, k.created_at asc
  limit 1;

  if first_slug is null or trim(first_slug) = '' then
    raise exception 'Nenhuma coluna do funil para o usuário; defina etapas em CRM antes de gravar leads.';
  end if;

  new.status := first_slug;
  return new;
end;
$$;

comment on function public.trg_leads_validate_kanban_status() is
  'Garante leads.status em key_slug existente; SECURITY DEFINER + RLS off (triggers + policies authenticated).';

create or replace function public.trg_chat_messages_coerce_lead_kanban()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid;
  st text;
  first_slug text;
begin
  select l.user_id, l.status
    into uid, st
  from public.leads l
  where l.id = new.lead_id;

  if uid is null then
    return new;
  end if;

  perform public.crm_seed_default_kanban_columns(uid);

  if exists (
    select 1
    from public.crm_kanban_columns k
    where k.user_id = uid
      and k.key_slug = st
  ) then
    return new;
  end if;

  select k.key_slug
    into first_slug
  from public.crm_kanban_columns k
  where k.user_id = uid
  order by k.sort_order asc nulls last, k.created_at asc
  limit 1;

  if first_slug is null then
    return new;
  end if;

  update public.leads
  set
    status = first_slug,
    updated_at = now()
  where id = new.lead_id
    and user_id = uid;

  return new;
end;
$$;

revoke all on function public.trg_leads_validate_kanban_status() from public;
revoke all on function public.trg_chat_messages_coerce_lead_kanban() from public;

comment on function public.trg_chat_messages_coerce_lead_kanban() is
  'Após insert em chat_messages, alinha leads.status; SECURITY DEFINER + RLS off.';
