-- ============================================================================
-- Inbox / CRM: mensagens de chat vinculadas a leads
-- Requer: public.leads (id uuid PK) com user_id, phone, etc.
-- ============================================================================

do $$ begin
  create type public.chat_sender_type as enum ('agencia', 'cliente', 'ia');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.chat_content_type as enum ('text', 'audio', 'image');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  sender_type public.chat_sender_type not null,
  content_type public.chat_content_type not null default 'text',
  message_body text,
  evolution_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_lead_id_created_at_idx
  on public.chat_messages (lead_id, created_at);

-- Evita duplicar a mesma mensagem da Evolution em retries
create unique index if not exists chat_messages_evolution_id_unique
  on public.chat_messages (evolution_message_id)
  where evolution_message_id is not null and length(trim(evolution_message_id)) > 0;

comment on table public.chat_messages is 'Histórico de mensagens WhatsApp (agência, cliente, IA) por lead.';

-- ---------------------------------------------------------------------------
-- RLS: acesso somente a mensagens cujo lead pertence ao utilizador
-- ---------------------------------------------------------------------------
alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages_select_own" on public.chat_messages;
create policy "chat_messages_select_own"
  on public.chat_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.leads l
      where l.id = chat_messages.lead_id
        and l.user_id = auth.uid()
    )
  );

drop policy if exists "chat_messages_insert_own" on public.chat_messages;
create policy "chat_messages_insert_own"
  on public.chat_messages
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.leads l
      where l.id = chat_messages.lead_id
        and l.user_id = auth.uid()
    )
  );

-- (Opcional) sem updates no histórico — políticas de update/delete omitidas
-- Se precisar editar, adicione policies alinhadas ao mesmo `exists` em leads

-- ---------------------------------------------------------------------------
-- Realtime (necessário para o ChatWindow escutar INSERTs)
-- Executar uma vez no SQL Editor, ou: Dashboard > Database > Replication
--   e marque a tabela `chat_messages` para a publicação `supabase_realtime`.
--   Exemplo (ignore o erro "already member" se aplicar de novo):
--   alter publication supabase_realtime add table public.chat_messages;
-- ---------------------------------------------------------------------------
