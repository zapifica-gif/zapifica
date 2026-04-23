-- ============================================================================
-- Zapifica — schema inicial da Agenda Suprema e integrações
-- Projeto novo: hkcisuewgzhyzozwurzf
--
-- Este script cria TUDO o que o código da Agenda precisa:
--   * public.profiles             (telefone do lembrete pessoal)
--   * public.events               (eventos do calendário)
--   * public.scheduled_messages   (fila de disparos Evolution/WhatsApp)
--
-- Pontos importantes:
--   * RLS habilitada em todas as tabelas; cada usuário só enxerga e altera
--     os próprios registros (auth.uid() = user_id).
--   * scheduled_messages.event_id tem FK para events(id); sem essa FK o embed
--     do PostgREST (events?select=...,scheduled_messages(...)) falha silen-
--     ciosamente e a Agenda aparece vazia.
--   * A Edge Function usa service_role e continua podendo ler/escrever tudo
--     (RLS não se aplica ao service_role).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) profiles (telefone pessoal do agente da agência)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  phone text,
  whatsapp text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_upsert_own" on public.profiles;
create policy "profiles_upsert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 2) events (calendário da Agenda Suprema)
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  category text not null default 'outro'
    check (category in ('reuniao', 'ligacao', 'visita', 'suporte', 'outro')),
  client_id uuid references public.leads (id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  sync_kanban boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_end_after_start check (end_at > start_at)
);

create index if not exists events_user_id_idx
  on public.events (user_id);

create index if not exists events_user_start_idx
  on public.events (user_id, start_at);

create index if not exists events_user_range_idx
  on public.events (user_id, start_at, end_at);

alter table public.events enable row level security;

drop policy if exists "events_select_own" on public.events;
create policy "events_select_own"
  on public.events for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "events_insert_own" on public.events;
create policy "events_insert_own"
  on public.events for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "events_update_own" on public.events;
create policy "events_update_own"
  on public.events for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "events_delete_own" on public.events;
create policy "events_delete_own"
  on public.events for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3) scheduled_messages (fila de disparos Evolution ligada a eventos)
-- ---------------------------------------------------------------------------
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  is_active boolean not null default true,
  recipient_type text not null default 'personal'
    check (recipient_type in ('personal', 'segment')),
  content_type text not null default 'text'
    check (content_type in ('text', 'audio', 'image')),
  message_body text,
  scheduled_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed', 'error', 'cancelled')),
  segment_lead_ids uuid[] not null default '{}',
  recipient_phone text,
  evolution_instance_name text,
  evolution_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- event_id é único: garantimos 1:1 entre evento e disparo agendado, o que
-- também habilita upsert idempotente por event_id no front-end.
create unique index if not exists scheduled_messages_event_id_uidx
  on public.scheduled_messages (event_id);

create index if not exists scheduled_messages_user_id_idx
  on public.scheduled_messages (user_id);

create index if not exists scheduled_messages_worker_idx
  on public.scheduled_messages (status, is_active, scheduled_at);

alter table public.scheduled_messages enable row level security;

drop policy if exists "sched_msgs_select_own" on public.scheduled_messages;
create policy "sched_msgs_select_own"
  on public.scheduled_messages for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "sched_msgs_insert_own" on public.scheduled_messages;
create policy "sched_msgs_insert_own"
  on public.scheduled_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "sched_msgs_update_own" on public.scheduled_messages;
create policy "sched_msgs_update_own"
  on public.scheduled_messages for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "sched_msgs_delete_own" on public.scheduled_messages;
create policy "sched_msgs_delete_own"
  on public.scheduled_messages for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4) Trigger utilitário para manter updated_at em dia
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists scheduled_messages_touch_updated_at on public.scheduled_messages;
create trigger scheduled_messages_touch_updated_at
  before update on public.scheduled_messages
  for each row execute function public.tg_touch_updated_at();
