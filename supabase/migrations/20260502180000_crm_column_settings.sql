-- Preferências de títulos das colunas do Kanban CRM (status interno preservado).

create table if not exists public.crm_column_settings (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  status_key text not null,
  title text not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_column_settings_status_key_chk check (
    status_key in ('novo', 'em_atendimento', 'negociacao', 'fechado')
  ),
  constraint crm_column_settings_user_status_uidx unique (user_id, status_key)
);

create index if not exists crm_column_settings_user_idx
  on public.crm_column_settings (user_id);

comment on table public.crm_column_settings is
  'Títulos personalizados por usuário nas colunas do Kanban; `status_key` amarra ao enum de `public.leads.status`.';

alter table public.crm_column_settings enable row level security;

drop policy if exists crm_column_settings_own_select on public.crm_column_settings;
create policy crm_column_settings_own_select
  on public.crm_column_settings for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists crm_column_settings_own_mutate on public.crm_column_settings;
create policy crm_column_settings_own_mutate
  on public.crm_column_settings for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists crm_column_settings_touch on public.crm_column_settings;
create trigger crm_column_settings_touch
  before update on public.crm_column_settings
  for each row execute function public.tg_touch_updated_at();
