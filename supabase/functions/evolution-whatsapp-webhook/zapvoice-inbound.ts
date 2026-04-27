// Gatilhos Zap Voice (inbound: Meta / respostas rápidas) -> scheduled_messages
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type FunnelRow = {
  id: string
  step_order: number
  message: string
  media_type: 'text' | 'image' | 'video' | 'audio' | 'document'
  media_url: string | null
  delay_seconds: number
}

type CampaignRow = {
  id: string
  name: string
  audience_tags: string[] | null
  inbound_triggers: string[] | null
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
  return messageNorm === t || messageNorm.includes(t)
}

function anyTriggerMatches(messageNorm: string, triggers: string[] | null): boolean {
  if (!triggers?.length) return false
  for (const tr of triggers) {
    if (triggerMatchesMessage(messageNorm, tr)) return true
  }
  return false
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
  if (p.contentType === 'audio') {
    return { enqueued: false, reason: 'audio_sem_transcricao' }
  }

  const raw = p.messageText.trim()
  if (!raw) {
    return { enqueued: false, reason: 'texto_vazio' }
  }
  if (/^\[(imagem|áudio|vídeo|documento|mensagem)\]$/i.test(raw)) {
    return { enqueued: false, reason: 'conteudo_placeholder' }
  }

  const messageNorm = normText(raw)

  const { data: campaigns, error: cErr } = await p.supabase
    .from('zv_campaigns')
    .select(
      'id, name, audience_tags, inbound_triggers, scheduled_start_at, min_delay_seconds, max_delay_seconds, created_at',
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
    if (anyTriggerMatches(messageNorm, row.inbound_triggers)) {
      matched = row
      break
    }
  }

  if (!matched) {
    return { enqueued: false, reason: 'sem_match' }
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
      'id, step_order, message, media_type, media_url, delay_seconds',
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

  // Recepção via gatilho: sempre ancorar em "agora" (produto)
  const startMs = Date.now()
  const rows: Record<string, unknown>[] = []
  let accMs = 0
  for (const step of ordered) {
    accMs += step.delay_seconds * 1000
    const scheduledAt = new Date(startMs + accMs).toISOString()
    const rawMsg = step.message ?? ''
    const messageBody = applyMessageTemplate(rawMsg, vars)
    const ct = step.media_type
    const mUrl = ct === 'text' ? null : step.media_url?.trim() ?? null
    rows.push({
      user_id: p.userId,
      lead_id: p.leadId,
      zv_campaign_id: matched.id,
      zv_funnel_step_id: step.id,
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
  }

  // Lock do funil: trava IA até passar do último scheduled_at + max_delay (anti-ban).
  // Se a campanha não tiver max_delay, usa 15s (padrão antigo do worker).
  const lastScheduledMs = startMs + accMs
  const maxDelayS =
    typeof matched.max_delay_seconds === 'number' && Number.isFinite(matched.max_delay_seconds)
      ? Math.max(0, matched.max_delay_seconds)
      : 15
  const lockUntilIso = new Date(lastScheduledMs + maxDelayS * 1000 + 60_000).toISOString()

  const { error: lockErr } = await p.supabase
    .from('leads')
    .update({ funnel_locked_until: lockUntilIso })
    .eq('id', p.leadId)
    .eq('user_id', p.userId)
  if (lockErr) {
    console.error('[ZapVoice inbound] lock lead', lockErr.message)
    return { enqueued: false, reason: 'erro_lock_lead' }
  }

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const batch = rows.slice(i, i + INSERT_CHUNK)
    const { error: insErr } = await p.supabase.from('scheduled_messages').insert(batch)
    if (insErr) {
      console.error('[ZapVoice inbound] insert fila', insErr.message)
      return { enqueued: false, reason: 'erro_fila' }
    }
  }

  console.log('[ZapVoice inbound] enfileirado', {
    campaignId: matched.id,
    leadId: p.leadId,
    steps: ordered.length,
  })

  return { enqueued: true, campaignId: matched.id }
}
