-- ============================================================================
-- Storage: bucket público `training_files` (materiais da Central de Treinamento)
-- Paths: `<auth.uid()>/<arquivo>` — igual ao padrão do `chat_media`.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('training_files', 'training_files', true)
on conflict (id) do update set public = excluded.public;

-- SELECT: usuário autenticado só lê a própria pasta (URLs públicas continuam funcionando fora da API)
drop policy if exists "training_files_select_public" on storage.objects;
drop policy if exists "training_files_select_own_read" on storage.objects;
create policy "training_files_select_own_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'training_files'
    and (name like (auth.uid()::text || '/%'))
  );

-- Escrita só na pasta do próprio usuário
drop policy if exists "training_files_insert_own_folder" on storage.objects;
create policy "training_files_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'training_files'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "training_files_update_own_folder" on storage.objects;
create policy "training_files_update_own_folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'training_files'
    and (name like (auth.uid()::text || '/%'))
  )
  with check (
    bucket_id = 'training_files'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "training_files_delete_own_folder" on storage.objects;
create policy "training_files_delete_own_folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'training_files'
    and (name like (auth.uid()::text || '/%'))
  );
