-- ============================================================================
-- Corrige o erro 42P10 (ON CONFLICT sem constraint correspondente) na tabela
-- public.lead_campaign_progress.
--
-- Causa: o índice atual é PARCIAL (with where status in (...)) e o cliente JS
--        do Supabase passa apenas { onConflict: 'user_id,lead_id,campaign_id' },
--        sem repetir o predicado WHERE — então o Postgres recusa o upsert.
--
-- Correção: troca o índice parcial por uma CONSTRAINT UNIQUE regular sobre
--           (user_id, lead_id, campaign_id). É seguro porque, ao concluir,
--           o registro de progresso é DELETADO e movido para
--           public.lead_campaign_completions, então nunca há mais de uma
--           linha "viva" por (user_id, lead_id, campaign_id).
-- ============================================================================

begin;

-- 1) Sanity: garante que não existem duplicatas (ativas) antes da constraint.
--    Em produção, se houver duplicatas, mantém a mais recente (id maior, supondo uuid v7
--    ou ordem por created_at). Aqui mantemos a de created_at mais recente.
with duplicatas as (
  select id,
         row_number() over (
           partition by user_id, lead_id, campaign_id
           order by created_at desc, id desc
         ) as rn
  from public.lead_campaign_progress
)
delete from public.lead_campaign_progress p
using duplicatas d
where p.id = d.id and d.rn > 1;

-- 2) Remove o índice parcial existente.
drop index if exists public.lead_campaign_progress_active_uidx;

-- 3) Cria a CONSTRAINT UNIQUE definitiva (não-parcial). Nome explícito p/ poder
--    ser referenciada no on_conflict do supabase-js, se necessário.
alter table public.lead_campaign_progress
  drop constraint if exists lead_campaign_progress_uniq_user_lead_campaign;

alter table public.lead_campaign_progress
  add constraint lead_campaign_progress_uniq_user_lead_campaign
  unique (user_id, lead_id, campaign_id);

comment on constraint lead_campaign_progress_uniq_user_lead_campaign
  on public.lead_campaign_progress is
  'Garante 1 progresso por (user_id, lead_id, campaign_id) — exigido pelo upsert do ZapVoice.';

commit;
