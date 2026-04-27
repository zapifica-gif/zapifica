-- ============================================================================
-- Zapifica — Pausa inteligente da IA durante funil + Delay aleatório (anti-ban)
--
-- 1) leads.funnel_locked_until:
--    Enquanto `now() < funnel_locked_until`, a IA deve NÃO responder.
--    Usamos timestamp (e não boolean) para evitar travas eternas em caso de falha.
--
-- 2) zv_campaigns.min_delay_seconds / max_delay_seconds:
--    Configuração por campanha (UI) do range de atraso aleatório antes de enviar
--    cada mensagem do funil (process-scheduled-messages / worker).
--
-- 3) scheduled_messages.min_delay_seconds / max_delay_seconds:
--    Snapshot do range no momento do enfileiramento (não depende de join).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Lock do funil por lead (pausa de IA)
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists funnel_locked_until timestamptz;

create index if not exists leads_funnel_locked_until_idx
  on public.leads (funnel_locked_until);

comment on column public.leads.funnel_locked_until is
  'Enquanto now() < funnel_locked_until, a IA não deve responder (funil em execução).';

-- ---------------------------------------------------------------------------
-- 2) Range de delay configurável por campanha
-- ---------------------------------------------------------------------------
alter table public.zv_campaigns
  add column if not exists min_delay_seconds integer not null default 2,
  add column if not exists max_delay_seconds integer not null default 15;

alter table public.zv_campaigns
  drop constraint if exists zv_campaigns_min_max_delay_check;

alter table public.zv_campaigns
  add constraint zv_campaigns_min_max_delay_check
  check (
    min_delay_seconds >= 0
    and max_delay_seconds >= 0
    and max_delay_seconds >= min_delay_seconds
    and max_delay_seconds <= 3600
  );

comment on column public.zv_campaigns.min_delay_seconds is
  'Delay mínimo (segundos) sorteado antes de cada envio de mensagem desta campanha.';
comment on column public.zv_campaigns.max_delay_seconds is
  'Delay máximo (segundos) sorteado antes de cada envio de mensagem desta campanha.';

-- ---------------------------------------------------------------------------
-- 3) Snapshot do range na fila (scheduled_messages)
-- ---------------------------------------------------------------------------
alter table public.scheduled_messages
  add column if not exists min_delay_seconds integer,
  add column if not exists max_delay_seconds integer;

alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_min_max_delay_check;

alter table public.scheduled_messages
  add constraint scheduled_messages_min_max_delay_check
  check (
    (min_delay_seconds is null and max_delay_seconds is null)
    or (
      min_delay_seconds is not null
      and max_delay_seconds is not null
      and min_delay_seconds >= 0
      and max_delay_seconds >= min_delay_seconds
      and max_delay_seconds <= 3600
    )
  );

create index if not exists scheduled_messages_delay_range_idx
  on public.scheduled_messages (min_delay_seconds, max_delay_seconds);

comment on column public.scheduled_messages.min_delay_seconds is
  'Snapshot: delay mínimo (segundos) para este disparo (anti-ban).';
comment on column public.scheduled_messages.max_delay_seconds is
  'Snapshot: delay máximo (segundos) para este disparo (anti-ban).';

