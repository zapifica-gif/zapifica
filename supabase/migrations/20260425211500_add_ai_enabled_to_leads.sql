-- ============================================================================
-- CRM: Handover IA ↔ Humano
-- Adiciona flag `ai_enabled` no lead para controlar se a IA responde.
-- ============================================================================

alter table public.leads
  add column if not exists ai_enabled boolean not null default true;

create index if not exists leads_user_ai_enabled_idx
  on public.leads (user_id, ai_enabled);

comment on column public.leads.ai_enabled is
  'Quando true, mensagens de texto do cliente podem ser respondidas automaticamente pela IA (DeepSeek).';

