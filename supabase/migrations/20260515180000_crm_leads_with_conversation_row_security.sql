-- =============================================================================
-- CRM: corrigir RPCs que leem `leads` / `chat_messages` sob SECURITY DEFINER
--
-- Causa: funções SECURITY DEFINER rodam como dono (ex.: postgres). As policies
-- dessas tabelas são em geral `TO authenticated` — o papel do definer não casa
-- com a policy → RLS nega todas as linhas → EXISTS / JOIN em chat_messages
-- falham → Kanban vazio, busca global sem hits, sininho zerado.
--
-- Correção: `SET row_security = off` nessas RPCs. Isolamento continua garantido
-- por `l.user_id = p_user_id` e (auth.uid() = p_user_id OU superadmin).
-- =============================================================================

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
set row_security = off
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
      or exists (
        select 1
        from public.user_profiles up
        where up.user_id = auth.uid()
          and up.role = 'superadmin'
      )
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
  'Lista leads do Kanban; RLS off só nesta query (EXISTS em chat_messages). Tenant: auth.uid() = p_user_id ou superadmin.';

-- ---------------------------------------------------------------------------
-- Mesma correção: busca global e contagem do sininho
-- ---------------------------------------------------------------------------
drop function if exists public.crm_global_search(uuid, text, integer);

create or replace function public.crm_global_search(
  p_user_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  result_type text,
  lead_id uuid,
  lead_name text,
  phone text,
  snippet text,
  message_id uuid,
  msg_created_at timestamptz
)
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  with q as (
    select trim(p_query) as t
  ),
  lim as (
    select greatest(1, least(coalesce(p_limit, 20), 50)) as n
  ),
  leads_hit as (
    select
      'lead'::text as result_type,
      l.id as lead_id,
      l.name::text as lead_name,
      coalesce(l.phone, '')::text as phone,
      null::text as snippet,
      null::uuid as message_id,
      null::timestamptz as msg_created_at
    from public.leads l, q, lim
    where l.user_id = p_user_id
      and (
        auth.uid() = p_user_id
        or exists (
          select 1
          from public.user_profiles up
          where up.user_id = auth.uid()
            and up.role = 'superadmin'
        )
      )
      and length(q.t) >= 2
      and (
        l.name ilike '%' || q.t || '%'
        or coalesce(l.phone, '') ilike '%' || q.t || '%'
      )
    order by l.updated_at desc nulls last
    limit (select n from lim)
  ),
  msg_hit as (
    select
      'message'::text as result_type,
      l.id as lead_id,
      l.name::text as lead_name,
      coalesce(l.phone, '')::text as phone,
      left(coalesce(cm.message_body, ''), 200)::text as snippet,
      cm.id as message_id,
      cm.created_at as msg_created_at
    from public.chat_messages cm
    join public.leads l on l.id = cm.lead_id and l.user_id = p_user_id
    cross join q
    cross join lim
    where (
      auth.uid() = p_user_id
      or exists (
        select 1
        from public.user_profiles up
        where up.user_id = auth.uid()
          and up.role = 'superadmin'
      )
    )
      and length(q.t) >= 2
      and coalesce(cm.message_body, '') ilike '%' || q.t || '%'
    order by cm.created_at desc
    limit (select n from lim)
  )
  select * from leads_hit
  union all
  select * from msg_hit
  order by result_type, msg_created_at desc nulls last
  limit (select n from lim);
$$;

revoke all on function public.crm_global_search(uuid, text, integer) from public;
grant execute on function public.crm_global_search(uuid, text, integer) to authenticated;

comment on function public.crm_global_search(uuid, text, integer) is
  'Busca leads e mensagens; RLS off nesta query. Tenant ou superadmin.';

drop function if exists public.crm_recent_client_threads_count(uuid);

create or replace function public.crm_recent_client_threads_count(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select count(*)::integer
  from (
    select distinct cm.lead_id
    from public.chat_messages cm
    join public.leads l on l.id = cm.lead_id and l.user_id = p_user_id
    where (
      auth.uid() = p_user_id
      or exists (
        select 1
        from public.user_profiles up
        where up.user_id = auth.uid()
          and up.role = 'superadmin'
      )
    )
      and cm.sender_type = 'cliente'
      and cm.created_at > (now() - interval '72 hours')
  ) s;
$$;

revoke all on function public.crm_recent_client_threads_count(uuid) from public;
grant execute on function public.crm_recent_client_threads_count(uuid) to authenticated;

comment on function public.crm_recent_client_threads_count(uuid) is
  'Conta leads com msg cliente 72h; RLS off nesta query. Tenant ou superadmin.';
