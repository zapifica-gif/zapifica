-- Nome da instância Evolution no momento do insert (defesa em profundidade para inbox-ai-reply).
alter table public.chat_messages
  add column if not exists evolution_instance_name text;

comment on column public.chat_messages.evolution_instance_name is
  'Instância Evolution usada na ingestão/envio; inbox-ai-reply valida contra o user_id do lead.';
