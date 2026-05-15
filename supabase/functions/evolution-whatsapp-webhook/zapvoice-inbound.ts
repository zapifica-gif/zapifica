// Inbound Zap Voice — gatilho + `zv_funnels` (fluxo). A isca (texto campanha) SÓ entra em `scheduled_messages`
// pela ativação no painel; este webhook nunca reenfileira isca.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type FunnelRow = {
  id: string
  step_order: number
  message: string
  media_type: 'text' | 'image' | 'video' | 'audio' | 'document'
  media_url: string | null
  delay_seconds: number
  advance_type?: 'auto' | 'exact' | 'timer' | null
  expected_trigger?: string | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
}

type TriggerCondition = 'equals' | 'contains' | 'starts_with' | 'not_contains'

/** Webhook não usa isca_message (isca só é agendada no painel). */
type CampaignRow = {
  id: string
  name: string
  flow_id: string
  audience_tags: string[] | null
  trigger_keyword: string | null
  trigger_condition: TriggerCondition
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  created_at: string
}

/** Normaliza texto para gatilhos: minúsculas, colapsa espaços, remove acentos (ex.: "café" ≈ "cafe"). */
function normText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Snapshot de delay para scheduled_messages: o CHECK exige par min+max ou ambos nulos.
 * Evita insert falhar silenciosamente quando só um dos lados veio na etapa/campanha.
 */
function pairDelaySnapshotForQueue(params: {
  step: FunnelRow
  campMin: number | null | undefined
  campMax: number | null | undefined
}): { min: number | null; max: number | null } {
  const sn = params.step
  const rawMin = sn.min_delay_seconds
  const rawMax = sn.max_delay_seconds
  let minS: number | null =
    typeof rawMin === 'number' && Number.isFinite(rawMin)
      ? Math.max(0, rawMin)
      : typeof params.campMin === 'number' && Number.isFinite(params.campMin)
        ? Math.max(0, params.campMin)
        : null
  let maxS: number | null =
    typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.max(0, rawMax)
      : typeof params.campMax === 'number' && Number.isFinite(params.campMax)
        ? Math.max(0, params.campMax)
        : null
  if (minS != null && maxS == null) maxS = minS
  if (maxS != null && minS == null) minS = maxS
  if (minS != null && maxS != null && maxS < minS) maxS = minS
  if (minS != null && maxS != null && maxS > 3600) maxS = 3600
  return { min: minS, max: maxS }
}

