-- ============================================================================
-- Zap Voice — Campanhas e Funis (etapas de mensagem)
-- ============================================================================

-- Status da campanha (rascunho, ativa, pausada, concluída)
do $$ begin
  create type public.zv_campaign_status as enum ('draft', 'active', 'paused', 'completed');
exception
  when duplicate_object then null;
end $$;

-- 1) Campanha (uma “entidade pai” de uma sequência de disparos)
create table if not exists public.zv_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  -- tag usada para casar com leads (em `public.leads.tag`); preencher
  -- automaticamente quando o usuário "Enviar para Zap Voice" do extrator.
  audience_tag text,
  status public.zv_campaign_status not null default 'draft',
  default_delay_seconds integer not null default 60,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zv_campaigns_user_idx
  on public.zv_campaigns (user_id, created_at desc);

create index if not exists zv_campaigns_user_tag_idx
  on public.zv_campaigns (user_id, audience_tag);

-- 2) Funil — cada etapa do roteiro da campanha
create table if not exists public.zv_funnels (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.zv_campaigns (id) on delete cascade,
  step_order integer not null,
  message text not null default '',
  delay_seconds integer not null default 0,
  expected_trigger text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint zv_funnels_step_order_per_campaign unique (campaign_id, step_order)
);

create index if not exists zv_funnels_campaign_idx
  on public.zv_funnels (campaign_id, step_order);

-- ----------------------------------------------------------------------------
-- updated_at automático
-- ----------------------------------------------------------------------------
create or replace function public.zv_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_zv_campaigns_updated_at on public.zv_campaigns;
create trigger trg_zv_campaigns_updated_at
  before update on public.zv_campaigns
  for each row execute function public.zv_set_updated_at();

drop trigger if exists trg_zv_funnels_updated_at on public.zv_funnels;
create trigger trg_zv_funnels_updated_at
  before update on public.zv_funnels
  for each row execute function public.zv_set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — cada usuário só vê e mexe nas próprias campanhas
-- ----------------------------------------------------------------------------
alter table public.zv_campaigns enable row level security;
alter table public.zv_funnels enable row level security;

drop policy if exists zv_campaigns_select_own on public.zv_campaigns;
create policy zv_campaigns_select_own
  on public.zv_campaigns for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists zv_campaigns_insert_own on public.zv_campaigns;
create policy zv_campaigns_insert_own
  on public.zv_campaigns for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists zv_campaigns_update_own on public.zv_campaigns;
create policy zv_campaigns_update_own
  on public.zv_campaigns for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists zv_campaigns_delete_own on public.zv_campaigns;
create policy zv_campaigns_delete_own
  on public.zv_campaigns for delete
  to authenticated
  using (auth.uid() = user_id);

-- Funis: o vínculo é via campaign_id; checamos a posse na campanha.
drop policy if exists zv_funnels_select_own on public.zv_funnels;
create policy zv_funnels_select_own
  on public.zv_funnels for select
  to authenticated
  using (
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
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  )
  with check (
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
    exists (
      select 1 from public.zv_campaigns c
      where c.id = zv_funnels.campaign_id and c.user_id = auth.uid()
    )
  );
