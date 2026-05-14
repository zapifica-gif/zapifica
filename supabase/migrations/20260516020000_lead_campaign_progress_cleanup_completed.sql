-- Higiene: progresso de funil preso a campanhas já concluídas.
-- Cenário corrigido: pause/concluir campanha não removia `lead_campaign_progress`,
-- o webhook via "fluxo_em_andamento" fantasma e a IA era suprimida sem campanha ativa no painel.
--
-- Não removemos linhas de campanhas em `paused`/`draft` aqui (podem ser retomadas);
-- o runtime (Edge) filtra só `zv_campaigns.status = 'active'`. Para paused/draft órfãos,
-- use o painel (pausar/concluir de novo) ou SQL manual se necessário.

delete from public.lead_campaign_progress p
using public.zv_campaigns c
where p.campaign_id = c.id
  and c.status = 'completed';
