-- ============================================================================
-- Zapifica — user_settings (dados da empresa) para templates de mensagens
-- ============================================================================

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  agencia_nome text,
  vendedor_primeiro_nome text,
  telefone_contato text,
  instagram_empresa text,
  site_empresa text,
  avalie_google text,
  endereco text,
  telefones text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is
  'Configurações do usuário (empresa/agência) usadas em templates de mensagens do ZapVoice.';

-- updated_at automático (reaproveita trigger padrão do projeto)
drop trigger if exists user_settings_touch_updated_at on public.user_settings;
create trigger user_settings_touch_updated_at
  before update on public.user_settings
  for each row execute function public.tg_touch_updated_at();

alter table public.user_settings enable row level security;

drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own"
  on public.user_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own"
  on public.user_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

