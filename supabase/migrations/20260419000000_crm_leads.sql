-- ============================================================================
-- CRM: leads exibidos no Kanban e criados automaticamente pelo webhook Evolution
-- ============================================================================

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Sem nome',
  phone text,
  status text not null default 'novo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leads
  add column if not exists user_id uuid references auth.users (id) on delete cascade,
  add column if not exists name text not null default 'Sem nome',
  add column if not exists phone text,
  add column if not exists status text not null default 'novo',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.leads
    add constraint leads_status_check
    check (status in ('novo', 'em_atendimento', 'atendimento', 'negociacao', 'fechado'));
exception
  when duplicate_object then null;
end $$;

create index if not exists leads_user_id_idx
  on public.leads (user_id);

create index if not exists leads_user_status_created_idx
  on public.leads (user_id, status, created_at);

create index if not exists leads_user_phone_idx
  on public.leads (user_id, phone);

alter table public.leads enable row level security;

drop policy if exists "leads_select_own" on public.leads;
create policy "leads_select_own"
  on public.leads for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "leads_insert_own" on public.leads;
create policy "leads_insert_own"
  on public.leads for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "leads_update_own" on public.leads;
create policy "leads_update_own"
  on public.leads for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "leads_delete_own" on public.leads;
create policy "leads_delete_own"
  on public.leads for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.tg_touch_updated_at();
