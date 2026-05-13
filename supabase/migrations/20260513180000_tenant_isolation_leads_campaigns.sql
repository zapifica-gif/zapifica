-- ============================================================================
-- Isolamento multi-tenant (urgente)
--
-- 1) Remove bypass de superadmin em SELECT/CRUD direto em `public.leads` e
--    `public.zv_campaigns` — apenas auth.uid() = user_id.
-- 2) RPC Kanban: `crm_leads_with_conversation` só retorna dados se o caller
--    for o próprio dono (p_user_id = auth.uid()).
-- 3) Painel interno: `superadmin_list_leads` (security definer) para quem
--    for superadmin listar leads de todos os tenants sem abrir a tabela.
-- 4) Reafirma RLS em `events` e `scheduled_messages` (já eram por user_id).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- public.leads
-- ---------------------------------------------------------------------------
alter table public.leads enable row level security;

drop policy if exists "leads_select_own" on public.leads;
drop policy if exists "leads_insert_own" on public.leads;
drop policy if exists "leads_update_own" on public.leads;
drop policy if exists "leads_delete_own" on public.leads;

create policy "leads_select_own"
  on public.leads for select
  to authenticated
  using (auth.uid() = user_id);

create policy "leads_insert_own"
  on public.leads for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "leads_update_own"
  on public.leads for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "leads_delete_own"
  on public.leads for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- public.zv_campaigns
-- ---------------------------------------------------------------------------
alter table public.zv_campaigns enable row level security;

drop policy if exists zv_campaigns_select_own on public.zv_campaigns;
drop policy if exists zv_campaigns_insert_own on public.zv_campaigns;
drop policy if exists zv_campaigns_update_own on public.zv_campaigns;
drop policy if exists zv_campaigns_delete_own on public.zv_campaigns;

create policy zv_campaigns_select_own
  on public.zv_campaigns for select
  to authenticated
  using (auth.uid() = user_id);

create policy zv_campaigns_insert_own
  on public.zv_campaigns for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy zv_campaigns_update_own
  on public.zv_campaigns for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy zv_campaigns_delete_own
  on public.zv_campaigns for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RPC: lista global só para superadmin (substitui SELECT amplo na tabela)
-- ---------------------------------------------------------------------------
create or replace function public.superadmin_list_leads(p_limit integer default 200)
returns table (
  id uuid,
  user_id uuid,
  name text,
  phone text,
  source text,
  tag text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.user_id,
    l.name,
    l.phone,
    l.source,
    l.tag,
    l.created_at
  from public.leads l
  where public.is_superadmin(auth.uid())
  order by l.created_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 2000));
$$;

revoke all on function public.superadmin_list_leads(integer) from public;
grant execute on function public.superadmin_list_leads(integer) to authenticated;

comment on function public.superadmin_list_leads(integer) is
  'Painel Zapifica: lista leads de todos os tenants apenas se auth.uid() for superadmin.';

-- ---------------------------------------------------------------------------
-- RPC Kanban: remove bypass de superadmin na leitura de leads por user_id
-- (assinatura alinhada a 20260503100000_leads_ai_paused_until_human_handoff.sql)
-- ---------------------------------------------------------------------------
drop function if exists public.crm_leads_with_conversation(uuid);

create or replace function public.crm_leads_with_conversation(p_user_id uuid)
returns table (
  id uuid,
  name text,
  phone text,
  status text,
  profile_picture_url text,
  is_group boolean,
  last_message_at timestamptz,
  updated_at timestamptz,
  ai_paused_until timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.name,
    l.phone,
    l.status,
    l.profile_picture_url,
    coalesce(l.is_group, false) as is_group,
    l.last_message_at,
    l.updated_at,
    l.ai_paused_until
  from public.leads l
  where l.user_id = p_user_id
    and auth.uid() = p_user_id
    and (
      exists (
        select 1
        from public.chat_messages cm
        where cm.lead_id = l.id
      )
      or coalesce(l.crm_show_without_chat, false) = true
    )
  order by
    l.last_message_at desc nulls last,
    l.updated_at desc;
$$;

revoke all on function public.crm_leads_with_conversation(uuid) from public;
grant execute on function public.crm_leads_with_conversation(uuid) to authenticated;

comment on function public.crm_leads_with_conversation(uuid) is
  'Lista leads do Kanban do próprio tenant; exige auth.uid() = p_user_id.';

-- ---------------------------------------------------------------------------
-- Agenda: events + scheduled_messages (garante políticas por user_id)
-- ---------------------------------------------------------------------------
alter table public.events enable row level security;

drop policy if exists "events_select_own" on public.events;
drop policy if exists "events_insert_own" on public.events;
drop policy if exists "events_update_own" on public.events;
drop policy if exists "events_delete_own" on public.events;

create policy "events_select_own"
  on public.events for select
  to authenticated
  using (auth.uid() = user_id);

create policy "events_insert_own"
  on public.events for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "events_update_own"
  on public.events for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "events_delete_own"
  on public.events for delete
  to authenticated
  using (auth.uid() = user_id);

alter table public.scheduled_messages enable row level security;

drop policy if exists "sched_msgs_select_own" on public.scheduled_messages;
drop policy if exists "sched_msgs_insert_own" on public.scheduled_messages;
drop policy if exists "sched_msgs_update_own" on public.scheduled_messages;
drop policy if exists "sched_msgs_delete_own" on public.scheduled_messages;

create policy "sched_msgs_select_own"
  on public.scheduled_messages for select
  to authenticated
  using (auth.uid() = user_id);

create policy "sched_msgs_insert_own"
  on public.scheduled_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "sched_msgs_update_own"
  on public.scheduled_messages for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "sched_msgs_delete_own"
  on public.scheduled_messages for delete
  to authenticated
  using (auth.uid() = user_id);
