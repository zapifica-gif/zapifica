-- Kanban: leads com atividade mais recente aparecem primeiro na RPC (bump-up).

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
  order by
    l.last_message_at desc nulls last,
    l.updated_at desc;
$$;

comment on function public.crm_leads_with_conversation(uuid) is
  'Lista leads do Kanban; ordena por última mensagem (mais recente primeiro), depois updated_at.';
