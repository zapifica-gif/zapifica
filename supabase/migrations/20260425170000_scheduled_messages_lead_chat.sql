-- ============================================================================
-- Agenda Suprema — agendamento direto a partir do chat do CRM
--
-- Hoje a tabela scheduled_messages está atrelada 1:1 a um evento da agenda
-- (event_id NOT NULL). Para o agendador do ChatWindow, precisamos:
--   * permitir mensagens agendadas SEM evento (event_id agora é opcional);
--   * apontar a mensagem agendada para o lead destinatário (lead_id);
--   * guardar a URL pública do anexo, quando for mídia (media_url);
--   * aceitar 'document' e 'video' como content_type (para anexos do chat).
--
-- A política RLS por user_id segue valendo, mas adicionamos cláusulas extras
-- que permitem ao dono do lead (auth.uid()) ler/inserir/excluir agendamentos
-- vinculados àquele lead — o cron com service_role continua passando direto.
-- ============================================================================

alter table public.scheduled_messages
  add column if not exists lead_id uuid
    references public.leads (id) on delete cascade,
  add column if not exists media_url text;

-- event_id passa a ser opcional (chat agenda sem precisar criar evento)
alter table public.scheduled_messages
  alter column event_id drop not null;

-- aceita os tipos de mídia que o chat já envia hoje
alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_content_type_check;
alter table public.scheduled_messages
  add constraint scheduled_messages_content_type_check
  check (content_type in ('text', 'audio', 'image', 'document', 'video'));

-- 1:1 evento↔agendamento só quando há evento; permite vários NULLs
drop index if exists scheduled_messages_event_id_uidx;
create unique index if not exists scheduled_messages_event_id_uidx
  on public.scheduled_messages (event_id)
  where event_id is not null;

create index if not exists scheduled_messages_lead_id_idx
  on public.scheduled_messages (lead_id);

create index if not exists scheduled_messages_lead_scheduled_at_idx
  on public.scheduled_messages (lead_id, scheduled_at);

comment on column public.scheduled_messages.lead_id is
  'Quando preenchido, indica que o agendamento foi criado a partir do ChatWindow do CRM e o destinatário é o lead.';
comment on column public.scheduled_messages.media_url is
  'URL pública (bucket chat_media) da mídia anexada ao agendamento — usada pelo worker no momento do disparo.';
