-- ============================================================================
-- Extrator de Leads: créditos no perfil, histórico e RLS
-- ============================================================================

-- 1) Saldo de extrações (apenas a service_role altera; trigger abaixo)
alter table public.profiles
  add column if not exists extraction_credits integer not null default 0
    check (extraction_credits >= 0);

-- Impede que o cliente mude o saldo via API autenticada; Edge com service_role pode.
create or replace function public.tg_profiles_lock_extraction_credits()
returns trigger
language plpgsql
as $$
begin
  -- Só o app (papel authenticated) fica preso: Edge / RPC com service_role altera o saldo.
  if new.extraction_credits is distinct from old.extraction_credits
     and (auth.jwt() ->> 'role') in ('authenticated', 'anon') then
    new.extraction_credits := old.extraction_credits;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_lock_extraction_credits on public.profiles;
create trigger profiles_lock_extraction_credits
  before update on public.profiles
  for each row execute function public.tg_profiles_lock_extraction_credits();

-- 2) Enums
do $$ begin
  create type public.lead_extraction_source as enum ('google_maps', 'instagram');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.lead_extraction_status as enum ('pending', 'processing', 'completed', 'failed');
exception
  when duplicate_object then null;
end $$;

-- 3) Tabela de histórico
create table if not exists public.lead_extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source public.lead_extraction_source not null,
  search_term text not null,
  location text not null,
  requested_amount integer not null
    check (requested_amount > 0 and requested_amount <= 200),
  status public.lead_extraction_status not null default 'pending',
  result_url text,
  created_at timestamptz not null default now()
);

create index if not exists lead_extractions_user_created_idx
  on public.lead_extractions (user_id, created_at desc);

alter table public.lead_extractions enable row level security;

drop policy if exists "lead_extractions_select_own" on public.lead_extractions;
create policy "lead_extractions_select_own"
  on public.lead_extractions for select
  to authenticated
  using (auth.uid() = user_id);

-- Inserção/atualização: o cliente autenticado NÃO recebe policy de insert; a Edge usa
-- service_role e ignora RLS. Webhooks futuros idem.

-- 4) Dedução atômica (somente service_role; chamada a partir da Edge Function)
create or replace function public.try_deduct_extraction_credits(
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
  if p_amount < 1 or p_amount > 200 then
    return query select false, coalesce(
      (select p.extraction_credits from public.profiles p where p.id = p_user_id), 0
    )::int;
    return;
  end if;

  update public.profiles
  set extraction_credits = extraction_credits - p_amount
  where id = p_user_id
    and extraction_credits >= p_amount
  returning extraction_credits into v_new;

  if v_new is null then
    return query
    select
      false,
      coalesce((select p2.extraction_credits from public.profiles p2 where p2.id = p_user_id), 0);
    return;
  end if;

  return query select true, v_new;
end;
$$;

create or replace function public.refund_extraction_credits(
  p_user_id uuid,
  p_amount integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount < 1 then
    return;
  end if;
  update public.profiles
  set extraction_credits = extraction_credits + p_amount
  where id = p_user_id;
end;
$$;

revoke all on function public.try_deduct_extraction_credits(uuid, integer) from public;
revoke all on function public.refund_extraction_credits(uuid, integer) from public;
grant execute on function public.try_deduct_extraction_credits(uuid, integer) to service_role;
grant execute on function public.refund_extraction_credits(uuid, integer) to service_role;
