-- Zap Voice: exclusão de fluxo/campanha sem erro de FK.
-- Reaplica FKs com ON DELETE CASCADE onde o painel precisa “limpar tudo” ao apagar o pai.

-- ---------------------------------------------------------------------------
-- 1) Etapas do fluxo: ao apagar zv_flows, remove linhas em zv_funnels
-- ---------------------------------------------------------------------------
alter table public.zv_funnels
  drop constraint if exists zv_funnels_flow_id_fkey;

alter table public.zv_funnels
  add constraint zv_funnels_flow_id_fkey
  foreign key (flow_id) references public.zv_flows (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2) Campanhas: ao apagar zv_flows, remove campanhas que usavam esse fluxo
--    (histórico + filas ligadas caem em cascata via zv_campaigns → filhos)
-- ---------------------------------------------------------------------------
alter table public.zv_campaigns
  drop constraint if exists zv_campaigns_flow_id_fkey;

alter table public.zv_campaigns
  add constraint zv_campaigns_flow_id_fkey
  foreign key (flow_id) references public.zv_flows (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 3) Fila agendada: ao apagar etapa (zv_funnels), remove linhas dessa etapa
--    (antes podia ser SET NULL e deixar lixo na fila)
-- ---------------------------------------------------------------------------
alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_zv_funnel_step_id_fkey;

alter table public.scheduled_messages
  add constraint scheduled_messages_zv_funnel_step_id_fkey
  foreign key (zv_funnel_step_id) references public.zv_funnels (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 4) Fila agendada: ao apagar campanha, remove agendamentos Zap Voice dela
-- ---------------------------------------------------------------------------
alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_zv_campaign_id_fkey;

alter table public.scheduled_messages
  add constraint scheduled_messages_zv_campaign_id_fkey
  foreign key (zv_campaign_id) references public.zv_campaigns (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 5) Progresso / conclusões no lead (já costumam ser cascade; idempotente)
-- ---------------------------------------------------------------------------
alter table public.lead_campaign_progress
  drop constraint if exists lead_campaign_progress_campaign_id_fkey;

alter table public.lead_campaign_progress
  add constraint lead_campaign_progress_campaign_id_fkey
  foreign key (campaign_id) references public.zv_campaigns (id) on delete cascade;

alter table public.lead_campaign_completions
  drop constraint if exists lead_campaign_completions_campaign_id_fkey;

alter table public.lead_campaign_completions
  add constraint lead_campaign_completions_campaign_id_fkey
  foreign key (campaign_id) references public.zv_campaigns (id) on delete cascade;

comment on constraint zv_funnels_flow_id_fkey on public.zv_funnels is
  'Apagar fluxo remove etapas (CASCADE).';
comment on constraint zv_campaigns_flow_id_fkey on public.zv_campaigns is
  'Apagar fluxo remove campanhas que referenciam o fluxo (CASCADE).';
