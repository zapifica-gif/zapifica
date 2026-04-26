-- Rastreio do run Apify (webhook) + Storage para export CSV dos resultados
-- ---------------------------------------------------------------------------

alter table public.lead_extractions
  add column if not exists apify_run_id text;

create unique index if not exists lead_extractions_apify_run_id_uidx
  on public.lead_extractions (apify_run_id)
  where apify_run_id is not null;

-- Bucket público: paths `<user_id>/<extraction_id>.csv` (igual padrão training_files)
insert into storage.buckets (id, name, public)
values ('lead_extractions', 'lead_extractions', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "lead_extractions_select_own_read" on storage.objects;
create policy "lead_extractions_select_own_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'lead_extractions'
    and (name like (auth.uid()::text || '/%'))
  );

drop policy if exists "lead_extractions_delete_own" on storage.objects;
create policy "lead_extractions_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'lead_extractions'
    and (name like (auth.uid()::text || '/%'))
  );

-- Upload é feito pela Edge com service_role; leitura/apagar pelo dono (URLs públicas).
