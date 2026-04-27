-- ============================================================================
-- Freemium: créditos de leads + bucket de logos
-- ============================================================================

-- 1) Créditos (50 grátis por cliente)
alter table public.user_profiles
  add column if not exists lead_credits integer not null default 50;

comment on column public.user_profiles.lead_credits is
  'Créditos de busca/captura (freemium). Por padrão, clientes começam com 50.';

create index if not exists user_profiles_lead_credits_idx
  on public.user_profiles (lead_credits);

-- 2) Storage bucket: logos da empresa (público)
insert into storage.buckets (id, name, public)
values ('company_logos', 'company_logos', true)
on conflict (id) do update set public = excluded.public;

-- Leitura pública
drop policy if exists "company_logos_select_public" on storage.objects;
create policy "company_logos_select_public"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'company_logos');

-- Escrita autenticada apenas dentro da própria pasta (`<auth.uid()>/...`)
drop policy if exists "company_logos_insert_own" on storage.objects;
create policy "company_logos_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'company_logos'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "company_logos_update_own" on storage.objects;
create policy "company_logos_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'company_logos'
    and (name like (auth.uid()::text || '/%'))
  )
  with check (
    bucket_id = 'company_logos'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "company_logos_delete_own" on storage.objects;
create policy "company_logos_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'company_logos'
    and (name like (auth.uid()::text || '/%'))
  );

