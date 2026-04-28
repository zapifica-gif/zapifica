-- ============================================================================
-- Zap Voice — 5 iscas (variações) por campanha
-- Mantém compatibilidade com o campo legado `isca_message`.
-- ============================================================================

alter table public.zv_campaigns
  add column if not exists isca_messages text[] not null default '{}';

comment on column public.zv_campaigns.isca_messages is
  'Variações de isca (ex.: 5 opções) para revezar por lead e reduzir padrão repetitivo.';

-- Migração suave: se a campanha tem isca_message preenchida e ainda não tem isca_messages,
-- coloca a isca_message como primeira opção.
update public.zv_campaigns
set isca_messages = array[isca_message]
where (isca_messages is null or array_length(isca_messages, 1) is null or array_length(isca_messages, 1) = 0)
  and coalesce(isca_message, '') <> '';

