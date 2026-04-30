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

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
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

/** Se a Etapa 1 não entra em `scheduled_messages`, não deixamos o lead preso sem IA. */
async function unlockLeadFunnelLock(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  context: string,
): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ funnel_locked_until: null })
    .eq('id', leadId)
    .eq('user_id', userId)
  if (error) {
    console.error(`[ZapVoice inbound] funnel unlock (${context}):`, error.message)
    return
  }
  console.warn(`[ZapVoice inbound] funnel unlock (${context}) lead=${leadId}`)
}

type ProgressRow = {
  id: string
  campaign_id: string
  next_step_order: number
  total_steps: number
  status: 'active' | 'awaiting_last_send'
}

/** Resposta do lead com progresso ativo: avança o fluxo (nunca reenvia isca). */
async function handleActiveCampaignProgress(
  p: ZapVoiceInboundParams,
  messageNorm: string,
  progress: ProgressRow,
): Promise<ZapVoiceInboundResult> {
  if (progress.status === 'awaiting_last_send') {
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
  const camp = campRow as
    | (Pick<
        CampaignRow,
        'id' | 'flow_id' | 'trigger_keyword' | 'trigger_condition' | 'min_delay_seconds' | 'max_delay_seconds'
      > & { trigger_condition?: string })
    | null
  if (!camp?.flow_id) {
    return { enqueued: false, reason: 'campanha_sem_fluxo', campaignId: progress.campaign_id, suppressAi: true }
  }

  const cond = (camp.trigger_condition ?? 'equals') as TriggerCondition
  const flowId = camp.flow_id

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

  if (progress.total_steps === 0) {
    const slotFluxoVazio = Number.isFinite(primeiraOrdem) ? primeiraOrdem : 1
    if (Number.isFinite(progressNext) && progressNext === slotFluxoVazio) {
      if (triggerConditionSatisfied(cond, messageNorm, camp.trigger_keyword ?? '')) {
        await p.supabase.from('lead_campaign_completions').insert({
          user_id: p.userId,
          lead_id: p.leadId,
          campaign_id: progress.campaign_id,
        })
        await p.supabase.from('lead_campaign_progress').delete().eq('id', progress.id)
      }
      return { enqueued: false, reason: 'fluxo_vazio', campaignId: progress.campaign_id, suppressAi: true }
    }
  }

  const isPrimeiraEtapaPosIsca =
    Number.isFinite(primeiraOrdem) &&
    primeiraEtapaRaw != null &&
    Number.isFinite(progressNext) &&
    progressNext === primeiraOrdem

  if (isPrimeiraEtapaPosIsca) {
    // Modelo simplificado: o gatilho VALE só aqui (palavra-chave da campanha).
    // A partir desta etapa, todo o fluxo segue automaticamente pelo timer
    // (worker enfileira as próximas etapas).
    const step = primeiraEtapaRaw as FunnelRow
    if (!triggerConditionSatisfied(cond, messageNorm, camp.trigger_keyword ?? '')) {
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
    return {
      enqueued: false,
      reason: 'sem_proximo_passo',
      campaignId: progress.campaign_id,
      suppressAi: true,
    }
  }

  // Lead já está dentro do fluxo (etapa 2+): NÃO avançamos por mensagem do lead.
  // O worker (process-scheduled-messages) cuida do timer e enfileira as próximas
  // etapas automaticamente. Aqui só garantimos que a IA permaneça suprimida.
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

  const { data: progList, error: progErr } = await p.supabase
    .from('lead_campaign_progress')
    .select('id, campaign_id, next_step_order, total_steps, status, updated_at')
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .in('status', ['active', 'awaiting_last_send'])
    .order('updated_at', { ascending: false })
    .limit(25)

  if (progErr) {
    console.error('[ZapVoice inbound] progress read', progErr.message)
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

  let matched: CampaignRow | null = null
  for (const row of (campaigns ?? []) as CampaignRow[]) {
    const cond = (row.trigger_condition ?? 'equals') as TriggerCondition
    if (triggerConditionSatisfied(cond, messageNorm, row.trigger_keyword ?? '')) {
      matched = row
      break
    }
  }

  // 1) Gatilho de campanha bateu → prioriza SEMPRE o progresso dessa campanha (evita prog de outro funil “roubar” a mensagem).
  if (matched) {
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
      return { enqueued: false, reason: 'ja_concluida', campaignId: matched.id, suppressAi: true }
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

    const startMs = Date.now()
  const totalSteps = ordered.length
  const maxStepOrder = ordered.reduce((acc, s) => Math.max(acc, Number(s.step_order) || 0), 0)
  if (totalSteps > 0 && maxStepOrder > 0) {
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
        if (String(progIns.error.message ?? '').toLowerCase().includes('unique')) {
          const { data: p2 } = await p.supabase
            .from('lead_campaign_progress')
            .select('id, campaign_id, next_step_order, total_steps, status, updated_at')
            .eq('user_id', p.userId)
            .eq('lead_id', p.leadId)
            .eq('campaign_id', matched.id)
            .in('status', ['active', 'awaiting_last_send'])
            .order('updated_at', { ascending: false })
            .limit(1)
          if (p2?.[0]) {
            return await handleActiveCampaignProgress(p, messageNorm, p2[0] as ProgressRow)
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
        const lockUntilIso = new Date(startMs + 6 * 60 * 60 * 1000).toISOString()
        await p.supabase
          .from('leads')
          .update({ funnel_locked_until: lockUntilIso })
          .eq('id', p.leadId)
          .eq('user_id', p.userId)
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
    min_delay_seconds:
      typeof p.step.min_delay_seconds === 'number'
        ? p.step.min_delay_seconds
        : p.campMin ?? null,
    max_delay_seconds:
      typeof p.step.max_delay_seconds === 'number'
        ? p.step.max_delay_seconds
        : p.campMax ?? null,
  })
  if (ins.error) {
    console.error('[ZapVoice inbound] enqueue scheduled_messages', ins.error.code, ins.error.message)
    await unlockLeadFunnelLock(p.supabase, p.userId, p.leadId, 'insert_fila_falhou')
    return {
      enqueued: false,
      reason: 'erro_fila',
      campaignId: p.progress.campaign_id,
      suppressAi: false,
    }
  }

  const nextOrder = (Number(p.step.step_order) || Number(p.progress.next_step_order)) + 1
  const isLastEnqueued = nextOrder > p.progress.total_steps
  const up = await p.supabase
    .from('lead_campaign_progress')
    .update({
      next_step_order: nextOrder,
      status: isLastEnqueued ? 'awaiting_last_send' : 'active',
    })
    .eq('id', p.progress.id)
  if (up.error) {
    console.error('[ZapVoice inbound] progress update', up.error.message)
  }

  const lockUntilIso = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString()
  await p.supabase
    .from('leads')
    .update({ funnel_locked_until: lockUntilIso })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)

  return { enqueued: true, campaignId: p.progress.campaign_id, reason: 'avancou', suppressAi: true }
}
