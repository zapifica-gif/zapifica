-- ============================================================================
-- Zap Voice — permitir excluir fluxos mesmo com campanhas concluídas
-- Estratégia:
-- - zv_campaigns.flow_id passa a aceitar NULL
-- - FK para zv_flows vira ON DELETE SET NULL
-- Assim, campanhas antigas (histórico) continuam existindo e aparecem como "Fluxo excluído".
-- ============================================================================

alter table public.zv_campaigns
  drop constraint if exists zv_campaigns_flow_id_fkey;

alter table public.zv_campaigns
  alter column flow_id drop not null;

alter table public.zv_campaigns
  add constraint zv_campaigns_flow_id_fkey
  foreign key (flow_id) references public.zv_flows (id) on delete set null;

