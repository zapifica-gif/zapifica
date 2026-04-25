-- ============================================================================
-- CRM: suporte a mídias recebidas pelo WhatsApp
-- ============================================================================

alter table public.chat_messages
  add column if not exists media_url text;

do $$ begin
  if exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'chat_content_type'
  ) and not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typnamespace = 'public'::regnamespace
      and t.typname = 'chat_content_type'
      and e.enumlabel = 'document'
  ) then
    alter type public.chat_content_type add value 'document';
  end if;
end $$;

comment on column public.chat_messages.media_url is
  'URL pública da mídia recebida pelo WhatsApp e armazenada no bucket chat_media.';
