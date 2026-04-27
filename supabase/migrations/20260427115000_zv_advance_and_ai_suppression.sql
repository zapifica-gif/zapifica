-- ============================================================================
-- Zapifica — Funis: avanço (auto vs gatilho exato) + barreira anti-loop
--           + sinal atômico de supressão de IA (corrige concorrência)
--
-- Objetivos:
-- 1) chat_messages.ai_suppressed (+ reason):
--    O webhook que insere a mensagem do lead já marca se a IA deve ser abortada,
--    eliminando corrida (inbox-ai-reply dispara em paralelo).
--
-- 2) zv_funnels.advance_type:
--    Para passos seguintes: avançar automaticamente (qualquer resposta) ou por
--    gatilho exato (expected_trigger).
--
-- 3) lead_campaign_progress / lead_campaign_completions:
--    - progress: controla em qual passo o lead está
--    - completions: garante “envio único por campanha” (anti-loop)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Supressão atômica da IA no registro da mensagem
-- ---------------------------------------------------------------------------
alter table public.chat_messages
  add column if not exists ai_suppressed boolean not null default false,
  add column if not exists ai_suppress_reason text;

create index if not exists chat_messages_ai_suppressed_idx
  on public.chat_messages (lead_id, created_at)
  where ai_suppressed = true;

comment on column public.chat_messages.ai_suppressed is
  'Quando true, a IA (inbox-ai-reply / webhook) deve abortar qualquer resposta para esta mensagem.';
comment on column public.chat_messages.ai_suppress_reason is
  'Motivo da supressão (ex.: funnel_trigger, funnel_advance, lead_in_funnel).';

-- ---------------------------------------------------------------------------
-- 2) Tipo de avanço por etapa (passos seguintes)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.zv_step_advance_type as enum ('auto', 'exact');
exception
  when duplicate_object then null;
end $$;

alter table public.zv_funnels
  add column if not exists advance_type public.zv_step_advance_type not null default 'auto';

comment on column public.zv_funnels.advance_type is
  'Como o lead avança para esta etapa: auto = qualquer resposta; exact = precisa bater expected_trigger exatamente.';

-- ---------------------------------------------------------------------------
-- 3) Progresso e conclusões (anti-loop)
-- ---------------------------------------------------------------------------
create table if not exists public.lead_campaign_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid not null references public.zv_campaigns (id) on delete cascade,
  next_step_order integer not null default 1,
  total_steps integer not null,
  status text not null default 'active'
    check (status in ('active', 'awaiting_last_send')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_campaign_progress_next_step_check check (next_step_order >= 1),
  constraint lead_campaign_progress_total_steps_check check (total_steps >= 1)
);

-- 1 progress ativo por lead+campanha
create unique index if not exists lead_campaign_progress_active_uidx
  on public.lead_campaign_progress (user_id, lead_id, campaign_id)
  where status in ('active', 'awaiting_last_send');

create index if not exists lead_campaign_progress_lookup_idx
  on public.lead_campaign_progress (user_id, lead_id, campaign_id, status);

comment on table public.lead_campaign_progress is
  'Progresso do funil por lead/campanha: controla próximo step_order a enfileirar.';

create table if not exists public.lead_campaign_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid not null references public.zv_campaigns (id) on delete cascade,
  completed_at timestamptz not null default now(),
  constraint lead_campaign_completions_uniq unique (user_id, lead_id, campaign_id)
);

create index if not exists lead_campaign_completions_lookup_idx
  on public.lead_campaign_completions (user_id, lead_id, campaign_id, completed_at desc);

comment on table public.lead_campaign_completions is
  'Barreira anti-loop: registra campanhas já concluídas por lead; impede re-execução do mesmo funil.';

-- updated_at automático (reaproveita função do projeto se existir; cria uma simples se não)
do $$ begin
  perform 1
  from pg_proc
  where proname = 'tg_touch_updated_at'
    and pg_function_is_visible(oid);
  if not found then
    create or replace function public.tg_touch_updated_at()
    returns trigger
    language plpgsql
    as $fn$
    begin
      new.updated_at := now();
      return new;
    end;
    $fn$;
  end if;
end $$;

drop trigger if exists lead_campaign_progress_touch_updated_at on public.lead_campaign_progress;
create trigger lead_campaign_progress_touch_updated_at
  before update on public.lead_campaign_progress
  for each row execute function public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.lead_campaign_progress enable row level security;
alter table public.lead_campaign_completions enable row level security;

drop policy if exists lead_campaign_progress_select_own on public.lead_campaign_progress;
create policy lead_campaign_progress_select_own
  on public.lead_campaign_progress for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists lead_campaign_progress_insert_own on public.lead_campaign_progress;
create policy lead_campaign_progress_insert_own
  on public.lead_campaign_progress for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists lead_campaign_progress_update_own on public.lead_campaign_progress;
create policy lead_campaign_progress_update_own
  on public.lead_campaign_progress for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists lead_campaign_progress_delete_own on public.lead_campaign_progress;
create policy lead_campaign_progress_delete_own
  on public.lead_campaign_progress for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists lead_campaign_completions_select_own on public.lead_campaign_completions;
create policy lead_campaign_completions_select_own
  on public.lead_campaign_completions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists lead_campaign_completions_insert_own on public.lead_campaign_completions;
create policy lead_campaign_completions_insert_own
  on public.lead_campaign_completions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists lead_campaign_completions_delete_own on public.lead_campaign_completions;
create policy lead_campaign_completions_delete_own
  on public.lead_campaign_completions for delete
  to authenticated
  using (auth.uid() = user_id);

