-- =============================================================================
-- CRM Kanban: colunas dinâmicas por usuário (título + cor + ordem + slug estável)
-- - Substitui o check fixo de leads.status por validação contra crm_kanban_columns
-- - Migra títulos de crm_column_settings quando existirem
-- - RPCs: busca global + contagem de atividade recente (sininho)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela de colunas do funil
-- ---------------------------------------------------------------------------
create table if not exists public.crm_kanban_columns (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  key_slug text not null,
  title text not null,
  color_hex text not null default '#6a00b8',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_kanban_columns_key_slug_format_chk check (
    char_length(trim(key_slug)) >= 1
      and char_length(trim(key_slug)) <= 80
      and key_slug ~ '^[a-z0-9_]+$'
  ),
  constraint crm_kanban_columns_user_slug_uidx unique (user_id, key_slug)
);

create index if not exists crm_kanban_columns_user_sort_idx
  on public.crm_kanban_columns (user_id, sort_order, created_at);

comment on table public.crm_kanban_columns is
  'Etapas do Kanban CRM por usuário; leads.status armazena key_slug da coluna.';

alter table public.crm_kanban_columns enable row level security;

drop policy if exists crm_kanban_columns_own_select on public.crm_kanban_columns;
create policy crm_kanban_columns_own_select
  on public.crm_kanban_columns for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists crm_kanban_columns_own_mutate on public.crm_kanban_columns;
create policy crm_kanban_columns_own_mutate
  on public.crm_kanban_columns for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists crm_kanban_columns_touch on public.crm_kanban_columns;
create trigger crm_kanban_columns_touch
  before update on public.crm_kanban_columns
  for each row execute function public.tg_touch_updated_at ();

-- ---------------------------------------------------------------------------
-- 2) Remover check estático de leads.status (passa a validar contra colunas)
-- ---------------------------------------------------------------------------
alter table public.leads drop constraint if exists leads_status_check;

-- ---------------------------------------------------------------------------
-- 3) Função: garantir 4 colunas padrão (slug alinhado ao legado)
-- ---------------------------------------------------------------------------
create or replace function public.crm_seed_default_kanban_columns(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from public.crm_kanban_columns c where c.user_id = p_user_id) then
    insert into public.crm_kanban_columns (user_id, key_slug, title, color_hex, sort_order)
    values
      (p_user_id, 'novo', 'Novo Lead', '#4285f4', 0),
      (p_user_id, 'em_atendimento', 'Em Atendimento', '#6a00b8', 1),
      (p_user_id, 'negociacao', 'Negociação', '#fbbc05', 2),
      (p_user_id, 'fechado', 'Fechado', '#34a853', 3);
  end if;
end;
$$;

revoke all on function public.crm_seed_default_kanban_columns(uuid) from public;
grant execute on function public.crm_seed_default_kanban_columns(uuid) to authenticated;

comment on function public.crm_seed_default_kanban_columns(uuid) is
  'Cria as 4 colunas padrão do Kanban para o usuário se ainda não existir nenhuma.';

-- ---------------------------------------------------------------------------
-- 4) Backfill: usuários com leads + títulos antigos em crm_column_settings
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select distinct user_id from public.leads
  loop
    perform public.crm_seed_default_kanban_columns(r.user_id);
  end loop;
end $$;

-- Normaliza status legado "atendimento" -> em_atendimento
update public.leads
set status = 'em_atendimento'
where trim(lower(status)) = 'atendimento';

-- Migra títulos personalizados (crm_column_settings) para crm_kanban_columns, se a tabela legado existir
do $$
begin
  if to_regclass('public.crm_column_settings') is not null then
    update public.crm_kanban_columns c
    set title = trim(s.title),
        updated_at = now()
    from public.crm_column_settings s
    where s.user_id = c.user_id
      and s.status_key = c.key_slug
      and trim(s.title) is not null
      and trim(s.title) <> '';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Validação: leads.status precisa existir como key_slug nas colunas do user
