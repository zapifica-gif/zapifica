-- Biblioteca de etiquetas (tags) por usuário — usada na base de contatos Zap Voice.
create table if not exists public.zv_contact_tag_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists zv_contact_tag_presets_user_name_lower_uidx
  on public.zv_contact_tag_presets (user_id, lower(trim(name)));

create index if not exists zv_contact_tag_presets_user_idx
  on public.zv_contact_tag_presets (user_id, created_at desc);

comment on table public.zv_contact_tag_presets is
  'Etiquetas sugeridas / catálogo do usuário para marcar leads (pode renomear em massa via app).';

alter table public.zv_contact_tag_presets enable row level security;

drop policy if exists zv_contact_tag_presets_select_own on public.zv_contact_tag_presets;
create policy zv_contact_tag_presets_select_own
  on public.zv_contact_tag_presets for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists zv_contact_tag_presets_insert_own on public.zv_contact_tag_presets;
create policy zv_contact_tag_presets_insert_own
  on public.zv_contact_tag_presets for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists zv_contact_tag_presets_update_own on public.zv_contact_tag_presets;
create policy zv_contact_tag_presets_update_own
  on public.zv_contact_tag_presets for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists zv_contact_tag_presets_delete_own on public.zv_contact_tag_presets;
create policy zv_contact_tag_presets_delete_own
  on public.zv_contact_tag_presets for delete
  to authenticated
  using (auth.uid() = user_id);
