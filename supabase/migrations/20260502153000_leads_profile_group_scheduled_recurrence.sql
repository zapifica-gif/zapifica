DROP FUNCTION IF EXISTS public.crm_leads_with_conversation(uuid);

-- CRM: foto de perfil, grupos WhatsApp (@g.us), última interação para Kanban,
--       recorrência em agendamentos do chat.

alter table public.leads
  add column if not exists profile_picture_url text,
  add column if not exists is_group boolean not null default false,
  add column if not exists last_message_at timestamptz;

comment on column public.leads.profile_picture_url is
  'URL da foto do perfil (Evolution WhatsApp); nulo até busca lazy pelo webhook.';
comment on column public.leads.is_group is
  'True quando o `phone` é JID de grupo (@g.us).';
comment on column public.leads.last_message_at is
  'Última mensagem no histórico (cliente/agência/atualização explícita), para UX no Kanban.';

alter table public.scheduled_messages
  add column if not exists recurrence text not null default 'none';

alter table public.scheduled_messages
  drop constraint if exists scheduled_messages_recurrence_check;

alter table public.scheduled_messages
  add constraint scheduled_messages_recurrence_check
  check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly'));

comment on column public.scheduled_messages.recurrence is
  'Recorrência após disparo bem-sucedido (chat CRM): none, daily, weekly, monthly, yearly. Zap Voice mantém none.';

-- Kanban RPC: dados extras para avatar, grupo e “termômetro” de tempo.
create or replace function public.crm_leads_with_conversation(p_user_id uuid)
returns table (
  id uuid,
  name text,
  phone text,
  status text,
  profile_picture_url text,
  is_group boolean,
  last_message_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.name,
    l.phone,
    l.status,
    l.profile_picture_url,
    coalesce(l.is_group, false) as is_group,
    l.last_message_at,
    l.updated_at
  from public.leads l
  where l.user_id = p_user_id
    and (
      auth.uid() = p_user_id
      or public.is_superadmin(auth.uid())
    )
    and (
      exists (
        select 1
        from public.chat_messages cm
        where cm.lead_id = l.id
      )
      or coalesce(l.crm_show_without_chat, false) = true
    )
  order by l.created_at asc;
$$;

revoke all on function public.crm_leads_with_conversation(uuid) from public;
grant execute on function public.crm_leads_with_conversation(uuid) to authenticated;

comment on function public.crm_leads_with_conversation(uuid) is
  'Lista leads do Kanban com conversa ou flag crm_show_without_chat; inclui avatar, grupo e timestamps de atividade.';
