-- ============================================================================
-- RLS: zv_funnels — políticas coerentes com flow_id (dono = zv_flows.user_id)
-- Remove políticas legadas (campaign_id) e recria de forma idempotente.
-- ============================================================================

alter table public.zv_funnels enable row level security;

drop policy if exists zv_funnels_select_own on public.zv_funnels;
drop policy if exists zv_funnels_insert_own on public.zv_funnels;
drop policy if exists zv_funnels_update_own on public.zv_funnels;
drop policy if exists zv_funnels_delete_own on public.zv_funnels;

-- SELECT: etapa visível se o fluxo pertence ao usuário autenticado
create policy zv_funnels_select_own
  on public.zv_funnels
  for select
  to authenticated
  using (
    (select fl.user_id from public.zv_flows fl where fl.id = zv_funnels.flow_id) = (select auth.uid())
  );

-- INSERT: o flow_id da nova linha deve ser de um fluxo do usuário
create policy zv_funnels_insert_own
  on public.zv_funnels
  for insert
  to authenticated
  with check (
    (select fl.user_id from public.zv_flows fl where fl.id = zv_funnels.flow_id) = (select auth.uid())
  );

-- UPDATE: etapa antiga e nova (em WITH CHECK) pertencem a fluxo do usuário
create policy zv_funnels_update_own
  on public.zv_funnels
  for update
  to authenticated
  using (
    (select fl.user_id from public.zv_flows fl where fl.id = zv_funnels.flow_id) = (select auth.uid())
  )
  with check (
    (select fl.user_id from public.zv_flows fl where fl.id = zv_funnels.flow_id) = (select auth.uid())
  );

-- DELETE: só em etapas de fluxo do usuário
create policy zv_funnels_delete_own
  on public.zv_funnels
  for delete
  to authenticated
  using (
    (select fl.user_id from public.zv_flows fl where fl.id = zv_funnels.flow_id) = (select auth.uid())
  );

comment on table public.zv_funnels is
  'Etapas do fluxo: RLS exige zv_funnels.flow_id -> zv_flows.user_id = auth.uid().';
