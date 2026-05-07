-- ============================================================================
-- Ajuste: tornar o alvo de conflito inferível pelo PostgREST/Supabase.
--
-- ON CONFLICT (user_id, phone_key) funciona melhor quando existe uma
-- UNIQUE CONSTRAINT (e não apenas um unique index parcial).
-- ============================================================================

do $$
begin
  -- Remove o unique index parcial, se existir (ele pode impedir inference do conflito).
  execute 'drop index if exists public.leads_user_phone_key_uniq';
exception
  when others then
    -- defensivo: não bloquear migration se a remoção falhar por dependência inesperada
    null;
end $$;

do $$
begin
  alter table public.leads
    add constraint leads_user_phone_key_uniq unique (user_id, phone_key);
exception
  when duplicate_object then null;
end $$;

comment on constraint leads_user_phone_key_uniq on public.leads is
  'Anti-clonagem: um lead por (tenant=user_id, phone_key normalizado).';

