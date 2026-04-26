-- ============================================================================
-- Leads: origens Enterprise + Campanhas com múltiplas tags (array)
-- ============================================================================

comment on column public.leads.source is
  'Origem do contato, ex.: google_maps, instagram, manual_csv, google_contacts, ou null.';

create index if not exists leads_user_source_idx
  on public.leads (user_id, source)
  where source is not null;

-- Múltiplas tags de público por campanha (OR no disparo: lead com tag em qualquer uma)
alter table public.zv_campaigns
  add column if not exists audience_tags text[] not null default '{}';

update public.zv_campaigns
set audience_tags = case
  when coalesce(audience_tag, '') = '' then '{}'::text[]
  else array[audience_tag]
end
where audience_tags = '{}'::text[]
   or (audience_tag is not null and audience_tag <> '');

create index if not exists zv_campaigns_audience_tags_gin
  on public.zv_campaigns using gin (audience_tags);

alter table public.zv_campaigns
  drop column if exists audience_tag;

drop index if exists zv_campaigns_user_tag_idx;
