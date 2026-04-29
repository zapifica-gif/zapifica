-- Leads criados direto no Kanban precisam aparecer antes da primeira mensagem no histórico.

alter table public.leads
  add column if not exists crm_show_without_chat boolean not null default false;

comment on column public.leads.crm_show_without_chat is
  'True quando o lead foi criado pelo CRM (funil); exibido no Kanban até existir conversa em chat_messages.';

create or replace function public.crm_leads_with_conversation(p_user_id uuid)
returns table (
  id uuid,
  name text,
  phone text,
  status text
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, l.phone, l.status
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
