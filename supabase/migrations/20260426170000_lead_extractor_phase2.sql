-- ============================================================================
-- Extrator de Leads — Fase 2: contagem real + reembolso parcial + realtime + tag
-- ============================================================================

-- 1) auditoria da extração: quantos itens vieram, mensagem de erro humana
alter table public.lead_extractions
  add column if not exists extracted_count integer;
alter table public.lead_extractions
  add column if not exists error_message text;

-- 2) Realtime: a tela de extrações precisa ouvir UPDATE/INSERT por user_id
do $$ begin
  alter publication supabase_realtime add table public.lead_extractions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- 3) Marcação de origem nos leads (tag/localizador para Zap Voice)
alter table public.leads
  add column if not exists source text,
  add column if not exists tag text,
  add column if not exists extraction_id uuid
    references public.lead_extractions (id) on delete set null;

create index if not exists leads_user_extraction_idx
  on public.leads (user_id, extraction_id);

-- 4) Reembolso parcial — uma única RPC, idempotente por extraction_id
create or replace function public.refund_partial_credits(
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
             coalesce((select extraction_credits from public.profiles where id = p_user_id), 0);
    return;
  end if;

  -- idempotência: se a extração já registrou um extracted_count, não reembolsa de novo
  select extracted_count into v_already
  from public.lead_extractions
  where id = p_extraction_id
    and user_id = p_user_id;

  if v_already is not null then
    return query
      select 0::int,
             coalesce((select extraction_credits from public.profiles where id = p_user_id), 0);
    return;
  end if;

  update public.profiles
  set extraction_credits = extraction_credits + p_amount
  where id = p_user_id
  returning extraction_credits into v_balance;

  v_refunded := p_amount;

  return query select coalesce(v_refunded, 0), coalesce(v_balance, 0);
end;
$$;

revoke all on function public.refund_partial_credits(uuid, uuid, integer) from public;
grant execute on function public.refund_partial_credits(uuid, uuid, integer) to service_role;
