-- =============================================================================
-- HOTFIX CRÍTICO: ingestão de chat_messages quebrada pelo trigger de coerção
--
-- Causa: `trg_chat_messages_coerce_lead_kanban` é SECURITY DEFINER (roda como
-- dono da função, ex. postgres). Ela chama `crm_seed_default_kanban_columns`,
-- que era SECURITY INVOKER → no contexto do definer o INSERT em
-- `crm_kanban_columns` falha nas policies `TO authenticated` → exceção →
-- ROLLBACK de toda a transação → mensagem não grava, IA não roda.
--
-- Correção:
-- 1) `crm_seed_default_kanban_columns`: SECURITY DEFINER + row_security off +
--    checagem explícita de tenant (evita abuso cross-user por JWT).
-- 2) Trigger de chat: `SET search_path` já existe; seed passa a funcionar.
-- =============================================================================

create or replace function public.crm_seed_default_kanban_columns(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  -- JWT ausente (service_role / jobs) ou próprio tenant ou superadmin
  if auth.uid() is not null
     and auth.uid() is distinct from p_user_id
     and not exists (
       select 1
       from public.user_profiles up
       where up.user_id = auth.uid()
         and up.role = 'superadmin'
     ) then
    raise exception 'crm_seed_default_kanban_columns: operação não autorizada para este user_id';
  end if;

  if not exists (select 1 from public.crm_kanban_columns c where c.user_id = p_user_id) then
    insert into public.crm_kanban_columns (user_id, key_slug, title, color_hex, sort_order)
    values
      (p_user_id, 'novo', 'Novo Lead', '#4285f4', 0),
      (p_user_id, 'em_atendimento', 'Em Atendimento', '#6a00b8', 1),
      (p_user_id, 'negociacao', 'Negociação', '#fbbc05', 2),
      (p_user_id, 'fechado', 'Fechado', '#34a853', 3);
  end if;
end;
$$;

revoke all on function public.crm_seed_default_kanban_columns(uuid) from public;
grant execute on function public.crm_seed_default_kanban_columns(uuid) to authenticated;
grant execute on function public.crm_seed_default_kanban_columns(uuid) to service_role;

comment on function public.crm_seed_default_kanban_columns(uuid) is
  'Cria as 4 colunas padrão do Kanban se vazio; SECURITY DEFINER para rodar a partir de triggers (Evolution).';
