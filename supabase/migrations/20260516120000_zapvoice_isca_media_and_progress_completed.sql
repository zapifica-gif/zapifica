-- ============================================================================
-- Zap Voice:
-- 1) Mídia por isca (paralelo a isca_messages, índices 0..4).
-- 2) lead_campaign_progress.status = 'completed' (fim do funil sem apagar linha;
--    libera IA imediatamente pois contagens ignoram 'completed').
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Campanha: tipo + URL de mídia por variação de isca
-- ---------------------------------------------------------------------------
alter table public.zv_campaigns
  add column if not exists isca_media_types text[] not null default '{}';

alter table public.zv_campaigns
  add column if not exists isca_media_urls text[] not null default '{}';

comment on column public.zv_campaigns.isca_media_types is
  'Alinhado a isca_messages[i]: text | image | video | audio | document. Padrão text.';

comment on column public.zv_campaigns.isca_media_urls is
  'URL pública da mídia da isca i; vazio = só texto (caption em isca_messages).';

-- ---------------------------------------------------------------------------
-- 2) Progresso: permitir marcar funil concluído (não bloqueia IA)
-- ---------------------------------------------------------------------------
alter table public.lead_campaign_progress
  drop constraint if exists lead_campaign_progress_status_check;

alter table public.lead_campaign_progress
  add constraint lead_campaign_progress_status_check
  check (status in ('active', 'awaiting_last_send', 'completed'));

comment on column public.lead_campaign_progress.status is
  'active = em andamento; awaiting_last_send = última etapa na fila; completed = funil encerrado para o lead (IA liberada).';
