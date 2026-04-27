// Gatilhos Zap Voice (inbound: Meta / respostas rápidas) -> scheduled_messages
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

type CampaignRow = {
  id: string
  name: string
  audience_tags: string[] | null
  inbound_triggers: string[] | null
  /** Palavra-chave mestre após a isca (avanço para o passo 2). */
  trigger_keyword?: string | null
  scheduled_start_at: string | null
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

function triggerMatchesMessage(messageNorm: string, triggerRaw: string): boolean {
  const t = normText(triggerRaw)
  if (!t) return false
  // Passo 1: keyword EXATA (regra do produto)
  return messageNorm === t
}

function anyTriggerMatches(messageNorm: string, triggers: string[] | null): boolean {
  if (!triggers?.length) return false
  for (const tr of triggers) {
    if (triggerMatchesMessage(messageNorm, tr)) return true
  }
  return false
}

/** Inscrição no funil via anúncio: frases no array OU palavra-chave mestre (mesmo texto da pós-isca). */
function campaignInboundKeywordMatches(
  messageNorm: string,
  c: Pick<CampaignRow, 'inbound_triggers' | 'trigger_keyword'>,
): boolean {
  if (anyTriggerMatches(messageNorm, c.inbound_triggers)) return true
  return triggerMatchesMessage(messageNorm, c.trigger_keyword ?? '')
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

const INSERT_CHUNK = 80

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
  // Regra do produto: ZapVoice é estritamente conversacional por TEXTO.
  // - Passo 1: palavra-chave exata (texto)
  // - Avanço: depende de nova mensagem de texto do cliente
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

  // 1) Se há progresso ativo, tentamos avançar a etapa.
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

  if (prog && typeof (prog as any).campaign_id === 'string') {
    const progress = prog as {
      id: string
      campaign_id: string
      next_step_order: number
      total_steps: number
      status: 'active' | 'awaiting_last_send'
    }

    if (progress.status === 'awaiting_last_send') {
      // Já enfileirou a última etapa; qualquer mensagem aqui não pode re-ativar IA nem re-enfileirar.
      return { enqueued: false, reason: 'aguardando_ultima', campaignId: progress.campaign_id, suppressAi: true }
    }

    const { data: stepRow, error: stepErr } = await p.supabase
      .from('zv_funnels')
      .select('id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger')
      .eq('campaign_id', progress.campaign_id)
      .eq('step_order', progress.next_step_order)
      .maybeSingle()

    if (stepErr) {
      console.error('[ZapVoice inbound] next step', stepErr.message)
      return { enqueued: false, reason: 'erro_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
    }
    if (!stepRow) {
      // Sem próximo passo => considera concluído (não re-enfileira)
      return { enqueued: false, reason: 'sem_proximo_passo', campaignId: progress.campaign_id, suppressAi: true }
    }

    const step = stepRow as FunnelRow
    const adv = (step.advance_type ?? 'auto') as 'auto' | 'exact' | 'timer'
    if (adv === 'timer') {
      // Temporizado não avança por mensagem: ele é enfileirado quando a etapa anterior é enviada.
      return { enqueued: false, reason: 'timer_sem_interacao', campaignId: progress.campaign_id, suppressAi: true }
    }

    const { data: camp, error: campErr } = await p.supabase
      .from('zv_campaigns')
      .select('id, min_delay_seconds, max_delay_seconds, trigger_keyword')
      .eq('user_id', p.userId)
      .eq('id', progress.campaign_id)
      .maybeSingle()
    if (campErr) {
      console.error('[ZapVoice inbound] campaign read', campErr.message)
    }

    // Regra de negócio (sequência Isca -> Gatilho):
    // Após a isca, o passo 2 (Etapa 2 do funil) só enfileira com o gatilho mestre em `zv_campaigns.trigger_keyword`
    // (fallback: expected_trigger do passo 2, para compat), salvo 'timer' acima.
    const isStep2 = progress.next_step_order === 2
    const mustBeExact = isStep2 ? true : adv === 'exact'
    const campKw = normText((camp as { trigger_keyword?: string | null } | null)?.trigger_keyword ?? '')
    const stepKw = normText(step.expected_trigger ?? '')
    const expectedNorm = isStep2 ? campKw || stepKw : stepKw
    const allowAdvance = mustBeExact
      ? Boolean(expectedNorm) && messageNorm === expectedNorm
      : true // auto: qualquer texto novo do cliente

    if (!allowAdvance) {
      return { enqueued: false, reason: 'gatilho_nao_bateu', campaignId: progress.campaign_id, suppressAi: true }
    }

    const nowMs = Date.now()
    const scheduledAt = new Date(nowMs + Math.max(0, step.delay_seconds) * 1000).toISOString()
    const ct = step.media_type
    const mUrl = ct === 'text' ? null : step.media_url?.trim() ?? null

    const ins = await p.supabase.from('scheduled_messages').insert({
      user_id: p.userId,
      lead_id: p.leadId,
      zv_campaign_id: progress.campaign_id,
      zv_funnel_step_id: step.id,
      is_active: true,
      recipient_type: 'personal',
      content_type: ct,
      message_body: step.message ?? null,
      media_url: mUrl,
      scheduled_at: scheduledAt,
      status: 'pending',
      recipient_phone: p.phoneDigits,
      event_id: null,
      evolution_instance_name: p.instanceName,
      min_delay_seconds: (camp as any)?.min_delay_seconds ?? null,
      max_delay_seconds: (camp as any)?.max_delay_seconds ?? null,
    })
    if (ins.error) {
      console.error('[ZapVoice inbound] enqueue next', ins.error.message)
      return { enqueued: false, reason: 'erro_fila', campaignId: progress.campaign_id, suppressAi: true }
    }

    const nextOrder = progress.next_step_order + 1
    const isLastEnqueued = nextOrder > progress.total_steps
    const up = await p.supabase
      .from('lead_campaign_progress')
      .update({
        next_step_order: nextOrder,
        status: isLastEnqueued ? 'awaiting_last_send' : 'active',
      })
      .eq('id', progress.id)
    if (up.error) {
      console.error('[ZapVoice inbound] progress update', up.error.message)
    }

    // Mantém lock “bem à frente” enquanto o funil existir.
    const lockUntilIso = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString()
    await p.supabase
      .from('leads')
      .update({ funnel_locked_until: lockUntilIso })
      .eq('id', p.leadId)
      .eq('user_id', p.userId)

    return { enqueued: true, campaignId: progress.campaign_id, reason: 'avancou', suppressAi: true }
  }

  const { data: campaigns, error: cErr } = await p.supabase
    .from('zv_campaigns')
    .select(
      'id, name, audience_tags, inbound_triggers, trigger_keyword, scheduled_start_at, min_delay_seconds, max_delay_seconds, created_at',
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
    if (campaignInboundKeywordMatches(messageNorm, row)) {
      matched = row
      break
    }
  }

  if (!matched) {
    return { enqueued: false, reason: 'sem_match' }
  }

  // Barreira anti-loop: se já concluiu, não reativa nunca mais
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
    .select(
      'id, step_order, message, media_type, media_url, delay_seconds, advance_type, expected_trigger',
    )
    .eq('campaign_id', matched.id)
    .order('step_order', { ascending: true })

  if (sErr) {
    console.error('[ZapVoice inbound] funil', sErr.message)
    return { enqueued: false, reason: 'erro_funil' }
  }

  const ordered = [...(stepsRaw ?? [])] as FunnelRow[]
  ordered.sort((a, b) => a.step_order - b.step_order)
  if (ordered.length === 0) {
    return { enqueued: false, reason: 'funil_vazio' }
  }

  for (const s of ordered) {
    if (s.media_type !== 'text' && !s.media_url?.trim()) {
      console.warn(
        '[ZapVoice inbound] etapa com mídia sem URL, ignoro funil',
        matched.id,
        s.step_order,
      )
      return { enqueued: false, reason: 'etapa_midia_incompleta' }
    }
    if (s.media_type === 'text' && !s.message?.trim()) {
      return { enqueued: false, reason: 'etapa_texto_vazio' }
    }
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

  // Enfileira APENAS o passo 1; próximos passos dependem da resposta do lead.
  const first = ordered[0]!
  const startMs = Date.now()
  const scheduledAt = new Date(startMs + Math.max(0, first.delay_seconds) * 1000).toISOString()
  const ct = first.media_type
  const mUrl = ct === 'text' ? null : first.media_url?.trim() ?? null

  const rawMsg = first.message ?? ''
  const messageBody = applyMessageTemplate(rawMsg, vars)

  const ins1 = await p.supabase.from('scheduled_messages').insert({
    user_id: p.userId,
    lead_id: p.leadId,
    zv_campaign_id: matched.id,
    zv_funnel_step_id: first.id,
    is_active: true,
    recipient_type: 'personal',
    content_type: ct,
    message_body: messageBody || null,
    media_url: mUrl,
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
    console.error('[ZapVoice inbound] enqueue step1', ins1.error.message)
    return { enqueued: false, reason: 'erro_fila' }
  }

  const totalSteps = ordered.length
  const progIns = await p.supabase.from('lead_campaign_progress').insert({
    user_id: p.userId,
    lead_id: p.leadId,
    campaign_id: matched.id,
    next_step_order: totalSteps >= 2 ? 2 : 2,
    total_steps: totalSteps,
    status: totalSteps === 1 ? 'awaiting_last_send' : 'active',
  })
  if (progIns.error) {
    console.error('[ZapVoice inbound] progress insert', progIns.error.message)
    // não aborta envio, mas mantém suppressAi
  }

  // trava IA por uma janela grande e renovável; o unlock correto acontece ao finalizar.
  const lockUntilIso = new Date(startMs + 6 * 60 * 60 * 1000).toISOString()
  const { error: lockErr } = await p.supabase
    .from('leads')
    .update({ funnel_locked_until: lockUntilIso })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)
  if (lockErr) {
    console.error('[ZapVoice inbound] lock lead', lockErr.message)
  }

  console.log('[ZapVoice inbound] enfileirado', {
    campaignId: matched.id,
    leadId: p.leadId,
    steps: ordered.length,
  })

  return { enqueued: true, campaignId: matched.id, suppressAi: true }
}
