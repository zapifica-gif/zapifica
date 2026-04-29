-- Cópia de zv_funnels.step_order no agendamento: o encadeamento no worker pode
-- usar apenas flow_id + número, sem depender exclusivamente do JOIN por UUID
-- em zv_funnels (evita silêncio se houver inconsistência marginal).

alter table public.scheduled_messages
  add column if not exists zv_funnel_step_order integer;

comment on column public.scheduled_messages.zv_funnel_step_order is
  'Espelho de zv_funnels.step_order no momento do agendamento; usado pelo worker para disparar Etapa N+1.';

create index if not exists scheduled_messages_zv_campaign_funnel_ord_idx
  on public.scheduled_messages (zv_campaign_id, zv_funnel_step_order)
  where zv_campaign_id is not null and zv_funnel_step_order is not null;
