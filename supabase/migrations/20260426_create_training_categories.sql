-- ============================================================================
-- RAG Segmentado: Categorias/Empreendimentos para a Base de Conhecimento
-- ============================================================================

-- 1) Tabela de categorias (multi-tenant por user_id)
create table if not exists public.ai_training_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint ai_training_categories_name_non_empty check (length(trim(name)) > 0)
);

create index if not exists ai_training_categories_user_idx
  on public.ai_training_categories (user_id, created_at desc);

alter table public.ai_training_categories enable row level security;

drop policy if exists "ai_training_categories_select_own" on public.ai_training_categories;
create policy "ai_training_categories_select_own"
  on public.ai_training_categories for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "ai_training_categories_insert_own" on public.ai_training_categories;
create policy "ai_training_categories_insert_own"
  on public.ai_training_categories for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "ai_training_categories_update_own" on public.ai_training_categories;
create policy "ai_training_categories_update_own"
  on public.ai_training_categories for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "ai_training_categories_delete_own" on public.ai_training_categories;
create policy "ai_training_categories_delete_own"
  on public.ai_training_categories for delete
  to authenticated
  using (auth.uid() = user_id);

comment on table public.ai_training_categories is
  'Categorias/empreendimentos do treinamento da IA. O usuário ativa/desativa para controlar o contexto usado no atendimento.';

-- 2) Relacionar materiais à categoria
alter table public.ai_training_materials
  add column if not exists category_id uuid null references public.ai_training_categories (id) on delete set null;

create index if not exists ai_training_materials_user_category_created_idx
  on public.ai_training_materials (user_id, category_id, created_at desc);

-- 3) Backfill: cria categoria padrão "Dados Gerais" por usuário existente e
--    atribui materiais antigos a essa categoria (evita dados órfãos).
with users_in_system as (
  select distinct user_id
  from public.ai_company_context
  union
  select distinct user_id
  from public.ai_training_materials
),
inserted as (
  insert into public.ai_training_categories (user_id, name, is_active)
  select u.user_id, 'Dados Gerais', true
  from users_in_system u
  where not exists (
    select 1
    from public.ai_training_categories c
    where c.user_id = u.user_id
      and lower(trim(c.name)) = lower('Dados Gerais')
  )
  returning id, user_id
)
update public.ai_training_materials m
set category_id = c.id
from public.ai_training_categories c
where m.category_id is null
  and c.user_id = m.user_id
  and lower(trim(c.name)) = lower('Dados Gerais');

