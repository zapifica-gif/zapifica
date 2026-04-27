-- ============================================================================
-- Multi-tenant (SaaS): user_profiles + roles + bypass de superadmin
-- ============================================================================

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  role text not null default 'client' check (role in ('client', 'superadmin')),
  company_name text,
  company_logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_profiles_user_id_idx
  on public.user_profiles (user_id);

alter table public.user_profiles enable row level security;

-- Trigger utilitária (já existe no projeto, mas garantimos)
create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at
  before update on public.user_profiles
  for each row execute function public.tg_touch_updated_at();

-- Função helper para RLS: identifica superadmin via user_profiles.role
create or replace function public.is_superadmin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_profiles up
    where up.user_id = p_uid
      and up.role = 'superadmin'
  );
$$;

revoke all on function public.is_superadmin(uuid) from public;
grant execute on function public.is_superadmin(uuid) to authenticated;

-- Políticas: user_profiles (dono ou superadmin)
drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own
  on public.user_profiles for select
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists user_profiles_insert_own on public.user_profiles;
create policy user_profiles_insert_own
  on public.user_profiles for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists user_profiles_update_own on public.user_profiles;
create policy user_profiles_update_own
  on public.user_profiles for update
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()))
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists user_profiles_delete_own on public.user_profiles;
create policy user_profiles_delete_own
  on public.user_profiles for delete
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

-- Trigger: cria user_profile automaticamente ao registrar usuário
create or replace function public.tg_create_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, role)
  values (new.id, 'client')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_create_user_profile on auth.users;
create trigger trg_create_user_profile
  after insert on auth.users
  for each row execute function public.tg_create_user_profile();

-- ---------------------------------------------------------------------------
-- Bypass de superadmin: leads e campanhas Zap Voice
-- ---------------------------------------------------------------------------

-- Leads
drop policy if exists "leads_select_own" on public.leads;
create policy "leads_select_own"
  on public.leads for select
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists "leads_insert_own" on public.leads;
create policy "leads_insert_own"
  on public.leads for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists "leads_update_own" on public.leads;
create policy "leads_update_own"
  on public.leads for update
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()))
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists "leads_delete_own" on public.leads;
create policy "leads_delete_own"
  on public.leads for delete
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

-- Campanhas Zap Voice
drop policy if exists zv_campaigns_select_own on public.zv_campaigns;
create policy zv_campaigns_select_own
  on public.zv_campaigns for select
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists zv_campaigns_insert_own on public.zv_campaigns;
create policy zv_campaigns_insert_own
  on public.zv_campaigns for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists zv_campaigns_update_own on public.zv_campaigns;
create policy zv_campaigns_update_own
  on public.zv_campaigns for update
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()))
  with check (auth.uid() = user_id or public.is_superadmin(auth.uid()));

drop policy if exists zv_campaigns_delete_own on public.zv_campaigns;
create policy zv_campaigns_delete_own
  on public.zv_campaigns for delete
  to authenticated
  using (auth.uid() = user_id or public.is_superadmin(auth.uid()));

-- Funis (via campaign_id) — permite superadmin também
drop policy if exists zv_funnels_select_own on public.zv_funnels;
create policy zv_funnels_select_own
  on public.zv_funnels for select
  to authenticated
  using (
    public.is_superadmin(auth.uid()) or
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  );

drop policy if exists zv_funnels_insert_own on public.zv_funnels;
create policy zv_funnels_insert_own
  on public.zv_funnels for insert
  to authenticated
  with check (
    public.is_superadmin(auth.uid()) or
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  );

drop policy if exists zv_funnels_update_own on public.zv_funnels;
create policy zv_funnels_update_own
  on public.zv_funnels for update
  to authenticated
  using (
    public.is_superadmin(auth.uid()) or
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  )
  with check (
    public.is_superadmin(auth.uid()) or
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  );

drop policy if exists zv_funnels_delete_own on public.zv_funnels;
create policy zv_funnels_delete_own
  on public.zv_funnels for delete
  to authenticated
  using (
    public.is_superadmin(auth.uid()) or
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  );