/** Avalia a mensagem do lead contra a palavra-chave e a regra da campanha. */
function splitTriggerKeywordsRaw(keywordsRaw: string): string[] {
  // Compatibilidade: suportamos "sim,quero,cupom" e também "sim\nquero" / "sim;quero".
  return String(keywordsRaw ?? '')
    .split(/[,\n;]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

function triggerConditionSatisfiedSingle(
  condition: TriggerCondition,
  messageNorm: string,
  keywordRaw: string,
): boolean {
  const kw = normText(keywordRaw)
  if (condition === 'not_contains') {
    if (!kw) return false
    return !messageNorm.includes(kw)
  }
  if (!kw) return false
  switch (condition) {
    case 'equals':
      return messageNorm === kw
    case 'contains':
      return messageNorm.includes(kw)
    case 'starts_with':
      return messageNorm.startsWith(kw)
    default:
      return false
  }
}

/** Avalia a mensagem do lead contra MÚLTIPLOS gatilhos (CSV). */
function triggerConditionSatisfiedAny(
  condition: TriggerCondition,
  messageNorm: string,
  keywordsCsvRaw: string,
): boolean {
  const rawList = splitTriggerKeywordsRaw(keywordsCsvRaw)
  const kws = rawList.map(normText).filter(Boolean)
  if (kws.length === 0) return false

  if (condition === 'not_contains') {
    // "Não contém": verdadeiro apenas se NÃO contiver NENHUM dos gatilhos.
    return kws.every((kw) => !messageNorm.includes(kw))
  }

  // equals / contains / starts_with: verdadeiro se bater QUALQUER gatilho.
  for (const kw of kws) {
    if (triggerConditionSatisfiedSingle(condition, messageNorm, kw)) return true
  }
  return false
}

function leadTagForCampaign(c: CampaignRow): string {
  const tags = c.audience_tags?.map((t) => t.trim()).filter(Boolean) ?? []
  if (tags.length > 0) return tags[0]!
  const n = c.name?.trim() || 'Campanha'
  return `Campanha — ${n.slice(0, 60)}`
}

/** Delay da etapa: null/NaN quebrava `new Date(now+NaN)` e derrubava o webhook sem insert na fila. */
function funnelStepDelaySeconds(step: FunnelRow): number {
  const n = Number(step.delay_seconds)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * Conta progresso de funil que ainda deve bloquear a IA: linhas em `lead_campaign_progress`
 * com status de funil ativo **e** campanha pai em `zv_campaigns` com `status = 'active'`.
 * Progresso ligado a campanha `paused`/`completed`/`draft` não entra (evita `fluxo_em_andamento` fantasma).
 */
export async function countLeadZvProgressBlockingAi(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
): Promise<{ count: number; error: { message: string } | null }> {
  const { data: rows, error } = await supabase
    .from('lead_campaign_progress')
    .select('campaign_id')
    .eq('user_id', userId)
    .eq('lead_id', leadId)
    .in('status', ['active', 'awaiting_last_send'])
  if (error) {
    return { count: 0, error: { message: error.message } }
  }
  const list = rows ?? []
  if (list.length === 0) return { count: 0, error: null }
  const ids = [...new Set(list.map((r) => String((r as { campaign_id: string }).campaign_id)))]
  const { data: camps, error: cErr } = await supabase
    .from('zv_campaigns')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('id', ids)
  if (cErr) {
    console.warn('[ZapVoice inbound] countLeadZvProgressBlockingAi: zv_campaigns', cErr.message)
    // Falha fechada: assume o pior (todas as linhas contam) para não liberar IA por erro transitório.
    return { count: list.length, error: null }
  }
  const active = new Set((camps ?? []).map((c) => (c as { id: string }).id))
  const count = list.filter((r) => active.has((r as { campaign_id: string }).campaign_id)).length
  return { count, error: null }
}

/**
 * Auto-cura (Edge): `ai_paused_for_zv_dispatch` presa no lead sem funil ZV real nem fila pendente
 * (ex.: worker não rodou / não atualizou após `completed`). Corrige `leads` e retorna `true`
 * para a IA seguir. Se ainda há progresso em campanha ativa ou mensagens ZV na fila, retorna `false`.
 * Em erro de leitura das contagens, retorna `false` (conservador — não libera por dúvida).
 */
export async function trySelfHealStaleZvDispatchPause(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  logLabel = '[ZV self-heal]',
): Promise<boolean> {
  const [{ count: pend, error: pe }, progBlocking] = await Promise.all([
    supabase
      .from('scheduled_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .not('zv_campaign_id', 'is', null)
      .in('status', ['pending', 'processing'])
      .eq('is_active', true),
    countLeadZvProgressBlockingAi(supabase, userId, leadId),
  ])

  const pendExact = pend ?? 0
  const progExact = progBlocking.count
  const progErrMsg = progBlocking.error?.message ?? null
  const pendErrMsg = pe?.message ?? null

  console.log(`${logLabel} snapshot`, {
    lead_id: leadId,
    user_id: userId,
    scheduled_zv_pending_or_processing_count: pendExact,
    scheduled_zv_count_error: pendErrMsg,
    lead_campaign_progress_blocking_count: progExact,
    progress_count_error: progErrMsg,
  })

  if (pe || progBlocking.error) {
    console.warn(
      `${logLabel} abort: checagem incompleta (não cura)`,
      pendErrMsg ?? progErrMsg,
    )
    return false
  }
  if (pendExact !== 0 || progExact !== 0) {
    console.log(`${logLabel} abort: ainda há fila ou funil bloqueante`, {
      lead_id: leadId,
      pend_exact: pendExact,
      prog_blocking_exact: progExact,
    })
    return false
  }

  const { data: row, error: leErr } = await supabase
    .from('leads')
    .select('ai_paused_for_zv_dispatch')
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle()
  if (leErr || !row) {
    if (leErr) console.warn(`${logLabel} abort: read lead`, leErr.message)
    return false
  }
  const flagOn = (row as { ai_paused_for_zv_dispatch?: boolean | null }).ai_paused_for_zv_dispatch === true
  console.log(`${logLabel} lead flag ai_paused_for_zv_dispatch`, {
    lead_id: leadId,
    ai_paused_for_zv_dispatch: flagOn,
  })
  if (!flagOn) {
    console.log(`${logLabel} ok: flag já false — IA não precisa de UPDATE`)
    return true
  }

  const { error: ue } = await supabase
    .from('leads')
    .update({
      ai_paused_for_zv_dispatch: false,
      funnel_locked_until: null,
    })
    .eq('id', leadId)
    .eq('user_id', userId)
  if (ue) {
    console.warn(`${logLabel} abort: falha no UPDATE leads`, ue.message)
    return false
  }
  console.log(`${logLabel} UPDATE ok: ai_paused_for_zv_dispatch=false, funnel_locked_until=null`, {
    lead_id: leadId,
  })
  return true
}

/** Libera a IA do lead se não há mais Zap Voice pendente/processando nem progresso ativo. */
async function maybeReleaseLeadZvAiDispatchPause(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  context: string,
): Promise<void> {
  const [{ count: pend, error: pe }, progBlocking] = await Promise.all([
    supabase
      .from('scheduled_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .not('zv_campaign_id', 'is', null)
      .in('status', ['pending', 'processing'])
      .eq('is_active', true),
    countLeadZvProgressBlockingAi(supabase, userId, leadId),
  ])
  const progCt = progBlocking.count
  const pgE = progBlocking.error
  if (pe || pgE) {
    console.warn(`[ZapVoice inbound] release pause (${context}):`, pe?.message ?? pgE?.message)
    return
  }
  if ((pend ?? 0) !== 0 || progCt !== 0) return
  const { error } = await supabase
    .from('leads')
    .update({
      ai_paused_for_zv_dispatch: false,
      funnel_locked_until: null,
    })
    .eq('id', leadId)
    .eq('user_id', userId)
  if (error) {
    console.error(`[ZapVoice inbound] funnel unlock (${context}):`, error.message)
    return
  }
  console.warn(`[ZapVoice inbound] IA liberada (${context}) lead=${leadId}`)
}

/** Se a Etapa 1 não entra na fila, reavalia a trava Zap Voice por lead (não mantém estado obsoleto). */
async function unlockLeadFunnelLock(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  context: string,
): Promise<void> {
  await maybeReleaseLeadZvAiDispatchPause(supabase, userId, leadId, context)
}

type ProgressRow = {
  id: string
  campaign_id: string
  next_step_order: number
  total_steps: number
  status: 'active' | 'awaiting_last_send' | 'completed'
}

function short(s: string | null | undefined, n = 120): string {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return `${t.slice(0, n)}…`
}

/** Extrai code/message/hint/details/data do erro do Supabase para diagnóstico. */
function extractDbError(err: unknown): {
  code: string | null
  message: string | null
  hint: string | null
  details: string | null
  raw: string
} {
  if (!err) return { code: null, message: null, hint: null, details: null, raw: 'null' }
  const e = err as Record<string, unknown>
  const code = typeof e.code === 'string' ? e.code : null
  const message = typeof e.message === 'string' ? e.message : null
  const hint = typeof e.hint === 'string' ? e.hint : null
  const details = typeof e.details === 'string' ? e.details : null
  let raw: string
  try {
    raw = JSON.stringify(err)
  } catch {
    raw = String(err)
  }
  return { code, message, hint, details, raw }
}

/** Garante que `flow_id` aponta para um fluxo do mesmo tenant (service role ignora RLS). */
async function assertZvFlowOwnedByTenant(
  supabase: SupabaseClient,
  flowId: string | null | undefined,
  userId: string,
): Promise<boolean> {
  const fid = typeof flowId === 'string' ? flowId.trim() : ''
  if (!fid) return false
  const { data, error } = await supabase
    .from('zv_flows')
    .select('id')
    .eq('id', fid)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.warn('[ZapVoice inbound] assertZvFlowOwnedByTenant', error.message)
    return false
  }
  return Boolean(data)
}

/** Verifica se algum campo obrigatório do payload está vazio/undefined antes do insert. */
function findMissingRequired(
  obj: Record<string, unknown>,
  keys: string[],
): string[] {
  const miss: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined || v === null) miss.push(k)
    else if (typeof v === 'string' && v.trim() === '') miss.push(k)
  }
  return miss
}

export type ZapVoiceInboundResult = {
  enqueued: boolean
  campaignId?: string
  reason?: string
  suppressAi?: boolean
}

export type ZapVoiceInboundParams = {
  supabase: SupabaseClient
  userId: string
  instanceName: string
  leadId: string
  phoneDigits: string
  leadName: string
  messageText: string
  contentType: 'text' | 'audio' | 'image' | 'document'
  /**
   * Quando `true`, relaxa supressão de IA só em caminhos de erro **sem** prioridade de fala do funil
   * (ex.: falha de DB ao listar campanhas). O webhook deve passar `false` para não colidir com
   * `inbox-ai-reply`: o toggle "IA ligada" no CRM não pode sobrepor campanha/fila ZV.
   */
  allowAiDespiteZv?: boolean
}

/** Resposta do lead com progresso ativo: avança o fluxo (nunca reenvia isca). */
async function handleActiveCampaignProgress(
  p: ZapVoiceInboundParams,
  messageNorm: string,
  progress: ProgressRow,
  suppressCampaignAi = true,
): Promise<ZapVoiceInboundResult> {
  console.log('[ZapVoice inbound] pós-gatilho: entrando no handleActiveCampaignProgress', {
    leadId: p.leadId,
    campaignId: progress.campaign_id,
    progressId: progress.id,
    next_step_order: progress.next_step_order,
    total_steps: progress.total_steps,
    status: progress.status,
  })

  if (progress.status === 'awaiting_last_send') {
    console.log('[ZapVoice inbound] early return: progresso aguardando última etapa', {
      leadId: p.leadId,
      campaignId: progress.campaign_id,
      progressId: progress.id,
    })
    return {
      enqueued: false,
      reason: 'aguardando_ultima',
      campaignId: progress.campaign_id,
      suppressAi: suppressCampaignAi,
    }
  }

  const { data: campRow, error: campErr0 } = await p.supabase
    .from('zv_campaigns')
    .select(
      'id, flow_id, trigger_keyword, trigger_condition, min_delay_seconds, max_delay_seconds',
    )
    .eq('user_id', p.userId)
    .eq('id', progress.campaign_id)
    .maybeSingle()

  if (campErr0) {
    console.error('[ZapVoice inbound] campaign read (progress)', campErr0.message)
  }
  console.log('[ZapVoice inbound] pós-gatilho: campanha lida para progresso', {
    leadId: p.leadId,
    campaignId: progress.campaign_id,
    hasRow: Boolean(campRow),
  })
  const camp = campRow as
    | (Pick<
        CampaignRow,
        'id' | 'flow_id' | 'trigger_keyword' | 'trigger_condition' | 'min_delay_seconds' | 'max_delay_seconds'
      > & { trigger_condition?: string })
    | null
  if (!camp?.flow_id) {
    console.error('[ZapVoice inbound] early return: campanha sem flow_id', {
      leadId: p.leadId,
      campaignId: progress.campaign_id,
      campId: camp?.id ?? null,
    })
    return {
      enqueued: false,
      reason: 'campanha_sem_fluxo',
      campaignId: progress.campaign_id,
      suppressAi: suppressCampaignAi,
    }
  }

  const cond = (camp.trigger_condition ?? 'equals') as TriggerCondition
  const flowId = camp.flow_id
  console.log('[ZapVoice inbound] pós-gatilho: flowId resolvido', {
    leadId: p.leadId,
    campaignId: progress.campaign_id,
    flowId,
    cond,
    keyword: short(camp.trigger_keyword, 80),
  })

  if (!(await assertZvFlowOwnedByTenant(p.supabase, flowId, p.userId))) {
    console.error('[ZapVoice inbound] early return: fluxo não pertence ao tenant', {
      leadId: p.leadId,
      campaignId: progress.campaign_id,
      flowId,
    })
    return {
      enqueued: false,
      reason: 'fluxo_tenant_incompativel',
      campaignId: progress.campaign_id,
      suppressAi: suppressCampaignAi,
    }
  }

  // Primeira etapa física pode ter step_order 2, 3… — nunca usar só literal `1`.
  const { data: primeiraEtapaRaw, error: primeiraErr } = await p.supabase
    .from('zv_funnels')
    .select(
      'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger, min_delay_seconds, max_delay_seconds',
    )
    .eq('flow_id', flowId)
    .order('step_order', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (primeiraErr) {
    console.error('[ZapVoice inbound] primeira etapa funil', primeiraErr.message)
    return {
      enqueued: false,
      reason: 'erro_proximo_passo',
      campaignId: progress.campaign_id,
      suppressAi: suppressCampaignAi,
    }
  }

  const primeiraOrdem =
    primeiraEtapaRaw != null
      ? Number((primeiraEtapaRaw as { step_order?: number }).step_order ?? NaN)
      : NaN
  const progressNext = Number(progress.next_step_order)

  console.log('[ZapVoice inbound] pós-gatilho: primeira etapa do funil', {
    leadId: p.leadId,
    campaignId: progress.campaign_id,
    primeiraOrdem,
    progressNext,
  })

  if (progress.total_steps === 0) {
    const slotFluxoVazio = Number.isFinite(primeiraOrdem) ? primeiraOrdem : 1
    if (Number.isFinite(progressNext) && progressNext === slotFluxoVazio) {
      if (triggerConditionSatisfiedAny(cond, messageNorm, camp.trigger_keyword ?? '')) {
        console.log('[ZapVoice inbound] fluxo vazio: gatilho bateu; marcando conclusão', {
          leadId: p.leadId,
          campaignId: progress.campaign_id,
        })
        await p.supabase.from('lead_campaign_completions').insert({
          user_id: p.userId,
          lead_id: p.leadId,
          campaign_id: progress.campaign_id,
        })
        await p.supabase
          .from('lead_campaign_progress')
          .delete()
          .eq('id', progress.id)
          .eq('user_id', p.userId)
      }
      console.log('[ZapVoice inbound] early return: fluxo vazio', {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
      })
      return {
        enqueued: false,
        reason: 'fluxo_vazio',
        campaignId: progress.campaign_id,
        suppressAi: suppressCampaignAi,
      }
    }
  }

  // Correção defensiva: se `next_step_order` não aponta para a primeira etapa real,
  // tentamos “auto-curar” para evitar travar pós-isca sem enfileirar nada.
  let effectiveNext = progressNext
  if (!Number.isFinite(effectiveNext) || effectiveNext <= 0) {
    effectiveNext = primeiraOrdem
  } else if (Number.isFinite(primeiraOrdem) && effectiveNext !== primeiraOrdem) {
    const { data: stepExists, error: stepExistsErr } = await p.supabase
      .from('zv_funnels')
      .select('id')
      .eq('flow_id', flowId)
      .eq('step_order', effectiveNext)
      .maybeSingle()
    if (stepExistsErr) {
      console.warn('[ZapVoice inbound] validação next_step_order falhou', stepExistsErr.message, {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
        effectiveNext,
        primeiraOrdem,
      })
    }
    if (!stepExists) {
      console.warn('[ZapVoice inbound] next_step_order aponta para etapa inexistente; corrigindo para a 1ª etapa', {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
        next_step_order: effectiveNext,
        primeiraOrdem,
      })
      effectiveNext = primeiraOrdem
    }

    // Caso clássico: progresso nasce com default 1, mas o funil começa em 2/10/etc.
    if (Number.isFinite(primeiraOrdem) && effectiveNext !== primeiraOrdem) {
      console.warn('[ZapVoice inbound] next_step_order desalinhado; ajustando ponteiro no progresso', {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
        from: progressNext,
        to: primeiraOrdem,
      })
      const { error: fixErr } = await p.supabase
        .from('lead_campaign_progress')
        .update({ next_step_order: primeiraOrdem })
        .eq('id', progress.id)
      if (fixErr) {
        console.error('[ZapVoice inbound] falha ao ajustar next_step_order', fixErr.message, {
          leadId: p.leadId,
          campaignId: progress.campaign_id,
          progressId: progress.id,
          to: primeiraOrdem,
        })
      } else {
        effectiveNext = primeiraOrdem
      }
    }
  }

  const isPrimeiraEtapaPosIsca =
    Number.isFinite(primeiraOrdem) &&
    primeiraEtapaRaw != null &&
    Number.isFinite(effectiveNext) &&
    effectiveNext === primeiraOrdem

  if (isPrimeiraEtapaPosIsca) {
    // Modelo simplificado: o gatilho VALE só aqui (palavra-chave da campanha).
    // A partir desta etapa, todo o fluxo segue automaticamente pelo timer
    // (worker enfileira as próximas etapas).
    const step = primeiraEtapaRaw as FunnelRow
    if (!triggerConditionSatisfiedAny(cond, messageNorm, camp.trigger_keyword ?? '')) {
      console.log('[ZapVoice inbound] early return: gatilho não bateu na etapa pós-isca', {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
        cond,
        keyword: short(camp.trigger_keyword, 80),
        messageNorm: short(messageNorm, 120),
      })
      // O lead respondeu algo que não bate com a palavra-chave da campanha.
      // Mantemos a IA suprimida para não vazar resposta enquanto o lead estiver
      // na fila de campanha (ex.: ainda não confirmou interesse).
      return {
        enqueued: false,
        reason: 'gatilho_nao_bateu',
        campaignId: progress.campaign_id,
        suppressAi: suppressCampaignAi,
      }
    }

    console.log('[ZapVoice inbound] gatilho reconhecido; buscando/enfileirando a próxima etapa do funil', {
      leadId: p.leadId,
      campaignId: progress.campaign_id,
      flowId,
      step_order: step.step_order,
      zv_funnel_step_id: step.id,
      delay_seconds: step.delay_seconds,
      media_type: step.media_type,
    })
    return await enqueueFunnelStepAndAdvance({
      supabase: p.supabase,
      userId: p.userId,
      leadId: p.leadId,
      phoneDigits: p.phoneDigits,
      instanceName: p.instanceName,
      progress,
      step,
      campMin: camp.min_delay_seconds,
      campMax: camp.max_delay_seconds,
    })
  }

  if (!Number.isFinite(primeiraOrdem) || primeiraEtapaRaw == null) {
    console.error('[ZapVoice inbound] early return: funil sem primeira etapa', {
      leadId: p.leadId,
      campaignId: progress.campaign_id,
      flowId,
      primeiraOrdem,
    })
    return {
      enqueued: false,
      reason: 'sem_proximo_passo',
      campaignId: progress.campaign_id,
      suppressAi: suppressCampaignAi,
    }
  }

  // Diagnóstico: ponteiro `next_step_order` diferente da 1ª etapa → o ramo “gatilho pós-isca” não aplica.
  if (progress.status === 'active' && progressNext !== primeiraOrdem) {
    console.warn('[ZapVoice inbound] next_step_order não alinha com 1ª etapa do fluxo', {
      campaignId: progress.campaign_id,
      leadId: p.leadId,
      progressNext,
      primeiraOrdem,
    })
  }

  // Lead já está dentro do fluxo (etapa 2+): NÃO avançamos por mensagem do lead.
  // O worker (process-scheduled-messages) cuida do timer e enfileira as próximas
  // etapas automaticamente. Aqui só garantimos que a IA permaneça suprimida.
  console.log('[ZapVoice inbound] pós-gatilho: fluxo já está em andamento (timer via agenda); não enfileiro aqui', {
    leadId: p.leadId,
    campaignId: progress.campaign_id,
    effectiveNext,
    primeiraOrdem,
  })
  return {
    enqueued: false,
    reason: 'fluxo_timer_via_agenda',
    campaignId: progress.campaign_id,
    suppressAi: suppressCampaignAi,
  }
}

export async function processZapVoiceInbound(
  p: ZapVoiceInboundParams,
): Promise<ZapVoiceInboundResult> {
  if (p.contentType !== 'text') {
    return { enqueued: false, reason: 'ignorado_nao_texto' }
  }

  const raw = p.messageText.trim()
  if (!raw) {
    return { enqueued: false, reason: 'texto_vazio' }
  }
  if (/^\[(imagem|áudio|vídeo|documento|mensagem)\]$/i.test(raw)) {
    return { enqueued: false, reason: 'conteudo_placeholder' }
  }

  const inboundCheck = findMissingRequired(
    {
      userId: p.userId,
      leadId: p.leadId,
      instanceName: p.instanceName,
      phoneDigits: p.phoneDigits,
    },
    ['userId', 'leadId'],
  )
  if (inboundCheck.length > 0) {
    console.error('[ZapVoice inbound] ERRO FATAL: parâmetros obrigatórios ausentes', {
      missing: inboundCheck,
      userId: p.userId,
      leadId: p.leadId,
      instanceName: p.instanceName,
      phoneDigits: p.phoneDigits,
    })
    return { enqueued: false, reason: 'parametros_invalidos' }
  }

  /** Sem prioridade de fala do funil: `allowAiDespiteZv === true` evita suprimir IA em erros de leitura. */
  const legacyNoAiBypass = (): boolean => p.allowAiDespiteZv !== true

  const messageNorm = normText(raw)
  console.log('[ZapVoice inbound] inbound recebido (texto normalizado)', {
    leadId: p.leadId,
    userId: p.userId,
    instanceName: p.instanceName,
    phoneDigits: p.phoneDigits,
    messageRaw: short(raw, 160),
    messageNorm: short(messageNorm, 160),
    note: 'webhook usa SUPABASE_SERVICE_ROLE_KEY (RLS bypass) — confirmado em index.ts createClient()',
  })

  // Sem ORDER BY: o filtro por (user_id, lead_id, campaign_id) já basta — qualquer drift de schema
  // (ex.: bancos sem `created_at`/`updated_at`) deixava o select inteiro falhar e o funil travava.
  const { data: progList, error: progErr } = await p.supabase
    .from('lead_campaign_progress')
    .select('id, campaign_id, next_step_order, total_steps, status')
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .in('status', ['active', 'awaiting_last_send'])
    .limit(25)

  if (progErr) {
    const dbErr = extractDbError(progErr)
    console.error('[ZapVoice inbound] ERRO FATAL DB (select lead_campaign_progress)', {
      code: dbErr.code,
      message: dbErr.message,
      hint: dbErr.hint,
      details: dbErr.details,
      raw: dbErr.raw,
      leadId: p.leadId,
      userId: p.userId,
    })
    return { enqueued: false, reason: 'erro_progresso', suppressAi: legacyNoAiBypass() }
  }

  const rawProgressed = (progList ?? []) as ProgressRow[]
  const progCampaignIds = [...new Set(rawProgressed.map((r) => r.campaign_id))]
  let progressed: ProgressRow[] = rawProgressed
  if (progCampaignIds.length > 0) {
    const { data: activeParents, error: parErr } = await p.supabase
      .from('zv_campaigns')
      .select('id')
      .eq('user_id', p.userId)
      .eq('status', 'active')
      .in('id', progCampaignIds)
    if (parErr) {
      console.warn('[ZapVoice inbound] filtro campanha ativa (progresso):', parErr.message)
    } else {
      const allowed = new Set((activeParents ?? []).map((r) => (r as { id: string }).id))
      progressed = rawProgressed.filter((r) => allowed.has(r.campaign_id))
      const dropped = rawProgressed.filter((r) => !allowed.has(r.campaign_id)).map((r) => r.campaign_id)
      if (dropped.length > 0) {
        console.warn(
          '[ZapVoice inbound] progresso ignorado na decisão Zap Voice (campanha pai não está active)',
          { leadId: p.leadId, campaignIds: dropped },
        )
      }
    }
  }

  const { count: pendZvCt, error: pendZvErr } = await p.supabase
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .not('zv_campaign_id', 'is', null)
    .in('status', ['pending', 'processing'])
    .eq('is_active', true)
  if (pendZvErr) {
    console.warn('[ZapVoice inbound] contagem fila ZV (scheduled_messages):', pendZvErr.message)
  }
  const pendingZvOutbound = !pendZvErr && (pendZvCt ?? 0) > 0

  const { data: campaigns, error: cErr } = await p.supabase
    .from('zv_campaigns')
    .select(
      'id, name, flow_id, audience_tags, trigger_keyword, trigger_condition, min_delay_seconds, max_delay_seconds, created_at',
    )
    .eq('user_id', p.userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (cErr) {
    console.error('[ZapVoice inbound] list campaigns', cErr.message)
    return { enqueued: false, reason: 'erro_listagem', suppressAi: legacyNoAiBypass() }
  }

  const campaignsList = (campaigns ?? []) as CampaignRow[]

  /**
   * Ordem de decisão (evita travar com 2+ campanhas ativas usando o mesmo gatilho):
   * 1) Se o lead já tem `lead_campaign_progress` ativo, só avaliamos o gatilho
   *    nas campanhas que correspondem a esse progresso (isca → resposta certa).
   * 2) Senão, a primeira campanha ativa cujo gatilho casa (comportamento orgânico).
   */
  let matched: CampaignRow | null = null
  for (const pr of progressed) {
    const row = campaignsList.find((c) => c.id === pr.campaign_id)
    if (!row) continue
    const cond = (row.trigger_condition ?? 'equals') as TriggerCondition
    if (triggerConditionSatisfiedAny(cond, messageNorm, row.trigger_keyword ?? '')) {
      matched = row
      console.log('[ZapVoice inbound] gatilho casou com campanha do progresso ativo', {
        campaignId: row.id,
        leadId: p.leadId,
      })
      break
    }
  }
  if (!matched) {
    for (const row of campaignsList) {
      const cond = (row.trigger_condition ?? 'equals') as TriggerCondition
      if (triggerConditionSatisfiedAny(cond, messageNorm, row.trigger_keyword ?? '')) {
        matched = row
        console.log('[ZapVoice inbound] gatilho casou na listagem global de campanhas', {
          campaignId: row.id,
          leadId: p.leadId,
        })
        break
      }
    }
  }

  /**
   * Prioridade de fala do funil nesta interação (sobreponde bypass de IA ligada):
   * - gatilho casou em campanha ativa, ou
   * - progresso real em campanha ativa, ou
   * - há disparo Zap Voice pendente/processando para o lead.
   */
  const funnelSpeakPriority =
    matched != null || progressed.length > 0 || pendingZvOutbound

  const blockIaThisInbound = (logicWantsSuppress: boolean): boolean =>
    funnelSpeakPriority || (!p.allowAiDespiteZv && logicWantsSuppress)

  // 1) Gatilho de campanha bateu → prioriza SEMPRE o progresso dessa campanha (evita prog de outro funil “roubar” a mensagem).
  if (matched) {
    console.log('[ZapVoice inbound] GATILHO RECONHECIDO: campanha selecionada', {
      leadId: p.leadId,
      campaignId: matched.id,
      flowId: matched.flow_id,
      trigger_condition: matched.trigger_condition,
      trigger_keyword: short(matched.trigger_keyword, 80),
    })

    // CRÍTICO: pausa IMEDIATA da IA assim que o gatilho casou (corrida com inbox-ai-reply).
    // Funil tem prioridade: sempre aplica, inclusive com "IA Ligada" no CRM.
    try {
      const upPause = await p.supabase
        .from('leads')
        .update({
          ai_paused_for_zv_dispatch: true,
          funnel_locked_until: null,
        })
        .eq('id', p.leadId)
        .eq('user_id', p.userId)
      if (upPause.error) {
        const dbErr = extractDbError(upPause.error)
        console.error('[ZapVoice inbound] ERRO FATAL DB (pausa imediata da IA pós-match)', {
          code: dbErr.code,
          message: dbErr.message,
          hint: dbErr.hint,
          details: dbErr.details,
          raw: dbErr.raw,
          leadId: p.leadId,
          campaignId: matched.id,
        })
      } else {
        console.log('[ZapVoice inbound] IA PAUSADA imediatamente pós-match (ai_paused_for_zv_dispatch=true)', {
          leadId: p.leadId,
          campaignId: matched.id,
        })
      }
    } catch (caught) {
      const dbErr = extractDbError(caught)
      console.error('[ZapVoice inbound] ERRO FATAL DB (exceção na pausa imediata da IA pós-match)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        raw: dbErr.raw,
        leadId: p.leadId,
        campaignId: matched.id,
      })
    }

    const progForMatched = progressed.find((x) => x.campaign_id === matched.id)
    if (progForMatched) {
      console.log(
        '[ZapVoice inbound] gatilho + progresso da mesma campanha; segue zv_funnels (não isca)',
        matched.id,
      )
      return await handleActiveCampaignProgress(p, messageNorm, progForMatched, blockIaThisInbound(true))
    }

    const { count: doneCount, error: doneErr } = await p.supabase
      .from('lead_campaign_completions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', p.userId)
      .eq('lead_id', p.leadId)
      .eq('campaign_id', matched.id)
    if (doneErr) {
      console.error('[ZapVoice inbound] completions check', doneErr.message)
    } else if ((doneCount ?? 0) > 0) {
      console.log('[ZapVoice inbound] early return: campanha já concluída', {
        leadId: p.leadId,
        campaignId: matched.id,
      })
      return { enqueued: false, reason: 'ja_concluida', campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
    }

    // Progresso já existe para esta campanha, mas pode não estar na lista (corrida/consulta antiga): evita insert duplicado.
    const { data: progSameCamp, error: sameCampErr } = await p.supabase
      .from('lead_campaign_progress')
      .select('id, campaign_id, next_step_order, total_steps, status')
      .eq('user_id', p.userId)
      .eq('lead_id', p.leadId)
      .eq('campaign_id', matched.id)
      .in('status', ['active', 'awaiting_last_send'])
      .maybeSingle()
    if (sameCampErr) {
      console.error('[ZapVoice inbound] progress read (campanha alvo)', sameCampErr.message)
      return { enqueued: false, reason: 'erro_progresso', campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
    }
    if (progSameCamp) {
      console.log('[ZapVoice inbound] pós-gatilho: progresso encontrado por corrida; seguindo fluxo', {
        leadId: p.leadId,
        campaignId: matched.id,
        progressId: (progSameCamp as { id?: string }).id ?? null,
      })
      return await handleActiveCampaignProgress(p, messageNorm, progSameCamp as ProgressRow, blockIaThisInbound(true))
    }

    // —— Inbound "orgânico" (ex.: lead novo vindo de Meta Ads/Instagram): progresso ainda não existe p/ essa campanha ——
    // NÃO enfileirar isca Message aqui; isca só sobe pelo `activateCampaign` no painel.
    // Aqui: cria progresso + 1ª etapa do fluxo, conforme gatilho bateu nesta mensagem.
    console.log('[ZapVoice inbound] INBOUND ORGÂNICO DETECTADO (lead inédito ou sem progresso prévio para esta campanha)', {
      leadId: p.leadId,
      campaignId: matched.id,
      flowId: matched.flow_id,
      messageNorm: short(messageNorm, 160),
      trigger_condition: matched.trigger_condition,
      trigger_keyword: short(matched.trigger_keyword, 80),
    })

    if (!(await assertZvFlowOwnedByTenant(p.supabase, matched.flow_id, p.userId))) {
      console.error('[ZapVoice inbound] orgânico: fluxo não pertence ao tenant', {
        leadId: p.leadId,
        campaignId: matched.id,
        flowId: matched.flow_id,
      })
      await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_fluxo_tenant_incompativel')
      return {
        enqueued: false,
        reason: 'fluxo_tenant_incompativel',
        campaignId: matched.id,
        suppressAi: blockIaThisInbound(true),
      }
    }

    const { data: stepsRaw, error: sErr } = await p.supabase
      .from('zv_funnels')
      .select(
        'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger, min_delay_seconds, max_delay_seconds',
      )
      .eq('flow_id', matched.flow_id)
      .order('step_order', { ascending: true })

    if (sErr) {
      const dbErr = extractDbError(sErr)
      console.error('[ZapVoice inbound] ERRO FATAL DB (orgânico: select funil)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        leadId: p.leadId,
        campaignId: matched.id,
      })
      await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_select_funil_falhou')
      return { enqueued: false, reason: 'erro_funil', campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
    }

    const ordered = [...(stepsRaw ?? [])] as FunnelRow[]
    ordered.sort((a, b) => a.step_order - b.step_order)
    console.log('[ZapVoice inbound] pós-gatilho: funil carregado (orgânico)', {
      leadId: p.leadId,
      campaignId: matched.id,
      flowId: matched.flow_id,
      steps: ordered.length,
      first_step_order: ordered[0]?.step_order ?? null,
      last_step_order: ordered.length > 0 ? ordered[ordered.length - 1]!.step_order : null,
    })
    for (const s of ordered) {
      if (s.media_type !== 'text' && !s.media_url?.trim()) {
        console.warn(
          '[ZapVoice inbound] etapa com mídia sem URL, ignoro funil',
          matched.id,
          s.step_order,
        )
        await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_etapa_midia_incompleta')
        return {
          enqueued: false,
          reason: 'etapa_midia_incompleta',
          campaignId: matched.id,
          suppressAi: blockIaThisInbound(true),
        }
      }
    }

    if (ordered.length > 0) {
      const t = ordered[0]!
      if (t.media_type === 'text' && !t.message.trim()) {
        await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_etapa1_texto_vazia')
        return {
          enqueued: false,
          reason: 'etapa1_texto_vazia',
          campaignId: matched.id,
          suppressAi: blockIaThisInbound(true),
        }
      }
    }

    const leadTag = leadTagForCampaign(matched)
    const { error: upErr } = await p.supabase
      .from('leads')
      .update({ tag: leadTag })
      .eq('id', p.leadId)
      .eq('user_id', p.userId)
    if (upErr) {
      const dbErr = extractDbError(upErr)
      console.error('[ZapVoice inbound] ERRO FATAL DB (orgânico: update lead.tag)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        leadId: p.leadId,
        campaignId: matched.id,
      })
      await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_update_lead_tag_falhou')
      return { enqueued: false, reason: 'erro_lead', campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
    }

  const totalSteps = ordered.length
  const maxStepOrder = ordered.reduce((acc, s) => Math.max(acc, Number(s.step_order) || 0), 0)
  if (totalSteps > 0 && maxStepOrder > 0) {
      console.log('[ZapVoice inbound] pós-gatilho: montando insert de lead_campaign_progress (orgânico)', {
        leadId: p.leadId,
        campaignId: matched.id,
        next_step_order: ordered[0]!.step_order,
        total_steps: maxStepOrder,
      })
      const progIns = await p.supabase
        .from('lead_campaign_progress')
        .insert({
          user_id: p.userId,
          lead_id: p.leadId,
          campaign_id: matched.id,
        next_step_order: ordered[0]!.step_order,
        total_steps: maxStepOrder,
          status: 'active',
        })
        .select('id, campaign_id, next_step_order, total_steps')
        .single()
      if (progIns.error) {
        const dbErr = extractDbError(progIns.error)
        console.error('[ZapVoice inbound] ERRO FATAL DB (insert lead_campaign_progress orgânico)', {
          code: dbErr.code,
          message: dbErr.message,
          hint: dbErr.hint,
          details: dbErr.details,
          raw: dbErr.raw,
          leadId: p.leadId,
          campaignId: matched.id,
        })
        const progErrLower = String(progIns.error.message ?? '').toLowerCase()
        if (progErrLower.includes('unique') || progErrLower.includes('duplicate')) {
          const { data: p2, error: p2Err } = await p.supabase
            .from('lead_campaign_progress')
            .select('id, campaign_id, next_step_order, total_steps, status')
            .eq('user_id', p.userId)
            .eq('lead_id', p.leadId)
            .eq('campaign_id', matched.id)
            .in('status', ['active', 'awaiting_last_send'])
            .maybeSingle()
          if (!p2Err && p2) {
            return await handleActiveCampaignProgress(p, messageNorm, p2 as ProgressRow, blockIaThisInbound(true))
          }
        }
        await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_insert_progress_falhou')
        return {
          enqueued: false,
          reason: 'erro_progresso',
          campaignId: matched.id,
          suppressAi: blockIaThisInbound(true),
        }
      }
      if (progIns.data) {
        const pr = progIns.data as {
          id: string
          campaign_id: string
          next_step_order: number
          total_steps: number
        }
      const first = ordered[0] as FunnelRow
        console.log('[ZapVoice inbound] pós-gatilho: chamando enqueueFunnelStepAndAdvance (orgânico etapa 1)', {
          leadId: p.leadId,
          campaignId: matched.id,
          zv_funnel_step_id: first.id,
          step_order: first.step_order,
          media_type: first.media_type,
          delay_seconds: first.delay_seconds,
        })
        const enq1 = await enqueueFunnelStepAndAdvance({
          supabase: p.supabase,
          userId: p.userId,
          leadId: p.leadId,
          phoneDigits: p.phoneDigits,
          instanceName: p.instanceName,
          progress: {
            id: pr.id,
            campaign_id: pr.campaign_id,
            next_step_order: pr.next_step_order,
            total_steps: pr.total_steps,
          },
          step: first,
          campMin: matched.min_delay_seconds,
          campMax: matched.max_delay_seconds,
        })
        if (!enq1.enqueued) {
          console.warn('[ZapVoice inbound] orgânico: etapa 1 não enfileirada', enq1.reason)
          // O `enqueueFunnelStepAndAdvance` já chama `unlockLeadFunnelLock` em seus próprios erros,
          // mas garantimos uma camada extra aqui caso o caminho de erro não tenha passado por lá.
          await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_enqueue_etapa1_falhou')
          return {
            enqueued: false,
            reason: enq1.reason ?? 'erro_fila',
            campaignId: matched.id,
            suppressAi: blockIaThisInbound(true),
          }
        }
        console.log(
          '[ZapVoice inbound] INBOUND ORGÂNICO concluído: progresso criado + Etapa 1 enfileirada + IA suprimida',
          {
            campaignId: matched.id,
            leadId: p.leadId,
            progressId: pr.id,
            step_order_inicial: pr.next_step_order,
            total_steps: pr.total_steps,
          },
        )
        return { enqueued: true, campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
      }
    }

    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'organico_sem_etapas')
    return { enqueued: false, reason: 'sem_etapas', campaignId: matched.id, suppressAi: blockIaThisInbound(true) }
  }

  // 2) Nenhum gatilho de campanha bateu nesta mensagem.
  //    Se o lead já está em algum fluxo (progresso ativo), a IA fica suprimida
  //    enquanto o worker dispara as etapas pelo timer. Caso contrário, libera a IA.
  if (progressed.length > 0) {
    return {
      enqueued: false,
      reason: 'fluxo_em_andamento',
      campaignId: progressed[0]!.campaign_id,
      suppressAi: blockIaThisInbound(true),
    }
  }

  return { enqueued: false, reason: 'sem_match' }
}

async function enqueueFunnelStepAndAdvance(p: {
  supabase: SupabaseClient
  userId: string
  leadId: string
  phoneDigits: string
  instanceName: string
  progress: {
    id: string
    campaign_id: string
    next_step_order: number
    total_steps: number
  }
  step: FunnelRow
  campMin: number | null | undefined
  campMax: number | null | undefined
}): Promise<ZapVoiceInboundResult> {
  console.log('[ZapVoice inbound] Montando insert da fila (scheduled_messages)', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    progressId: p.progress.id,
    zv_funnel_step_id: p.step.id,
    step_order: p.step.step_order,
    media_type: p.step.media_type,
    delay_seconds: p.step.delay_seconds,
  })

  const nowMs = Date.now()
  const delayS = funnelStepDelaySeconds(p.step)
  let scheduledIso: string
  try {
    const t = nowMs + delayS * 1000
    if (!Number.isFinite(t)) throw new Error('scheduled_at_invalido')
    scheduledIso = new Date(t).toISOString()
  } catch {
    console.error('[ZapVoice inbound] scheduled_at invalido delayS=', delayS)
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'delay_invalid')
    return {
      enqueued: false,
      reason: 'erro_agendamento_invalido',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  const ct = p.step.media_type
  const mUrl = ct === 'text' ? null : p.step.media_url?.trim() ?? null

  if (ct === 'text' && !String(p.step.message ?? '').trim()) {
    console.error('[ZapVoice inbound] early return: etapa de texto sem message_body', {
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
      zv_funnel_step_id: p.step.id,
      step_order: p.step.step_order,
    })
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'texto_sem_message_body')
    return {
      enqueued: false,
      reason: 'etapa_texto_vazia',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }
  if (ct !== 'text' && !mUrl) {
    console.error('[ZapVoice inbound] early return: etapa de mídia sem media_url', {
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
      zv_funnel_step_id: p.step.id,
      step_order: p.step.step_order,
      media_type: ct,
    })
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'midia_sem_url')
    return {
      enqueued: false,
      reason: 'etapa_midia_incompleta',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  if (!p.step.id?.trim()) {
    console.error('[ZapVoice inbound] etapa sem id', p.progress.campaign_id)
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'sem_zv_funnel_step_id')
    return {
      enqueued: false,
      reason: 'etapa_sem_id',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  const ord = Number(p.step.step_order)
  const delayPair = pairDelaySnapshotForQueue({
    step: p.step,
    campMin: p.campMin,
    campMax: p.campMax,
  })

  const insertPayload = {
    user_id: p.userId,
    lead_id: p.leadId,
    zv_campaign_id: p.progress.campaign_id,
    zv_funnel_step_id: p.step.id,
    zv_funnel_step_order: Number.isFinite(ord) ? ord : null,
    is_active: true,
    recipient_type: 'personal' as const,
    content_type: ct,
    message_body: ct === 'text' ? (p.step.message ?? null) : (p.step.message ?? null),
    media_url: mUrl,
    scheduled_at: scheduledIso,
    status: 'pending' as const,
    recipient_phone: p.phoneDigits?.trim() || null,
    event_id: null,
    evolution_instance_name: p.instanceName?.trim() || null,
    min_delay_seconds: delayPair.min,
    max_delay_seconds: delayPair.max,
  }

  // Pré-flight: campos OBRIGATÓRIOS do schema. Se algum vier vazio, abortamos com log forense
  // (em vez de deixar o PostgREST devolver 400 que pode ser confundido com timeout/rede).
  const requiredKeys = ['user_id', 'lead_id', 'zv_campaign_id', 'zv_funnel_step_id', 'scheduled_at', 'content_type']
  const missing = findMissingRequired(insertPayload as Record<string, unknown>, requiredKeys)
  if (missing.length > 0) {
    console.error('[ZapVoice inbound] ERRO FATAL DB (pré-flight): payload incompleto p/ scheduled_messages', {
      missing,
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
      zv_funnel_step_id: p.step.id,
      ord,
      ct,
      hasMessageBody: Boolean(String(p.step.message ?? '').trim()),
      hasMediaUrl: Boolean(mUrl),
      delayPair,
    })
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'payload_incompleto')
    return {
      enqueued: false,
      reason: 'payload_incompleto',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  console.log('[ZapVoice inbound] Insert preparado para scheduled_messages', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    scheduled_at: scheduledIso,
    content_type: ct,
    has_message_body: ct === 'text' ? Boolean(String(p.step.message ?? '').trim()) : null,
    has_media_url: ct !== 'text' ? Boolean(mUrl) : null,
    recipient_phone: p.phoneDigits?.trim() ? 'ok' : 'null',
    evolution_instance_name: p.instanceName?.trim() ? 'ok' : 'null',
    delayPair,
    payloadKeys: Object.keys(insertPayload),
  })

  // Insert isolado em try/catch para capturar QUALQUER falha (rede, timeout, RLS, etc.).
  let insertedId: string | null = null
  try {
    const ins = await p.supabase
      .from('scheduled_messages')
      .insert(insertPayload)
      .select('id')
      .single()
    if (ins.error) {
      const dbErr = extractDbError(ins.error)
      console.error('[ZapVoice inbound] ERRO FATAL DB (insert scheduled_messages)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        raw: dbErr.raw,
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
        zv_funnel_step_id: p.step.id,
        ord,
        ct,
        delayPair,
      })
      await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'insert_fila_falhou')
      return {
        enqueued: false,
        reason: 'erro_fila',
        campaignId: p.progress.campaign_id,
        suppressAi: false,
      }
    }
    insertedId = (ins.data as { id?: string } | null)?.id ?? null
    if (!insertedId) {
      console.error('[ZapVoice inbound] ERRO FATAL DB: insert sem id retornado', {
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
      })
      await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'insert_sem_id')
      return {
        enqueued: false,
        reason: 'insert_sem_id',
        campaignId: p.progress.campaign_id,
        suppressAi: false,
      }
    }
  } catch (caught) {
    const dbErr = extractDbError(caught)
    console.error('[ZapVoice inbound] ERRO FATAL DB (exceção no insert scheduled_messages)', {
      code: dbErr.code,
      message: dbErr.message,
      hint: dbErr.hint,
      details: dbErr.details,
      raw: dbErr.raw,
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
      zv_funnel_step_id: p.step.id,
    })
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'insert_excecao')
    return {
      enqueued: false,
      reason: 'erro_fila',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  // Defesa em profundidade: relê a linha que acabou de ser criada para garantir que ela existe.
  try {
    const { data: relido, error: relidoErr } = await p.supabase
      .from('scheduled_messages')
      .select('id, status, scheduled_at, lead_id, zv_campaign_id, zv_funnel_step_id')
      .eq('id', insertedId)
      .eq('user_id', p.userId)
      .maybeSingle()
    if (relidoErr) {
      const dbErr = extractDbError(relidoErr)
      console.error('[ZapVoice inbound] ERRO FATAL DB: re-leitura pós-insert falhou', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
        insertedId,
      })
    } else if (!relido) {
      console.error('[ZapVoice inbound] ERRO FATAL DB: linha não encontrada após insert (sucesso fantasma)', {
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
        insertedId,
      })
    } else {
      console.log('[ZapVoice inbound] Fila agendada com sucesso (insert OK + re-lido)', {
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
        insertedId,
        status: (relido as { status?: string }).status,
        scheduled_at: (relido as { scheduled_at?: string }).scheduled_at,
      })
    }
  } catch (caught) {
    const dbErr = extractDbError(caught)
    console.error('[ZapVoice inbound] ERRO FATAL DB (exceção na re-leitura pós-insert)', {
      code: dbErr.code,
      message: dbErr.message,
      hint: dbErr.hint,
      details: dbErr.details,
      raw: dbErr.raw,
      insertedId,
    })
  }

  // Próxima etapa precisa ser a PRÓXIMA step_order existente (não "ord+1"), senão o fluxo trava com step_order não sequencial.
  const { data: campFlowRow, error: campFlowErr } = await p.supabase
    .from('zv_campaigns')
    .select('flow_id')
    .eq('user_id', p.userId)
    .eq('id', p.progress.campaign_id)
    .maybeSingle()
  if (campFlowErr) {
    console.warn('[ZapVoice inbound] não consegui ler flow_id para avançar ponteiro', campFlowErr.message, {
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
    })
  }
  const flowId = (campFlowRow as { flow_id?: string } | null)?.flow_id ?? null
  let nextExistingOrder: number | null = null
  if (flowId && Number.isFinite(ord)) {
    if (!(await assertZvFlowOwnedByTenant(p.supabase, flowId, p.userId))) {
      console.warn('[ZapVoice inbound] avanço ponteiro: fluxo não pertence ao tenant', {
        leadId: p.leadId,
        flowId,
      })
    } else {
      const { data: nextStep, error: nextStepErr } = await p.supabase
        .from('zv_funnels')
        .select('step_order')
        .eq('flow_id', flowId)
        .gt('step_order', ord)
        .order('step_order', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (nextStepErr) {
        console.warn('[ZapVoice inbound] falha ao buscar próxima etapa existente', nextStepErr.message, {
          leadId: p.leadId,
          campaignId: p.progress.campaign_id,
          flowId,
          ord,
        })
      } else if (nextStep) {
        nextExistingOrder = Number((nextStep as { step_order?: number }).step_order ?? NaN)
        if (!Number.isFinite(nextExistingOrder)) nextExistingOrder = null
      }
    }
  }

  const fallbackNext = (Number(p.step.step_order) || Number(p.progress.next_step_order) || 0) + 1
  const nextOrder = nextExistingOrder ?? fallbackNext
  const isLastEnqueued = nextExistingOrder == null
  console.log('[ZapVoice inbound] avançando ponteiro do progresso', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    flowId,
    current_step_order: Number.isFinite(ord) ? ord : null,
    nextExistingOrder,
    next_step_order_aplicado: nextOrder,
    isLastEnqueued,
  })

  try {
    const up = await p.supabase
      .from('lead_campaign_progress')
      .update({
        next_step_order: nextOrder,
        status: isLastEnqueued ? 'awaiting_last_send' : 'active',
      })
      .eq('id', p.progress.id)
      .eq('user_id', p.userId)
    if (up.error) {
      const dbErr = extractDbError(up.error)
      console.error('[ZapVoice inbound] ERRO FATAL DB (update lead_campaign_progress)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        raw: dbErr.raw,
        progressId: p.progress.id,
        leadId: p.leadId,
        campaignId: p.progress.campaign_id,
        nextOrder,
        isLastEnqueued,
      })
      // Mantém retorno como sucesso pois a fila JÁ foi enfileirada — ponteiro fica desalinhado, e o worker logará.
    }
  } catch (caught) {
    const dbErr = extractDbError(caught)
    console.error('[ZapVoice inbound] ERRO FATAL DB (exceção no update lead_campaign_progress)', {
      code: dbErr.code,
      message: dbErr.message,
      hint: dbErr.hint,
      details: dbErr.details,
      raw: dbErr.raw,
      progressId: p.progress.id,
      leadId: p.leadId,
      campaignId: p.progress.campaign_id,
    })
  }

  try {
    const upLead = await p.supabase
      .from('leads')
      .update({
        ai_paused_for_zv_dispatch: true,
        funnel_locked_until: null,
      })
      .eq('id', p.leadId)
      .eq('user_id', p.userId)
    if (upLead.error) {
      const dbErr = extractDbError(upLead.error)
      console.error('[ZapVoice inbound] ERRO FATAL DB (update leads ai_paused)', {
        code: dbErr.code,
        message: dbErr.message,
        hint: dbErr.hint,
        details: dbErr.details,
        raw: dbErr.raw,
        leadId: p.leadId,
      })
    }
  } catch (caught) {
    const dbErr = extractDbError(caught)
    console.error('[ZapVoice inbound] ERRO FATAL DB (exceção no update leads)', {
      code: dbErr.code,
      message: dbErr.message,
      hint: dbErr.hint,
      details: dbErr.details,
      raw: dbErr.raw,
      leadId: p.leadId,
    })
  }

  console.log('[ZapVoice inbound] pós-fila: lead AI suprimida e progresso atualizado', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    progressId: p.progress.id,
  })
  return {
    enqueued: true,
    campaignId: p.progress.campaign_id,
    reason: 'avancou',
    suppressAi: true,
  }
}
