-- ============================================================================
-- lead_campaign_progress.updated_at — alinhamento com triggers e ordenação Zap Voice
--
-- Alguns projetos ficaram sem a coluna (schema antigo ou drift).
-- Esta migration garante updated_at + backfill + trigger igual ao fluxo inicial.
-- ============================================================================

alter table public.lead_campaign_progress
  add column if not exists updated_at timestamptz;

update public.lead_campaign_progress
set updated_at = coalesce(updated_at, created_at, now())
where updated_at is null;

alter table public.lead_campaign_progress
  alter column updated_at set default now();

alter table public.lead_campaign_progress
  alter column updated_at set not null;

comment on column public.lead_campaign_progress.updated_at is
  'Atualizado em cada UPDATE nesta linha (trigger tg_touch_updated_at).';

do $$
begin
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
