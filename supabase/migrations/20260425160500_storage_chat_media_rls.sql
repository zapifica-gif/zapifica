-- ============================================================================
-- Storage (RLS): liberar upload/leitura no bucket público `chat_media`
--
-- Problema: "new row violates row-level security policy" ao fazer upload
--           via supabase-js no frontend.
--
-- Estratégia:
--  - SELECT: público (anon + authenticated) somente no bucket `chat_media`
--  - INSERT/UPDATE: authenticated somente em paths que começam com auth.uid()
--      Ex.: "<user_uuid>/<lead_uuid>/<arquivo>"
--
-- Observação: `upload(..., { upsert: true })` pode virar UPDATE, então
--             precisamos permitir UPDATE também.
-- ============================================================================

-- SELECT público (bucket é público, mas RLS pode bloquear listagem/leitura via API)
drop policy if exists "chat_media_select_public" on storage.objects;
create policy "chat_media_select_public"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'chat_media');

-- INSERT: usuário autenticado só escreve na própria pasta
drop policy if exists "chat_media_insert_own_folder" on storage.objects;
create policy "chat_media_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat_media'
    and (name like (auth.uid()::text || '/%'))
  );

-- UPDATE: necessário para uploads com upsert=true
drop policy if exists "chat_media_update_own_folder" on storage.objects;
create policy "chat_media_update_own_folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'chat_media'
    and (name like (auth.uid()::text || '/%'))
  )
  with check (
    bucket_id = 'chat_media'
    and (name like (auth.uid()::text || '/%'))
  );