-- ---------------------------------------------------------------------------
create or replace function public.trg_leads_validate_kanban_status()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.crm_seed_default_kanban_columns(new.user_id);
  if not exists (
    select 1
    from public.crm_kanban_columns k
    where k.user_id = new.user_id
      and k.key_slug = new.status
  ) then
    raise exception 'status inválido para o funil: %', new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_validate_kanban_status on public.leads;
create trigger leads_validate_kanban_status
  before insert or update of status, user_id on public.leads
  for each row execute function public.trg_leads_validate_kanban_status ();

-- ---------------------------------------------------------------------------
-- 6) Remove tabela antiga de só título (dados já migrados)
-- ---------------------------------------------------------------------------
drop table if exists public.crm_column_settings cascade;

-- ---------------------------------------------------------------------------
-- 7) RPC — Busca global (contatos + trecho de mensagens)
-- ---------------------------------------------------------------------------
create or replace function public.crm_global_search(
  p_user_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  result_type text,
  lead_id uuid,
  lead_name text,
  phone text,
  snippet text,
  message_id uuid,
  msg_created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select trim(p_query) as t
  ),
  lim as (
    select greatest(1, least(coalesce(p_limit, 20), 50)) as n
  ),
  leads_hit as (
    select
      'lead'::text as result_type,
      l.id as lead_id,
      l.name::text as lead_name,
      coalesce(l.phone, '')::text as phone,
      null::text as snippet,
      null::uuid as message_id,
      null::timestamptz as msg_created_at
    from public.leads l, q, lim
    where l.user_id = p_user_id
      and (
        auth.uid() = p_user_id
        or exists (
          select 1
          from public.user_profiles up
          where up.user_id = auth.uid()
            and up.role = 'superadmin'
        )
      )
      and length(q.t) >= 2
      and (
        l.name ilike '%' || q.t || '%'
        or coalesce(l.phone, '') ilike '%' || q.t || '%'
      )
    order by l.updated_at desc nulls last
    limit (select n from lim)
  ),
  msg_hit as (
    select
      'message'::text as result_type,
      l.id as lead_id,
      l.name::text as lead_name,
      coalesce(l.phone, '')::text as phone,
      left(coalesce(cm.message_body, ''), 200)::text as snippet,
      cm.id as message_id,
      cm.created_at as msg_created_at
    from public.chat_messages cm
    join public.leads l on l.id = cm.lead_id and l.user_id = p_user_id
    cross join q
    cross join lim
    where (
      auth.uid() = p_user_id
      or exists (
        select 1
        from public.user_profiles up
        where up.user_id = auth.uid()
          and up.role = 'superadmin'
      )
    )
      and length(q.t) >= 2
      and coalesce(cm.message_body, '') ilike '%' || q.t || '%'
    order by cm.created_at desc
    limit (select n from lim)
  )
  select * from leads_hit
  union all
  select * from msg_hit
  order by result_type, msg_created_at desc nulls last
  limit (select n from lim);
$$;

revoke all on function public.crm_global_search(uuid, text, integer) from public;
grant execute on function public.crm_global_search(uuid, text, integer) to authenticated;

comment on function public.crm_global_search(uuid, text, integer) is
  'Busca leads por nome/telefone e mensagens por texto; tenant p_user_id ou superadmin.';

-- ---------------------------------------------------------------------------
-- 8) RPC — “Sininho”: leads com mensagem de cliente nas últimas 72h
-- ---------------------------------------------------------------------------
create or replace function public.crm_recent_client_threads_count(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from (
    select distinct cm.lead_id
    from public.chat_messages cm
    join public.leads l on l.id = cm.lead_id and l.user_id = p_user_id
    where (
      auth.uid() = p_user_id
      or exists (
        select 1
        from public.user_profiles up
        where up.user_id = auth.uid()
          and up.role = 'superadmin'
      )
    )
      and cm.sender_type = 'cliente'
      and cm.created_at > (now() - interval '72 hours')
  ) s;
$$;

revoke all on function public.crm_recent_client_threads_count(uuid) from public;
grant execute on function public.crm_recent_client_threads_count(uuid) to authenticated;

comment on function public.crm_recent_client_threads_count(uuid) is
  'Conta leads distintos com mensagem do cliente nas últimas 72h; tenant ou superadmin.';
