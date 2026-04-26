-- ============================================================================
-- Fila: vínculo com campanhas Zap Voice (enfileiramento em massa)
-- ============================================================================

alter table public.scheduled_messages
  add column if not exists zv_campaign_id uuid;

alter table public.scheduled_messages
  add column if not exists zv_funnel_step_id uuid;

alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_zv_campaign_id_fkey;

alter table public.scheduled_messages
  add constraint scheduled_messages_zv_campaign_id_fkey
  foreign key (zv_campaign_id) references public.zv_campaigns (id) on delete cascade;

alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_zv_funnel_step_id_fkey;

alter table public.scheduled_messages
  add constraint scheduled_messages_zv_funnel_step_id_fkey
  foreign key (zv_funnel_step_id) references public.zv_funnels (id) on delete set null;

create index if not exists scheduled_messages_zv_campaign_user_status_idx
  on public.scheduled_messages (user_id, zv_campaign_id, status)
  where zv_campaign_id is not null;

comment on column public.scheduled_messages.zv_campaign_id is
  'Campanha Zap Voice que gerou o agendamento; exclusão da campanha apaga a fila ligada (CASCADE).';
comment on column public.scheduled_messages.zv_funnel_step_id is
  'Etapa do funil (zv_funnels) de origem.';
