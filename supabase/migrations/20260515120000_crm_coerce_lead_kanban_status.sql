-- =============================================================================
-- CRM: status do lead sempre alinhado às colunas dinâmicas do funil
-- - Evita insert/update com slug inexistente (ex.: webhook enviava sempre "novo")
-- - Após cada mensagem no chat, revalida o lead e move para a 1ª coluna se órfão
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) BEFORE INSERT/UPDATE em leads: em vez de erro, força a 1ª coluna (sort_order)
-- ---------------------------------------------------------------------------
create or replace function public.trg_leads_validate_kanban_status()
returns trigger
language plpgsql
security invoker
set search_path = public
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
  'Garante leads.status em key_slug existente; se inválido, usa a etapa com menor sort_order.';

-- ---------------------------------------------------------------------------
-- 2) Após nova mensagem: se o lead ficou com status órfão (coluna excluída), corrige
-- ---------------------------------------------------------------------------
create or replace function public.trg_chat_messages_coerce_lead_kanban()
returns trigger
language plpgsql
security definer
set search_path = public
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

revoke all on function public.trg_chat_messages_coerce_lead_kanban() from public;

drop trigger if exists chat_messages_coerce_lead_kanban on public.chat_messages;
create trigger chat_messages_coerce_lead_kanban
  after insert on public.chat_messages
  for each row execute function public.trg_chat_messages_coerce_lead_kanban();

comment on function public.trg_chat_messages_coerce_lead_kanban() is
  'Após insert em chat_messages, alinha leads.status à primeira etapa do funil se o slug atual não existir.';

-- Webhook (service_role) chama o seed via RPC antes de inserir o lead
grant execute on function public.crm_seed_default_kanban_columns(uuid) to service_role;
