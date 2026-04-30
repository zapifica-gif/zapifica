-- ============================================================================
-- Human handoff: quando o dono do WhatsApp responde (fromMe), a IA fica
-- pausada por 60 minutos (cronômetro em banco: ai_paused_until).
-- ============================================================================

alter table public.leads
  add column if not exists ai_paused_until timestamptz;

comment on column public.leads.ai_paused_until is
  'Se maior que now(), a inbox-ai-reply não deve gerar resposta (atendimento humano). Atualizado pelo webhook Evolution em mensagens fromMe.';

-- Chamada pelo Edge Function (service_role): usa now() do Postgres + intervalo fixo.
create or replace function public.set_lead_ai_paused_60_min(p_lead_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.leads
  set ai_paused_until = now() + interval '60 minutes'
  where id = p_lead_id
    and user_id = p_user_id;
$$;

revoke all on function public.set_lead_ai_paused_60_min(uuid, uuid) from public;
grant execute on function public.set_lead_ai_paused_60_min(uuid, uuid) to service_role;

comment on function public.set_lead_ai_paused_60_min(uuid, uuid) is
  'Define ai_paused_until = now() + 60 min para o lead do tenant (mensagem humana / fromMe).';

-- Kanban RPC: expor pausa da IA no cartão.
drop function if exists public.crm_leads_with_conversation(uuid);

create or replace function public.crm_leads_with_conversation(p_user_id uuid)
returns table (
  id uuid,
  name text,
  phone text,
  status text,
  profile_picture_url text,
  is_group boolean,
  last_message_at timestamptz,
  updated_at timestamptz,
  ai_paused_until timestamptz
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
    l.updated_at,
    l.ai_paused_until
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

revoke all on function public.crm_leads_with_conversation(uuid) from public;
grant execute on function public.crm_leads_with_conversation(uuid) to authenticated;

comment on function public.crm_leads_with_conversation(uuid) is
  'Lista leads do Kanban; ordena por última mensagem (mais recente primeiro), ai_paused_until para indicador de IA pausada.';
