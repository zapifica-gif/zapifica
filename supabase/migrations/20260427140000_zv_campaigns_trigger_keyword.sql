-- Palavra-chave mestre: resposta exata do lead após a isca, para avançar ao passo 2.
alter table public.zv_campaigns
  add column if not exists trigger_keyword text;

comment on column public.zv_campaigns.trigger_keyword is
  'Gatilho exato: o cliente deve digitar isso após a isca (Etapa 1) para o funil avançar ao passo 2 (exceto avanço temporizado).';
