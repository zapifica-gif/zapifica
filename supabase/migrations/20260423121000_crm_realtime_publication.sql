-- ============================================================================
-- CRM Realtime: novos leads/mensagens chegando pelo webhook aparecem no frontend
-- ============================================================================

do $$ begin
  alter publication supabase_realtime add table public.leads;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
