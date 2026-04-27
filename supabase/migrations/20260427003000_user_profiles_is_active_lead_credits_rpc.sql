-- ============================================================================
-- Painel Supremo: soft delete + créditos reais do Extrator (lead_credits)
-- ============================================================================

-- 1) Soft delete de tenants
alter table public.user_profiles
  add column if not exists is_active boolean not null default true;

comment on column public.user_profiles.is_active is
  'Soft delete do tenant. Quando false, o cliente fica desativado e não aparece nas listagens.';

create index if not exists user_profiles_is_active_idx
  on public.user_profiles (is_active);

-- 2) RPCs de créditos (freemium) — usadas por Edge Functions (service_role)

create or replace function public.try_deduct_lead_credits(
  p_user_id uuid,
  p_amount integer
)
returns table (ok boolean, new_balance integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new int;
begin
  if p_amount is null or p_amount <= 0 then
    return query select true, coalesce((select lead_credits from public.user_profiles where user_id = p_user_id), 0);
    return;
  end if;

  update public.user_profiles
  set lead_credits = lead_credits - p_amount
  where user_id = p_user_id
    and is_active = true
    and lead_credits >= p_amount
  returning lead_credits into v_new;

  if v_new is null then
    return query
      select false,
             coalesce((select lead_credits from public.user_profiles where user_id = p_user_id), 0);
    return;
  end if;

  return query select true, v_new;
end;
$$;

create or replace function public.refund_lead_credits(
  p_user_id uuid,
  p_amount integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new int;
begin
  if p_amount is null or p_amount <= 0 then
    return coalesce((select lead_credits from public.user_profiles where user_id = p_user_id), 0);
  end if;
  update public.user_profiles
  set lead_credits = lead_credits + p_amount
  where user_id = p_user_id
  returning lead_credits into v_new;
  return coalesce(v_new, 0);
end;
$$;

-- Reembolso parcial idempotente por extraction_id (mesma ideia da refund_partial_credits)
create or replace function public.refund_partial_lead_credits(
  p_user_id uuid,
  p_extraction_id uuid,
  p_amount integer
)
returns table (refunded integer, new_balance integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already int;
  v_balance int;
  v_refunded int;
begin
  if p_amount is null or p_amount <= 0 then
    return query
      select 0::int,
             coalesce((select lead_credits from public.user_profiles where user_id = p_user_id), 0);
    return;
  end if;

  select extracted_count into v_already
  from public.lead_extractions
  where id = p_extraction_id
    and user_id = p_user_id;

  if v_already is not null then
    return query
      select 0::int,
             coalesce((select lead_credits from public.user_profiles where user_id = p_user_id), 0);
    return;
  end if;

  update public.user_profiles
  set lead_credits = lead_credits + p_amount
  where user_id = p_user_id
  returning lead_credits into v_balance;

  v_refunded := p_amount;
  return query select coalesce(v_refunded, 0), coalesce(v_balance, 0);
end;
$$;

revoke all on function public.try_deduct_lead_credits(uuid, integer) from public;
revoke all on function public.refund_lead_credits(uuid, integer) from public;
revoke all on function public.refund_partial_lead_credits(uuid, uuid, integer) from public;
grant execute on function public.try_deduct_lead_credits(uuid, integer) to service_role;
grant execute on function public.refund_lead_credits(uuid, integer) to service_role;
grant execute on function public.refund_partial_lead_credits(uuid, uuid, integer) to service_role;

