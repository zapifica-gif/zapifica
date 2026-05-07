-- ============================================================================
-- Pausa da IA durante disparos Zap Voice por LEAD (não global).
--
-- Substitui o uso de `funnel_locked_until` + janelas fixas de horas pela flag
-- booleana abaixo, liberando a IA assim que não houver pendências de campanha
-- nem progresso ativo para aquele contato (ver Edge/worker/webhook).
-- ============================================================================

alter table public.leads
  add column if not exists ai_paused_for_zv_dispatch boolean not null default false;

comment on column public.leads.ai_paused_for_zv_dispatch is
  'Quando true, a inbox e o webhook não geram IA automática porque o Zap Voice está (ou vai estar) disparando mensagens para este lead. Volta para false assim que não restam disparos Zap Voice pendentes nem progresso em lead_campaign_progress.';

create index if not exists leads_ai_paused_zv_dispatch_idx
  on public.leads (user_id)
  where ai_paused_for_zv_dispatch = true;
