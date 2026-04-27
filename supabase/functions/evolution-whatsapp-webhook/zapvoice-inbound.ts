// Gatilhos Zap Voice (inbound) — campanha (isca + gatilho) + fluxo (etapas em zv_funnels)
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

type CampaignRow = {
  id: string
  name: string
  flow_id: string
  isca_message: string
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

function firstNameFromFullName(full: string): string {
  const t = full.trim()
  if (!t) return 'Cliente'
  return t.split(/\s+/)[0] ?? t
}

function cityFromExtractionLocation(loc: string | null | undefined): string {
  if (!loc) return ''
  return loc.split(',')[0]?.trim() ?? ''
}

type TemplateVars = { nome: string; empresa: string; cidade: string }

function applyMessageTemplate(template: string, vars: TemplateVars): string {
  return template
    .replaceAll('{nome}', vars.nome)
    .replaceAll('{empresa}', vars.empresa)
    .replaceAll('{cidade}', vars.cidade)
}

function leadTagForCampaign(c: CampaignRow): string {
  const tags = c.audience_tags?.map((t) => t.trim()).filter(Boolean) ?? []
  if (tags.length > 0) return tags[0]!
  const n = c.name?.trim() || 'Campanha'
  return `Gatilho Meta — ${n.slice(0, 60)}`
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

  const { data: prog, error: progErr } = await p.supabase
    .from('lead_campaign_progress')
    .select('id, campaign_id, next_step_order, total_steps, status')
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .in('status', ['active', 'awaiting_last_send'])
    .maybeSingle()

  if (progErr) {
    console.error('[ZapVoice inbound] progress read', progErr.message)
  }

  if (prog && typeof (prog as { campaign_id?: string }).campaign_id === 'string') {
    const progress = prog as {
      id: string
      campaign_id: string
      next_step_order: number
      total_steps: number
      status: 'active' | 'awaiting_last_send'
    }

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

    // Pós-isca, aguardando 1ª etapa do fluxo (next=1) → só gatilho da campanha
    if (progress.next_step_order === 1) {
      if (progress.total_steps === 0) {
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

      if (
        !triggerConditionSatisfied(cond, messageNorm, camp.trigger_keyword ?? '')
      ) {
        return { enqueued: false, reason: 'gatilho_nao_bateu', campaignId: progress.campaign_id, suppressAi: true }
      }

      const { data: firstStep, error: s1Err } = await p.supabase
        .from('zv_funnels')
        .select(
          'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger, min_delay_seconds, max_delay_seconds',
        )
        .eq('flow_id', flowId)
        .eq('step_order', 1)
        .maybeSingle()

      if (s1Err) {
        console.error('[ZapVoice inbound] first flow step', s1Err.message)
        return { enqueued: false, reason: 'erro_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
      }
      if (!firstStep) {
        return { enqueued: false, reason: 'sem_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
      }

      return await enqueueFunnelStepAndAdvance({
        supabase: p.supabase,
        userId: p.userId,
        leadId: p.leadId,
        phoneDigits: p.phoneDigits,
        instanceName: p.instanceName,
        progress,
        step: firstStep as FunnelRow,
        campMin: camp.min_delay_seconds,
        campMax: camp.max_delay_seconds,
      })
    }

    // Passos 2+ do fluxo
    const { data: stepRow, error: stepErr } = await p.supabase
      .from('zv_funnels')
      .select(
        'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger, min_delay_seconds, max_delay_seconds',
      )
      .eq('flow_id', flowId)
      .eq('step_order', progress.next_step_order)
      .maybeSingle()

    if (stepErr) {
      console.error('[ZapVoice inbound] next step', stepErr.message)
      return { enqueued: false, reason: 'erro_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
    }
    if (!stepRow) {
      return { enqueued: false, reason: 'sem_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
    }

    const step = stepRow as FunnelRow
    const adv = (step.advance_type ?? 'auto') as 'auto' | 'exact' | 'timer'
    if (adv === 'timer') {
      return {
        enqueued: false,
        reason: 'timer_sem_interacao',
        campaignId: progress.campaign_id,
        suppressAi: true,
      }
    }

    const mustBeExact = adv === 'exact'
    const expectedNorm = normText(step.expected_trigger ?? '')
    const allowAdvance = mustBeExact
      ? Boolean(expectedNorm) && messageNorm === expectedNorm
      : true

    if (!allowAdvance) {
      return { enqueued: false, reason: 'gatilho_nao_bateu', campaignId: progress.campaign_id, suppressAi: true }
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

  // Cold start: campanha ativa que casa gatilho
  const { data: campaigns, error: cErr } = await p.supabase
    .from('zv_campaigns')
    .select(
      'id, name, flow_id, isca_message, audience_tags, trigger_keyword, trigger_condition, min_delay_seconds, max_delay_seconds, created_at',
    )
    .eq('user_id', p.userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (cErr) {
    console.error('[ZapVoice inbound] list campaigns', cErr.message)
    return { enqueued: false, reason: 'erro_listagem' }
  }

  let matched: CampaignRow | null = null
  for (const row of (campaigns ?? []) as CampaignRow[]) {
    const cond = (row.trigger_condition ?? 'equals') as TriggerCondition
    if (triggerConditionSatisfied(cond, messageNorm, row.trigger_keyword ?? '')) {
      matched = row
      break
    }
  }

  if (!matched) {
    return { enqueued: false, reason: 'sem_match' }
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

  const { count: pendingCount, error: dupErr } = await p.supabase
    .from('scheduled_messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', p.userId)
    .eq('lead_id', p.leadId)
    .eq('zv_campaign_id', matched.id)
    .eq('status', 'pending')

  if (dupErr) {
    console.error('[ZapVoice inbound] duplicate check', dupErr.message)
    return { enqueued: false, reason: 'erro_dedup' }
  }
  if ((pendingCount ?? 0) > 0) {
    return { enqueued: false, reason: 'ja_na_fila', campaignId: matched.id }
  }

  const { data: stepsRaw, error: sErr } = await p.supabase
    .from('zv_funnels')
    .select('id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger')
    .eq('flow_id', matched.flow_id)
    .order('step_order', { ascending: true })

  if (sErr) {
    console.error('[ZapVoice inbound] funil', sErr.message)
    return { enqueued: false, reason: 'erro_funil' }
  }

  const ordered = [...(stepsRaw ?? [])] as FunnelRow[]
  ordered.sort((a, b) => a.step_order - b.step_order)
  for (const s of ordered) {
    if (s.media_type !== 'text' && !s.media_url?.trim()) {
      console.warn('[ZapVoice inbound] etapa com mídia sem URL, ignoro funil', matched.id, s.step_order)
      return { enqueued: false, reason: 'etapa_midia_incompleta' }
    }
  }

  const isca = (matched.isca_message ?? '').trim()
  if (!isca) {
    return { enqueued: false, reason: 'isca_vazia' }
  }

  const leadTag = leadTagForCampaign(matched)

  const { error: upErr } = await p.supabase
    .from('leads')
    .update({ source: 'meta_ads', tag: leadTag })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)

  if (upErr) {
    console.error('[ZapVoice inbound] update lead', upErr.message)
    return { enqueued: false, reason: 'erro_lead' }
  }

  const { data: lead, error: lErr } = await p.supabase
    .from('leads')
    .select('id, name, phone, tag, extraction_id')
    .eq('id', p.leadId)
    .eq('user_id', p.userId)
    .maybeSingle()

  if (lErr || !lead) {
    return { enqueued: false, reason: 'lead_nao_recarregado' }
  }

  const L = lead as {
    id: string
    name: string
    phone: string | null
    tag: string | null
    extraction_id: string | null
  }

  let loc: string | null = null
  if (L.extraction_id) {
    const { data: ex } = await p.supabase
      .from('lead_extractions')
      .select('location')
      .eq('id', L.extraction_id)
      .eq('user_id', p.userId)
      .maybeSingle()
    const location = (ex as { location: string | null } | null)?.location
    if (location) loc = location
  }

  const vars: TemplateVars = {
    nome: firstNameFromFullName(L.name),
    empresa: L.name.trim() || 'sua empresa',
    cidade: cityFromExtractionLocation(loc),
  }
  const messageBody = applyMessageTemplate(isca, vars)

  const startMs = Date.now()
  const scheduledAt = new Date(startMs).toISOString()

  const ins1 = await p.supabase.from('scheduled_messages').insert({
    user_id: p.userId,
    lead_id: p.leadId,
    zv_campaign_id: matched.id,
    zv_funnel_step_id: null,
    is_active: true,
    recipient_type: 'personal',
    content_type: 'text',
    message_body: messageBody || null,
    media_url: null,
    scheduled_at: scheduledAt,
    status: 'pending',
    recipient_phone: L.phone ?? p.phoneDigits,
    event_id: null,
    evolution_instance_name: p.instanceName,
    min_delay_seconds:
      typeof matched.min_delay_seconds === 'number' ? matched.min_delay_seconds : null,
    max_delay_seconds:
      typeof matched.max_delay_seconds === 'number' ? matched.max_delay_seconds : null,
  })
  if (ins1.error) {
    console.error('[ZapVoice inbound] enqueue isca', ins1.error.message)
    return { enqueued: false, reason: 'erro_fila' }
  }

  const totalSteps = ordered.length
  if (totalSteps > 0) {
    const progIns = await p.supabase.from('lead_campaign_progress').insert({
      user_id: p.userId,
      lead_id: p.leadId,
      campaign_id: matched.id,
      next_step_order: 1,
      total_steps: totalSteps,
      status: 'active',
    })
    if (progIns.error) {
      console.error('[ZapVoice inbound] progress insert', progIns.error.message)
    }
  }

  const lockUntilIso = new Date(startMs + 6 * 60 * 60 * 1000).toISOString()
  const { error: lockErr } = await p.supabase
    .from('leads')
    .update({ funnel_locked_until: lockUntilIso })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)
  if (lockErr) {
    console.error('[ZapVoice inbound] lock lead', lockErr.message)
  }

  console.log('[ZapVoice inbound] enfileirado isca', { campaignId: matched.id, leadId: p.leadId, totalSteps })

  return { enqueued: true, campaignId: matched.id, suppressAi: true }
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
  const scheduledAt = new Date(
    nowMs + Math.max(0, p.step.delay_seconds) * 1000,
  ).toISOString()
  const ct = p.step.media_type
  const mUrl = ct === 'text' ? null : p.step.media_url?.trim() ?? null

  const ins = await p.supabase.from('scheduled_messages').insert({
    user_id: p.userId,
    lead_id: p.leadId,
    zv_campaign_id: p.progress.campaign_id,
    zv_funnel_step_id: p.step.id,
    is_active: true,
    recipient_type: 'personal',
    content_type: ct,
    message_body: p.step.message ?? null,
    media_url: mUrl,
    scheduled_at: scheduledAt,
    status: 'pending',
    recipient_phone: p.phoneDigits,
    event_id: null,
    evolution_instance_name: p.instanceName,
    min_delay_seconds: p.campMin ?? null,
    max_delay_seconds: p.campMax ?? null,
  })
  if (ins.error) {
    console.error('[ZapVoice inbound] enqueue next', ins.error.message)
    return { enqueued: false, reason: 'erro_fila', campaignId: p.progress.campaign_id, suppressAi: true }
  }

  const nextOrder = p.progress.next_step_order + 1
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
