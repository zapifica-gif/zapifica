-- ============================================================================
-- Funil: tipo de mídia + URL; bucket `campaign_media` (URLs públicas p/ worker)
-- ============================================================================

do $$ begin
  create type public.zv_funnel_media_type as enum (
    'text',
    'image',
    'video',
    'audio',
    'document'
  );
exception
  when duplicate_object then null;
end $$;

alter table public.zv_funnels
  add column if not exists media_type public.zv_funnel_media_type not null default 'text';

alter table public.zv_funnels
  add column if not exists media_url text;

-- Bucket público: Worker / Evolution buscam a URL; paths `<user_id>/…`
insert into storage.buckets (id, name, public)
values ('campaign_media', 'campaign_media', true)
on conflict (id) do update set public = excluded.public;

-- Leitura pública (URL pública do objeto)
drop policy if exists "campaign_media_select_public" on storage.objects;
create policy "campaign_media_select_public"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'campaign_media');

-- Escrita: só na pasta do usuário autenticado
drop policy if exists "campaign_media_insert_own" on storage.objects;
create policy "campaign_media_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'campaign_media'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "campaign_media_update_own" on storage.objects;
create policy "campaign_media_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'campaign_media'
    and (name like (auth.uid()::text || '/%'))
  )
  with check (
    bucket_id = 'campaign_media'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "campaign_media_delete_own" on storage.objects;
create policy "campaign_media_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'campaign_media'
    and (name like (auth.uid()::text || '/%'))
  );
