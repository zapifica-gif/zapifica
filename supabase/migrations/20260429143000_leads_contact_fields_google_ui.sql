-- Campos adicionais de contato (layout estilo Google Contacts) + favorito.

alter table public.leads
  add column if not exists email text,
  add column if not exists job_title text,
  add column if not exists company_name text,
  add column if not exists city text,
  add column if not exists address_line text,
  add column if not exists contact_starred boolean not null default false;

comment on column public.leads.email is 'E-mail do contato (opcional).';
comment on column public.leads.job_title is 'Cargo (opcional).';
comment on column public.leads.company_name is 'Empresa (opcional).';
comment on column public.leads.city is 'Cidade (opcional).';
comment on column public.leads.address_line is 'Endereço em uma linha (opcional).';
comment on column public.leads.contact_starred is 'Favorito na base de contatos (lista Frequentes).';

comment on column public.leads.source is
  'Origem: google_maps, instagram, manual_csv, google_contacts, inbound_whatsapp, meta_ads (só tráfego Meta real), ou null.';
