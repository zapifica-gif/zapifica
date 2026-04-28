-- ============================================================================
-- Zap Voice — Públicos (listas salvas de leads selecionados)
-- Permite criar campanhas por público salvo ou por leads individuais.
-- ============================================================================

create table if not exists public.zv_audiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  lead_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zv_audiences_user_idx
  on public.zv_audiences (user_id, created_at desc);

create index if not exists zv_audiences_lead_ids_gin
  on public.zv_audiences using gin (lead_ids);

drop trigger if exists trg_zv_audiences_updated_at on public.zv_audiences;
create trigger trg_zv_audiences_updated_at
  before update on public.zv_audiences
  for each row execute function public.zv_set_updated_at();

alter table public.zv_audiences enable row level security;

drop policy if exists zv_audiences_select_own on public.zv_audiences;
create policy zv_audiences_select_own
  on public.zv_audiences for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists zv_audiences_insert_own on public.zv_audiences;
create policy zv_audiences_insert_own
  on public.zv_audiences for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists zv_audiences_update_own on public.zv_audiences;
create policy zv_audiences_update_own
  on public.zv_audiences for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists zv_audiences_delete_own on public.zv_audiences;
create policy zv_audiences_delete_own
  on public.zv_audiences for delete
  to authenticated
  using (auth.uid() = user_id);

comment on table public.zv_audiences is
  'Públicos salvos do Zap Voice: lista explícita de leads selecionados (uuid[]).';

comment on column public.zv_audiences.lead_ids is
  'IDs dos leads incluídos neste público. Usado na ativação/disparo da campanha.';

-- Campanhas: agora podem apontar para um público salvo ou para leads individuais
alter table public.zv_campaigns
  add column if not exists audience_type text not null default 'tags'
    check (audience_type in ('tags', 'audience', 'individual')),
  add column if not exists audience_id uuid references public.zv_audiences (id) on delete set null,
  add column if not exists audience_lead_ids uuid[] not null default '{}';

create index if not exists zv_campaigns_audience_type_idx
  on public.zv_campaigns (user_id, audience_type, created_at desc);

create index if not exists zv_campaigns_audience_id_idx
  on public.zv_campaigns (user_id, audience_id);

create index if not exists zv_campaigns_audience_lead_ids_gin
  on public.zv_campaigns using gin (audience_lead_ids);

