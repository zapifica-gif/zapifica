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
function triggerConditionSatisfied(
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

/** Libera a IA do lead se não há mais Zap Voice pendente/processando nem progresso ativo. */
async function maybeReleaseLeadZvAiDispatchPause(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  context: string,
): Promise<void> {
  const [{ count: pend, error: pe }, { count: progCt, error: pgE }] = await Promise.all([
    supabase
      .from('scheduled_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .not('zv_campaign_id', 'is', null)
      .in('status', ['pending', 'processing'])
      .eq('is_active', true),
    supabase
      .from('lead_campaign_progress')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .in('status', ['active', 'awaiting_last_send']),
  ])
  if (pe || pgE) {
    console.warn(`[ZapVoice inbound] release pause (${context}):`, pe?.message ?? pgE?.message)
    return
  }
  if ((pend ?? 0) !== 0 || (progCt ?? 0) !== 0) return
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
  status: 'active' | 'awaiting_last_send'
}

function short(s: string | null | undefined, n = 120): string {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return `${t.slice(0, n)}…`
}

/** Resposta do lead com progresso ativo: avança o fluxo (nunca reenvia isca). */
async function handleActiveCampaignProgress(
  p: ZapVoiceInboundParams,
  messageNorm: string,
  progress: ProgressRow,
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
      suppressAi: true,
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
    return { enqueued: false, reason: 'campanha_sem_fluxo', campaignId: progress.campaign_id, suppressAi: true }
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
      suppressAi: true,
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
      if (triggerConditionSatisfied(cond, messageNorm, camp.trigger_keyword ?? '')) {
        console.log('[ZapVoice inbound] fluxo vazio: gatilho bateu; marcando conclusão', {
          leadId: p.leadId,
          campaignId: progress.campaign_id,
        })
        await p.supabase.from('lead_campaign_completions').insert({
          user_id: p.userId,
          lead_id: p.leadId,
          campaign_id: progress.campaign_id,
        })
        await p.supabase.from('lead_campaign_progress').delete().eq('id', progress.id)
      }
      console.log('[ZapVoice inbound] early return: fluxo vazio', {
        leadId: p.leadId,
        campaignId: progress.campaign_id,
      })
      return { enqueued: false, reason: 'fluxo_vazio', campaignId: progress.campaign_id, suppressAi: true }
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
    if (!triggerConditionSatisfied(cond, messageNorm, camp.trigger_keyword ?? '')) {
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
        suppressAi: true,
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
      suppressAi: true,
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
    suppressAi: true,
  }
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

  const messageNorm = normText(raw)
  console.log('[ZapVoice inbound] inbound recebido (texto normalizado)', {
    leadId: p.leadId,
    instanceName: p.instanceName,
    phoneDigits: p.phoneDigits,
    messageRaw: short(raw, 160),
    messageNorm: short(messageNorm, 160),
  })

  // Ordena por created_at (sempre existe); updated_at pode faltar em bancos com drift até rodar migration.
  const { data: progList, error: progErr } = await p.supabase
    .from('lead_campaign_progress')
    .select('id, campaign_id, next_step_order, total_steps, status, created_at')
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .in('status', ['active', 'awaiting_last_send'])
    .order('created_at', { ascending: false })
    .limit(25)

  if (progErr) {
    console.error('[ZapVoice inbound] progress read', progErr.message)
    return { enqueued: false, reason: 'erro_progresso', suppressAi: true }
  }

  const progressed = (progList ?? []) as ProgressRow[]

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
    return { enqueued: false, reason: 'erro_listagem', suppressAi: true }
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
    if (triggerConditionSatisfied(cond, messageNorm, row.trigger_keyword ?? '')) {
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
      if (triggerConditionSatisfied(cond, messageNorm, row.trigger_keyword ?? '')) {
        matched = row
        console.log('[ZapVoice inbound] gatilho casou na listagem global de campanhas', {
          campaignId: row.id,
          leadId: p.leadId,
        })
        break
      }
    }
  }

  // 1) Gatilho de campanha bateu → prioriza SEMPRE o progresso dessa campanha (evita prog de outro funil “roubar” a mensagem).
  if (matched) {
    console.log('[ZapVoice inbound] GATILHO RECONHECIDO: campanha selecionada', {
      leadId: p.leadId,
      campaignId: matched.id,
      flowId: matched.flow_id,
      trigger_condition: matched.trigger_condition,
      trigger_keyword: short(matched.trigger_keyword, 80),
    })
    const progForMatched = progressed.find((x) => x.campaign_id === matched.id)
    if (progForMatched) {
      console.log(
        '[ZapVoice inbound] gatilho + progresso da mesma campanha; segue zv_funnels (não isca)',
        matched.id,
      )
      return await handleActiveCampaignProgress(p, messageNorm, progForMatched)
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
      return { enqueued: false, reason: 'ja_concluida', campaignId: matched.id, suppressAi: true }
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
      return { enqueued: false, reason: 'erro_progresso', campaignId: matched.id, suppressAi: true }
    }
    if (progSameCamp) {
      console.log('[ZapVoice inbound] pós-gatilho: progresso encontrado por corrida; seguindo fluxo', {
        leadId: p.leadId,
        campaignId: matched.id,
        progressId: (progSameCamp as { id?: string }).id ?? null,
      })
      return await handleActiveCampaignProgress(p, messageNorm, progSameCamp as ProgressRow)
    }

    // —— Inbound "orgânico": progresso ainda não existe p/ essa campanha (p.ex. gatilho sem ativação prévia) ——
    // NÃO enfileirar isca Message aqui; isca só sobe pelo `activateCampaign` no painel.
    // Aqui: cria progresso + 1ª etapa do fluxo, conforme gatilho bateu nesta mensagem.
    const { data: stepsRaw, error: sErr } = await p.supabase
      .from('zv_funnels')
      .select(
        'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger, min_delay_seconds, max_delay_seconds',
      )
      .eq('flow_id', matched.flow_id)
      .order('step_order', { ascending: true })

    if (sErr) {
      console.error('[ZapVoice inbound] funil', sErr.message)
      return { enqueued: false, reason: 'erro_funil', campaignId: matched.id, suppressAi: true }
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
        return {
          enqueued: false,
          reason: 'etapa_midia_incompleta',
          campaignId: matched.id,
          suppressAi: true,
        }
      }
    }

    if (ordered.length > 0) {
      const t = ordered[0]!
      if (t.media_type === 'text' && !t.message.trim()) {
        return {
          enqueued: false,
          reason: 'etapa1_texto_vazia',
          campaignId: matched.id,
          suppressAi: true,
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
      console.error('[ZapVoice inbound] update lead', upErr.message)
      return { enqueued: false, reason: 'erro_lead', campaignId: matched.id, suppressAi: true }
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
        console.error('[ZapVoice inbound] progress insert (inbound orgânico)', progIns.error.message)
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
            return await handleActiveCampaignProgress(p, messageNorm, p2 as ProgressRow)
          }
        }
        return {
          enqueued: false,
          reason: 'erro_progresso',
          campaignId: matched.id,
          suppressAi: true,
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
          return {
            enqueued: false,
            reason: enq1.reason ?? 'erro_fila',
            campaignId: matched.id,
            suppressAi: enq1.suppressAi !== false,
          }
        }
        console.log(
          '[ZapVoice inbound] orgânico: progresso+etapa1 (sem isca; isca=apenas do painel)',
          {
            campaignId: matched.id,
            leadId: p.leadId,
          },
        )
        return { enqueued: true, campaignId: matched.id, suppressAi: true }
      }
    }

    return { enqueued: false, reason: 'sem_etapas', campaignId: matched.id, suppressAi: true }
  }

  // 2) Nenhum gatilho de campanha bateu nesta mensagem.
  //    Se o lead já está em algum fluxo (progresso ativo), a IA fica suprimida
  //    enquanto o worker dispara as etapas pelo timer. Caso contrário, libera a IA.
  if (progressed.length > 0) {
    return {
      enqueued: false,
      reason: 'fluxo_em_andamento',
      campaignId: progressed[0]!.campaign_id,
      suppressAi: true,
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
  })

  const ins = await p.supabase.from('scheduled_messages').insert({
    user_id: p.userId,
    lead_id: p.leadId,
    zv_campaign_id: p.progress.campaign_id,
    zv_funnel_step_id: p.step.id,
    zv_funnel_step_order: Number.isFinite(ord) ? ord : null,
    is_active: true,
    recipient_type: 'personal',
    content_type: ct,
    message_body: p.step.message ?? null,
    media_url: mUrl,
    scheduled_at: scheduledIso,
    status: 'pending',
    recipient_phone: p.phoneDigits?.trim() || null,
    event_id: null,
    evolution_instance_name: p.instanceName?.trim() || null,
    min_delay_seconds: delayPair.min,
    max_delay_seconds: delayPair.max,
  })
  if (ins.error) {
    console.error(
      '[ZapVoice inbound] enqueue scheduled_messages',
      ins.error.code,
      ins.error.message,
      {
        campaignId: p.progress.campaign_id,
        leadId: p.leadId,
        zv_funnel_step_id: p.step.id,
        delayPair,
      },
    )
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'insert_fila_falhou')
    return {
      enqueued: false,
      reason: 'erro_fila',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  console.log('[ZapVoice inbound] Fila agendada com sucesso (insert OK)', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    zv_funnel_step_id: p.step.id,
    step_order: Number.isFinite(ord) ? ord : null,
  })

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
  const up = await p.supabase
    .from('lead_campaign_progress')
    .update({
      next_step_order: nextOrder,
      status: isLastEnqueued ? 'awaiting_last_send' : 'active',
    })
    .eq('id', p.progress.id)
  if (up.error) {
    console.error('[ZapVoice inbound] progress update APÓS insert na fila', up.error.message, {
      progressId: p.progress.id,
      nextOrder,
      isLastEnqueued,
    })
  }

  await p.supabase
    .from('leads')
    .update({
      ai_paused_for_zv_dispatch: true,
      funnel_locked_until: null,
    })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)

  console.log('[ZapVoice inbound] pós-fila: lead AI suprimida e progresso atualizado', {
    leadId: p.leadId,
    campaignId: p.progress.campaign_id,
    progressId: p.progress.id,
  })
  return { enqueued: true, campaignId: p.progress.campaign_id, reason: 'avancou', suppressAi: true }
}
