-- ============================================================================
-- Zap Voice — Fluxos (zv_flows) separados de Campanhas (isca + gatilho + flow_id)
-- ============================================================================

do $$ begin
  create type public.zv_trigger_condition as enum (
    'equals',
    'contains',
    'starts_with',
    'not_contains'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.zv_flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zv_flows_user_idx
  on public.zv_flows (user_id, created_at desc);

drop trigger if exists trg_zv_flows_updated_at on public.zv_flows;
create trigger trg_zv_flows_updated_at
  before update on public.zv_flows
  for each row execute function public.zv_set_updated_at();

alter table public.zv_flows enable row level security;

drop policy if exists zv_flows_select_own on public.zv_flows;
create policy zv_flows_select_own
  on public.zv_flows for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists zv_flows_insert_own on public.zv_flows;
create policy zv_flows_insert_own
  on public.zv_flows for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists zv_flows_update_own on public.zv_flows;
create policy zv_flows_update_own
  on public.zv_flows for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists zv_flows_delete_own on public.zv_flows;
create policy zv_flows_delete_own
  on public.zv_flows for delete
  to authenticated
  using (auth.uid() = user_id);

-- Colunas de campanha
alter table public.zv_campaigns
  add column if not exists isca_message text;
alter table public.zv_campaigns
  add column if not exists flow_id uuid;
alter table public.zv_campaigns
  add column if not exists trigger_condition public.zv_trigger_condition not null default 'equals';

-- Mapa 1:1
create table if not exists public._zv_camp_flow (
  campaign_id uuid primary key references public.zv_campaigns (id) on delete cascade,
  flow_id uuid not null unique
);

insert into public._zv_camp_flow (campaign_id, flow_id)
select id, gen_random_uuid()
from public.zv_campaigns
on conflict (campaign_id) do nothing;

insert into public.zv_flows (id, user_id, name, description)
select
  m.flow_id,
  c.user_id,
  c.name || ' (fluxo migrado)',
  c.description
from public._zv_camp_flow m
join public.zv_campaigns c on c.id = m.campaign_id;

-- vincular etapas ao fluxo
alter table public.zv_funnels
  add column if not exists flow_id uuid;

update public.zv_funnels f
set flow_id = m.flow_id
from public._zv_camp_flow m
where f.campaign_id = m.campaign_id;

update public.zv_campaigns c
set
  isca_message = coalesce(
    (select f.message from public.zv_funnels f
     where f.campaign_id = c.id and f.step_order = 1
     limit 1),
    ''
  ),
  flow_id = m.flow_id
from public._zv_camp_flow m
where c.id = m.campaign_id;

update public.zv_campaigns
set isca_message = ''
where isca_message is null;

-- remove etapa 1 (isca) do funil; etapas seguintes serão 1,2,…
delete from public.zv_funnels f
using public.zv_campaigns c
where f.campaign_id = c.id
  and f.step_order = 1;

-- renumera
update public.zv_funnels f
set step_order = x.new_order
from (
  select
    id,
    row_number() over (partition by flow_id order by step_order) as new_order
  from public.zv_funnels
) x
where f.id = x.id;

delete from public.zv_funnels where flow_id is null;

-- remove campaign_id do funil
alter table public.zv_funnels
  drop constraint if exists zv_funnels_campaign_id_fkey;

drop index if exists public.zv_funnels_campaign_idx;
drop index if exists public.zv_funnels_step_order_per_campaign;
alter table public.zv_funnels
  drop constraint if exists zv_funnels_step_order_per_campaign;

alter table public.zv_funnels
  drop column if exists campaign_id;

alter table public.zv_funnels
  drop constraint if exists zv_funnels_step_order_per_flow;
alter table public.zv_funnels
  add constraint zv_funnels_step_order_per_flow unique (flow_id, step_order);

alter table public.zv_funnels
  alter column flow_id set not null;

alter table public.zv_funnels
  drop constraint if exists zv_funnels_flow_id_fkey;
alter table public.zv_funnels
  add constraint zv_funnels_flow_id_fkey
  foreign key (flow_id) references public.zv_flows (id) on delete cascade;

create index if not exists zv_funnels_flow_idx
  on public.zv_funnels (flow_id, step_order);

drop index if exists public.zv_funnels_delay_range_idx;
create index if not exists zv_funnels_delay_range_idx
  on public.zv_funnels (flow_id, step_order, min_delay_seconds, max_delay_seconds);

-- campanha: flow e isca
alter table public.zv_campaigns
  drop constraint if exists zv_campaigns_flow_id_fkey;
alter table public.zv_campaigns
  add constraint zv_campaigns_flow_id_fkey
  foreign key (flow_id) references public.zv_flows (id) on delete restrict;

alter table public.zv_campaigns
  alter column isca_message set not null;
alter table public.zv_campaigns
  alter column isca_message set default '';

alter table public.zv_campaigns
  alter column flow_id set not null;

alter table public.zv_campaigns
  drop column if exists inbound_triggers;

-- auxiliar
drop table if exists public._zv_camp_flow;

-- RLS zv_funnels
drop policy if exists zv_funnels_select_own on public.zv_funnels;
drop policy if exists zv_funnels_insert_own on public.zv_funnels;
drop policy if exists zv_funnels_update_own on public.zv_funnels;
drop policy if exists zv_funnels_delete_own on public.zv_funnels;

create policy zv_funnels_select_own
  on public.zv_funnels for select
  to authenticated
  using (
    exists (
      select 1 from public.zv_flows fl
      where fl.id = zv_funnels.flow_id and fl.user_id = auth.uid()
    )
  );

create policy zv_funnels_insert_own
  on public.zv_funnels for insert
  to authenticated
  with check (
    exists (
      select 1 from public.zv_flows fl
      where fl.id = zv_funnels.flow_id and fl.user_id = auth.uid()
    )
  );

create policy zv_funnels_update_own
  on public.zv_funnels for update
  to authenticated
  using (
    exists (
      select 1 from public.zv_flows fl
      where fl.id = zv_funnels.flow_id and fl.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.zv_flows fl
      where fl.id = zv_funnels.flow_id and fl.user_id = auth.uid()
    )
  );

create policy zv_funnels_delete_own
  on public.zv_funnels for delete
  to authenticated
  using (
    exists (
      select 1 from public.zv_flows fl
      where fl.id = zv_funnels.flow_id and fl.user_id = auth.uid()
    )
  );

comment on table public.zv_flows is
  'Automação reutilizável: etapas em zv_funnels ligadas por flow_id.';
comment on column public.zv_campaigns.isca_message is
  'Isca: primeira mensagem ativa; o fluxo (zv_flows) segue após o gatilho.';
comment on column public.zv_campaigns.trigger_condition is
  'Regra de comparação entre a mensagem do lead e trigger_keyword.';
