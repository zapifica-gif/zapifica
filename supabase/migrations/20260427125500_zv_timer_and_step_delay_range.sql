-- ============================================================================
-- Zapifica — ZapVoice: 3º tipo de avanço (timer) + min/max por etapa
-- ============================================================================

-- 1) Enum: adiciona 'timer'
do $$ begin
  alter type public.zv_step_advance_type add value if not exists 'timer';
exception
  when duplicate_object then null;
  when others then
    -- Se o Postgres não suportar IF NOT EXISTS (muito raro no Supabase atual),
    -- simplesmente ignore.
    null;
end $$;

-- 2) Min/Max por etapa (usado quando advance_type='timer')
alter table public.zv_funnels
  add column if not exists min_delay_seconds integer,
  add column if not exists max_delay_seconds integer;

alter table public.zv_funnels
  drop constraint if exists zv_funnels_min_max_delay_check;

alter table public.zv_funnels
  add constraint zv_funnels_min_max_delay_check
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

create index if not exists zv_funnels_delay_range_idx
  on public.zv_funnels (campaign_id, step_order, min_delay_seconds, max_delay_seconds);

comment on column public.zv_funnels.min_delay_seconds is
  'Delay mínimo (segundos) desta etapa quando advance_type=timer.';
comment on column public.zv_funnels.max_delay_seconds is
  'Delay máximo (segundos) desta etapa quando advance_type=timer.';

