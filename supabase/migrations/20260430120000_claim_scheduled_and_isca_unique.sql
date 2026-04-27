-- 1) Uma isca **pending** por lead+campanha — evita várias linhas na fila antes do disparo.
--    (Não inclui `processing`: linha presa em processing após falha não bloqueia nova ativação.)
--    Se a criação do índice falhar por duplicatas existentes, apague duplicatas pending antes.
create unique index if not exists scheduled_messages_one_pending_isca_per_lead_campaign
  on public.scheduled_messages (user_id, lead_id, zv_campaign_id)
  where zv_funnel_step_id is null
    and lead_id is not null
    and zv_campaign_id is not null
    and status = 'pending';

comment on index public.scheduled_messages_one_pending_isca_per_lead_campaign is
  'No máximo uma isca (zv_funnel_step_id nulo) pending por lead e campanha.';

-- 2) Reserva atômica de linhas para workers concorrentes (FOR UPDATE SKIP LOCKED).
create or replace function public.claim_scheduled_messages(p_limit integer default 30)
returns setof public.scheduled_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select sm.id
    from public.scheduled_messages sm
    where sm.status = 'pending'
      and sm.is_active = true
      and sm.scheduled_at is not null
      and sm.scheduled_at <= timezone('utc', now())
    order by sm.scheduled_at asc
    limit greatest(1, least(p_limit, 500))
    for update skip locked
  )
  update public.scheduled_messages sm
  set
    status = 'processing',
    updated_at = timezone('utc', now())
  from picked
  where sm.id = picked.id
  returning sm.*;
end;
$$;

comment on function public.claim_scheduled_messages(integer) is
  'Marca pending→processing em lote com bloqueio de linha; evita dois workers pegarem a mesma mensagem.';

revoke all on function public.claim_scheduled_messages(integer) from public;
grant execute on function public.claim_scheduled_messages(integer) to service_role;
