-- CRM / Funil: só leads que já tenham pelo menos uma linha em chat_messages (conversa iniciada).

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
    and exists (
      select 1
      from public.chat_messages cm
      where cm.lead_id = l.id
    )
  order by l.created_at asc;
$$;

revoke all on function public.crm_leads_with_conversation(uuid) from public;
grant execute on function public.crm_leads_with_conversation(uuid) to authenticated;

comment on function public.crm_leads_with_conversation(uuid) is
  'Lista leads do usuário para o Kanban apenas com pelo menos uma mensagem no histórico (conversa vigente).';
