-- ============================================================================
-- Zap Voice — Simplifica os fluxos: ÚNICO modo de avanço suportado é o timer.
--
-- Motivação:
-- O usuário precisa que, assim que o gatilho da campanha bater, o fluxo siga
-- até o fim de forma automática (delay aleatório por etapa) e só depois a IA
-- volte a responder. Os modos `auto` e `exact` confundiam o usuário e o
-- sistema (a etapa N parava se estivesse marcada como `auto`).
--
-- O que esta migração faz:
-- 1) Força `advance_type = 'timer'` em todas as etapas existentes.
-- 2) Garante que toda etapa tenha min/max delay (defaults 2s e 15s).
-- 3) Muda o default da coluna `advance_type` para 'timer' em novas etapas.
-- 4) Limpa `expected_trigger` (não é mais usado a partir da etapa 2 — o
--    gatilho só vale na palavra-chave da campanha).
-- ============================================================================

begin;

-- 1) Todas as etapas viram timer
update public.zv_funnels
set advance_type = 'timer'
where advance_type is distinct from 'timer';

-- 2) Popula min/max em quem está nulo, com defaults razoáveis
update public.zv_funnels
set
  min_delay_seconds = coalesce(min_delay_seconds, 2),
  max_delay_seconds = coalesce(
    max_delay_seconds,
    greatest(coalesce(min_delay_seconds, 2), 15)
  )
where min_delay_seconds is null
   or max_delay_seconds is null;

-- 3) Default para novas etapas
alter table public.zv_funnels
  alter column advance_type set default 'timer';

-- 4) `expected_trigger` deixa de ser usado pelo fluxo (apenas a campanha tem
--    palavra-chave). Limpamos para evitar confusão visual no painel.
update public.zv_funnels
set expected_trigger = null
where expected_trigger is not null;

comment on column public.zv_funnels.advance_type is
  'Sempre `timer`: o fluxo avança automaticamente após o gatilho da campanha, com delay aleatório (min/max) por etapa.';

commit;
