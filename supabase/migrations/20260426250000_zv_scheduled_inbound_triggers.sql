-- Início agendado do funil + gatilhos (respostas rápidas / Meta Ads)
alter table public.zv_campaigns
  add column if not exists scheduled_start_at timestamptz;

alter table public.zv_campaigns
  add column if not exists inbound_triggers text[];

comment on column public.zv_campaigns.scheduled_start_at is
  'Quando preenchida no futuro, os scheduled_at do disparo somam a partir deste instante; vazio/retroativo = usar agora na ativação.';

comment on column public.zv_campaigns.inbound_triggers is
  'Frases exatas (ex.: respostas rápidas do Meta) que devem inscrever o lead neste funil.';

create index if not exists zv_campaigns_scheduled_start_idx
  on public.zv_campaigns (user_id, scheduled_start_at)
  where scheduled_start_at is not null;
