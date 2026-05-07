-- ============================================================================
-- lead_campaign_progress.created_at — alinhamento com triggers e drift de schema
--
-- Em alguns bancos a coluna `created_at` ficou ausente (schema antigo / drift).
-- Esta migration garante a coluna + backfill, no MESMO padrão da migration
-- 20260507120000_lead_campaign_progress_updated_at.sql.
--
-- Sem essa coluna, qualquer SELECT em `lead_campaign_progress` que faça ORDER BY
-- created_at (ex.: webhook do Zap Voice) quebrava com:
--   "column lead_campaign_progress.created_at does not exist"
-- ============================================================================

alter table public.lead_campaign_progress
  add column if not exists created_at timestamptz;

update public.lead_campaign_progress
set created_at = coalesce(created_at, updated_at, now())
where created_at is null;

alter table public.lead_campaign_progress
  alter column created_at set default now();

alter table public.lead_campaign_progress
  alter column created_at set not null;

comment on column public.lead_campaign_progress.created_at is
  'Timestamp da criação do progresso; usado por consultas que ordenam por recência (ex.: resolução de leads duplicados).';

create index if not exists lead_campaign_progress_created_at_idx
  on public.lead_campaign_progress (created_at);
