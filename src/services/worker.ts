import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { EvolutionHttpConfig, EvolutionMediaType } from './evolution'
import {
  sendAudioMessageWithConfig,
  sendImageMessageWithConfig,
  sendMediaMessageWithConfig,
  sendTextMessageWithConfig,
} from './evolution'

export type WorkerDeps = {
  supabase: SupabaseClient
  evolution: EvolutionHttpConfig
}

/**
 * Lê `CHAVE_MESTRA_ZAPIFICA` do ambiente (Node/scripts). Mesmo segredo da Edge Function.
 */
function readChaveMestraZapificaFromEnv(): string {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> }
  }
  return (g.process?.env?.CHAVE_MESTRA_ZAPIFICA ?? '').trim()
}

/**
 * Cliente Supabase com bypass RLS, para rodar o worker fora da Edge (cron local, script).
 * Exige `CHAVE_MESTRA_ZAPIFICA` no ambiente (normalmente a service role do projeto).
 */
export function createSupabaseComChaveMestraZapifica(
  supabaseUrl: string,
): SupabaseClient {
  const key = readChaveMestraZapificaFromEnv()
  if (!key) {
    throw new Error(
      'Defina CHAVE_MESTRA_ZAPIFICA no ambiente (mesmo valor configurado na Edge Function).',
    )
  }
  return createClient(supabaseUrl.trim(), key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

export type WorkerRunSummary = {
  /** Linhas reivindicadas e processadas (tentativa de envio) */
  processed: number
  /** Falhas ao reivindicar ou erros não recuperáveis */
  skipped: number
}

type ScheduledRow = {
  id: string
  user_id: string
  lead_id: string | null
  media_url: string | null
  recipient_type: 'personal' | 'segment'
  content_type: 'text' | 'audio' | 'image' | 'document' | 'video'
  message_body: string | null
  segment_lead_ids: string[] | null
  recipient_phone?: string | null
  scheduled_at?: string | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  zv_campaign_id?: string | null
  zv_funnel_step_id?: string | null
  /** Espelho de zv_funnels.step_order (migration 20260430180000). */
  zv_funnel_step_order?: number | null
  evolution_instance_name?: string | null
  is_active?: boolean
  recurrence?: string | null
}

type RecurrenceRule = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

function normalizeRecurrence(raw: string | null | undefined): RecurrenceRule {
  const s = (raw ?? 'none').trim().toLowerCase()
  if (s === 'daily' || s === 'weekly' || s === 'monthly' || s === 'yearly') return s
  return 'none'
}

function computeNextScheduledAtUtc(
  fromIso: string | null | undefined,
  rule: RecurrenceRule,
): string | null {
  if (rule === 'none') return null
  const base = fromIso ? new Date(fromIso) : new Date()
  if (Number.isNaN(base.getTime())) return null
  const y = base.getUTCFullYear()
  const mo = base.getUTCMonth()
  const day = base.getUTCDate()
  const h = base.getUTCHours()
  const mi = base.getUTCMinutes()
  const sec = base.getUTCSeconds()
  const ms = base.getUTCMilliseconds()
  switch (rule) {
    case 'daily':
      return new Date(Date.UTC(y, mo, day + 1, h, mi, sec, ms)).toISOString()
    case 'weekly':
      return new Date(Date.UTC(y, mo, day + 7, h, mi, sec, ms)).toISOString()
    case 'monthly': {
      const nm = mo + 1
      const ny = y + Math.floor(nm / 12)
      const nmod = ((nm % 12) + 12) % 12
      const lastDay = new Date(Date.UTC(ny, nmod + 1, 0)).getUTCDate()
      const nd = Math.min(day, lastDay)
      return new Date(Date.UTC(ny, nmod, nd, h, mi, sec, ms)).toISOString()
    }
    case 'yearly':
      return new Date(Date.UTC(y + 1, mo, day, h, mi, sec, ms)).toISOString()
    default:
      return null
  }
}

function shouldRescheduleChatRecurrence(msg: ScheduledRow): boolean {
  if (normalizeRecurrence(msg.recurrence) === 'none') return false
  if (msg.zv_funnel_step_id) return false
  if (msg.zv_campaign_id) return false
  return true
}

type UserSettingsRow = {
  agencia_nome: string | null
  vendedor_primeiro_nome: string | null
  telefone_contato: string | null
  instagram_empresa: string | null
  site_empresa: string | null
  avalie_google: string | null
  endereco: string | null
  telefones: string[] | null
}

function formatDateBR(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)
}

function weekdayBR(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
  }).format(d)
}

function timeHHMM(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

function greetingByTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '12')
  if (h >= 5 && h < 12) return 'Bom dia'
  if (h >= 12 && h < 18) return 'Boa tarde'
  return 'Boa noite'
}

function firstName(full: string | null | undefined): string {
  const t = (full ?? '').trim()
  if (!t) return 'Cliente'
  return t.split(/\s+/)[0] ?? t
}

async function renderMessageTemplate(params: {
  supabase: SupabaseClient
  userId: string
  leadId: string | null
  text: string
}): Promise<string> {
  const t = params.text
  if (!t || t.indexOf('{') === -1) return t

  const now = new Date()
  const leadPromise = params.leadId
    ? params.supabase.from('leads').select('name').eq('id', params.leadId).maybeSingle()
    : Promise.resolve({ data: null as any, error: null as any })
  const settingsPromise = params.supabase
    .from('user_settings')
    .select(
      'agencia_nome, vendedor_primeiro_nome, telefone_contato, instagram_empresa, site_empresa, avalie_google, endereco, telefones',
    )
    .eq('user_id', params.userId)
    .maybeSingle()

  const [leadRes, setRes] = await Promise.all([leadPromise, settingsPromise])
  const leadName = (leadRes.data as { name?: string | null } | null)?.name ?? null
  const settings = (setRes.data as UserSettingsRow | null) ?? null
  const fn = firstName(leadName)
  const full = (leadName ?? '').trim() || 'Cliente'
  const agencia = (settings?.agencia_nome ?? '').trim()
  const ender = (settings?.endereco ?? '').trim()
  const vend = (settings?.vendedor_primeiro_nome ?? '').trim()

  const rep: Record<string, string> = {
    '{saudacao_tempo}': greetingByTime(now),
    '{hoje_data}': formatDateBR(now),
    '{dia_semana}': weekdayBR(now),
    '{hora_atual}': timeHHMM(now),
    '{cliente_primeiro_nome}': fn,
    '{cliente_nome}': full,
    '{nome}': fn,
    '{agencia_nome}': agencia,
    '{empresa_nome}': agencia,
    '{vendedor_primeiro_nome}': vend,
    '{vendedor_nome}': vend,
    '{telefone_contato}': (settings?.telefone_contato ?? '').trim(),
    '{instagram_empresa}': (settings?.instagram_empresa ?? '').trim(),
    '{site_empresa}': (settings?.site_empresa ?? '').trim(),
    '{avalie_google}': (settings?.avalie_google ?? '').trim(),
    '{endereco}': ender,
    '{empresa_endereço}': ender,
    '{telefones}': (settings?.telefones ?? []).filter(Boolean).join(' / '),
  }

  let out = t
  for (const [k, v] of Object.entries(rep)) {
    out = out.replaceAll(k, v || '')
  }
  return out
}

type ChatContentType = 'text' | 'audio' | 'image' | 'document'

function isPublicHttpUrlStr(raw: string): boolean {
  const t = raw.trim()
  if (!t.startsWith('http')) return false
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function safeFileNameFromPublicUrl(raw: string): string {
  try {
    const path = new URL(raw).pathname
    const name = decodeURIComponent(path.split('/').pop() || 'midia.bin')
    return name.trim() ? name.slice(0, 240) : 'midia.bin'
  } catch {
    return 'midia.bin'
  }
}

function mimeGuessFromFilename(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

async function downloadMediaAsBase64(
  publicUrl: string,
): Promise<{ base64: string; mimeType: string; fileName: string }> {
  const res = await fetch(publicUrl)
  if (!res.ok) {
    throw new Error(`Falha ao baixar mídia (${res.status}): ${publicUrl.slice(0, 200)}`)
  }
  const mimeType =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const buf = Buffer.from(await res.arrayBuffer())
  const fileName = (() => {
    try {
      const path = new URL(publicUrl).pathname
      return decodeURIComponent(path.split('/').pop() || 'arquivo') || 'arquivo'
    } catch {
      return 'arquivo'
    }
  })()
  return { base64: buf.toString('base64'), mimeType, fileName }
}

function toChatContentType(
  contentType: ScheduledRow['content_type'],
): ChatContentType {
  if (contentType === 'video') return 'document'
  if (
    contentType === 'text' ||
    contentType === 'audio' ||
    contentType === 'image' ||
    contentType === 'document'
  ) {
    return contentType
  }
  return 'text'
}

function messageBodyParaChat(row: ScheduledRow): string {
  const t = row.message_body?.trim()
  if (t) return t
  switch (row.content_type) {
    case 'image':
      return '[imagem]'
    case 'audio':
      return '[áudio]'
    case 'video':
      return '[vídeo]'
    case 'document':
      return 'Arquivo agendado'
    default:
      return 'Mensagem agendada'
  }
}

const BATCH_LIMIT = 30

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickRandomIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min)
  const b = Math.floor(max)
  if (b < a) return a
  return Math.floor(Math.random() * (b - a + 1)) + a
}

function defaultHumanDelayMs(): number {
  // fallback do comportamento antigo: 5–15s
  return pickRandomIntInclusive(5, 15) * 1000
}

function resolveDispatchDelayMs(row: ScheduledRow): number {
  const minS = typeof row.min_delay_seconds === 'number' ? row.min_delay_seconds : null
  const maxS = typeof row.max_delay_seconds === 'number' ? row.max_delay_seconds : null
  if (minS == null || maxS == null) return defaultHumanDelayMs()
  const safeMin = Number.isFinite(minS) ? Math.max(0, minS) : 0
  const safeMax = Number.isFinite(maxS) ? Math.max(0, maxS) : safeMin
  return pickRandomIntInclusive(safeMin, safeMax) * 1000
}

function asFiniteOrd(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Gap curto entre etapas: o worker segura a mesma execução (alinha Edge). */
const INLINE_FUNNEL_GAP_THRESHOLD_MS = 45_000
const INLINE_FUNNEL_MAX_WALL_MS = 165_000
const INLINE_FUNNEL_RESUME_BUFFER_MS = 2_500
const MAX_FUNNEL_INLINE_DEPTH = 32

function remainingWallMs(invocationStartedAtMs: number): number {
  return INLINE_FUNNEL_MAX_WALL_MS - (Date.now() - invocationStartedAtMs)
}

type ZapVoiceQueuedNextInline = {
  scheduledMessageId: string
  gapMs: number
}

/**
 * Zap Voice: assim que uma etapa do funil é ENVIADA, agenda a próxima pela ordem
 * em `zv_funnels` (alinhado à Edge `process-scheduled-messages`).
 * Retorna o id na fila e o gap (ms) para stay-awake na mesma invocação.
 */
async function enqueueNextFunnelStepAfterSend(
  supabase: SupabaseClient,
  row: ScheduledRow,
): Promise<ZapVoiceQueuedNextInline | null> {
  const sid = (row.zv_funnel_step_id ?? '').trim()
  if (!row.lead_id || !row.zv_campaign_id || !sid) return null

  console.log('[ZV-FUNNEL][worker] encadeamento pós-envio', {
    sched_id: row.id,
    lead_id: row.lead_id,
    zv_campaign_id: row.zv_campaign_id,
    zv_funnel_step_id: sid,
    zv_funnel_step_order_col: row.zv_funnel_step_order ?? null,
  })

  const { data: zvCampRow, error: campE } = await supabase
    .from('zv_campaigns')
    .select('flow_id')
    .eq('user_id', row.user_id)
    .eq('id', row.zv_campaign_id)
    .maybeSingle()
  if (campE) console.warn('[ZV-FUNNEL][worker] campanha:', campE.message)

  const zvFlowId = (zvCampRow as { flow_id: string | null } | null)?.flow_id ?? null
  if (!zvFlowId) {
    console.error('[ZV-FUNNEL][worker] ABORT sem flow_id na campanha')
    return null
  }

  const { data: prog2, error: progE } = await supabase
    .from('lead_campaign_progress')
    .select('id')
    .eq('user_id', row.user_id)
    .eq('lead_id', row.lead_id)
    .eq('campaign_id', row.zv_campaign_id)
    .in('status', ['active', 'awaiting_last_send'])
    .maybeSingle()
  if (progE) console.warn('[ZV-FUNNEL][worker] progress:', progE.message)
  if (!prog2?.id) {
    console.error('[ZV-FUNNEL][worker] ABORT sem lead_campaign_progress')
    return null
  }

  let curOrd = asFiniteOrd(row.zv_funnel_step_order ?? null)
  if (curOrd === null) {
    const { data: csr, error: curErr } = await supabase
      .from('zv_funnels')
      .select('step_order')
      .eq('id', sid)
      .limit(1)
      .maybeSingle()
    if (curErr) console.warn('[ZV-FUNNEL][worker] etapa atual UUID:', curErr.message)
    curOrd = csr ? asFiniteOrd((csr as { step_order?: unknown }).step_order) : null
  }

  if (curOrd === null) {
    console.error(
      '[ZV-FUNNEL][worker] ABORT não resolveu step_order; rode a migration zv_funnel_step_order ou redeploy do webhook.',
    )
    return null
  }

  const { data: nextStep, error: nxErr } = await supabase
    .from('zv_funnels')
    .select(
      'id, step_order, message, media_type, media_url, min_delay_seconds, max_delay_seconds',
    )
    .eq('flow_id', zvFlowId)
    .gt('step_order', curOrd)
    .order('step_order', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (nxErr) console.warn('[ZV-FUNNEL][worker] próxima etapa:', nxErr.message)

  if (!nextStep) {
    console.log('[ZV-FUNNEL][worker] sem etapa após ord', curOrd)
    return null
  }

  console.log('[ZV-FUNNEL][worker] enfileirando etapa', (nextStep as { step_order?: number }).step_order)

  const minS =
    typeof (nextStep as { min_delay_seconds?: number | null }).min_delay_seconds === 'number'
      ? Math.max(0, Number((nextStep as { min_delay_seconds: number }).min_delay_seconds))
      : typeof row.min_delay_seconds === 'number'
        ? Math.max(0, row.min_delay_seconds)
        : 2
  const maxS =
    typeof (nextStep as { max_delay_seconds?: number | null }).max_delay_seconds === 'number'
      ? Math.max(
          minS,
          Number((nextStep as { max_delay_seconds: number }).max_delay_seconds),
        )
      : typeof row.max_delay_seconds === 'number'
        ? Math.max(minS, row.max_delay_seconds)
        : 15
  const delayS = pickRandomIntInclusive(minS, maxS)
  const scheduledAt = new Date(Date.now() + delayS * 1000).toISOString()

  const rendered = await renderMessageTemplate({
    supabase,
    userId: row.user_id,
    leadId: row.lead_id,
    text: String((nextStep as { message?: string | null }).message ?? ''),
  })

  const ct = String((nextStep as { media_type?: string }).media_type ?? 'text')
  const mediaUrl2 =
    ct === 'text'
      ? null
      : (String((nextStep as { media_url?: string | null }).media_url ?? '').trim() || null)

  const nextOrd = asFiniteOrd((nextStep as { step_order?: unknown }).step_order)

  const ins2 = await supabase
    .from('scheduled_messages')
    .insert({
      user_id: row.user_id,
      lead_id: row.lead_id,
      zv_campaign_id: row.zv_campaign_id,
      zv_funnel_step_id: String((nextStep as { id: string }).id),
      zv_funnel_step_order: nextOrd,
      is_active: true,
      recipient_type: 'personal',
      content_type: ct,
      message_body: rendered || null,
      media_url: mediaUrl2,
      scheduled_at: scheduledAt,
      status: 'pending',
      recipient_phone: row.recipient_phone,
      event_id: null,
      evolution_instance_name: row.evolution_instance_name ?? null,
      min_delay_seconds: minS,
      max_delay_seconds: maxS,
    })
    .select('id')
    .single()

  if (ins2.error) {
    console.error(
      '[ZV-FUNNEL][worker] FALHA insert próxima etapa:',
      ins2.error.code,
      ins2.error.message,
    )
    return null
  }

  const nsOrd = Number((nextStep as { step_order?: number }).step_order ?? 0)
  const { data: stepBeyondQueued } = await supabase
    .from('zv_funnels')
    .select('id')
    .eq('flow_id', zvFlowId)
    .gt('step_order', nsOrd)
    .limit(1)
    .maybeSingle()
  const isLastEnqueued = stepBeyondQueued == null
  await supabase
    .from('lead_campaign_progress')
    .update({
      next_step_order: nsOrd + 1,
      status: isLastEnqueued ? 'awaiting_last_send' : 'active',
    })
    .eq('id', String((prog2 as { id: string }).id))

  const newId = (ins2.data as { id: string }).id
  console.log('[ZV-FUNNEL][worker] próxima etapa agendada', scheduledAt, 'id=', newId)
  return { scheduledMessageId: newId, gapMs: delayS * 1000 }
}

function pickPersonalRawFromUser(user: {
  phone?: string
  user_metadata?: Record<string, unknown>
}): string | null {
  const meta = user.user_metadata ?? {}
  const fromMeta =
    (typeof meta.whatsapp === 'string' && meta.whatsapp) ||
    (typeof meta.phone === 'string' && meta.phone) ||
    null
  if (user.phone?.trim()) return user.phone.trim()
  if (fromMeta?.trim()) return fromMeta.trim()
  return null
}

async function resolvePersonalPhoneFromProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('phone, whatsapp')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  const o = data as Record<string, unknown>
  const p = typeof o.phone === 'string' ? o.phone.trim() : ''
  const w = typeof o.whatsapp === 'string' ? o.whatsapp.trim() : ''
  return p || w || null
}

async function resolveRecipientPhones(
  supabase: SupabaseClient,
  row: ScheduledRow,
): Promise<{ targets: string[]; error: string | null }> {
  if (row.lead_id) {
    const inline = row.recipient_phone?.trim()
    if (inline) {
      return { targets: [inline], error: null }
    }
    const { data: lead, error } = await supabase
      .from('leads')
      .select('phone')
      .eq('id', row.lead_id)
      .eq('user_id', row.user_id)
      .maybeSingle()
    if (error) {
      return { targets: [], error: error.message }
    }
    const p = (lead as { phone: string | null } | null)?.phone?.trim()
    if (p) {
      return { targets: [p], error: null }
    }
    return { targets: [], error: 'Lead sem telefone para o disparo agendado.' }
  }

  if (row.recipient_type === 'personal') {
    const inline = row.recipient_phone?.trim()
    if (inline) {
      return { targets: [inline], error: null }
    }

    const fromProfile = await resolvePersonalPhoneFromProfile(
      supabase,
      row.user_id,
    )
    if (fromProfile?.trim()) {
      return { targets: [fromProfile.trim()], error: null }
    }

    const { data, error } = await supabase.auth.admin.getUserById(row.user_id)
    if (error || !data?.user) {
      return {
        targets: [],
        error: error?.message ?? 'Usuário não encontrado para lembrete pessoal.',
      }
    }
    const raw = pickPersonalRawFromUser(data.user)
    if (!raw) {
      return {
        targets: [],
        error:
          'Telefone não encontrado (recipient_phone vazio, profiles e auth sem número).',
      }
    }
    return { targets: [raw], error: null }
  }

  const ids = row.segment_lead_ids ?? []
  if (ids.length === 0) {
    return { targets: [], error: 'Segmento sem clientes selecionados.' }
  }

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, phone')
    .eq('user_id', row.user_id)
    .in('id', ids)

  if (error) {
    return { targets: [], error: error.message }
  }

  const targets = (leads ?? [])
    .map((l: { phone: string | null }) => (l.phone ?? '').trim())
    .filter(Boolean)

  if (targets.length === 0) {
    return {
      targets: [],
      error: 'Nenhum telefone válido nos leads selecionados.',
    }
  }

  return { targets, error: null }
}

/** Mesmo bloco da Edge: sem pendentes → completion + liberar IA. */
async function maybeFinalizeZapVoiceCampaignLead(
  supabase: SupabaseClient,
  row: ScheduledRow,
): Promise<void> {
  if (!row.lead_id || !row.zv_campaign_id) return

  const { data: prog } = await supabase
    .from('lead_campaign_progress')
    .select('id, status')
    .eq('user_id', row.user_id)
    .eq('lead_id', row.lead_id)
    .eq('campaign_id', row.zv_campaign_id)
    .in('status', ['active', 'awaiting_last_send'])
    .maybeSingle()

  const { count } = await supabase
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', row.user_id)
    .eq('lead_id', row.lead_id)
    .eq('zv_campaign_id', row.zv_campaign_id)
    .in('status', ['pending', 'processing'])
    .eq('is_active', true)

  if ((count ?? 0) === 0) {
    const isAwaiting =
      prog && typeof (prog as { status?: unknown }).status === 'string'
        ? String((prog as { status: unknown }).status) === 'awaiting_last_send'
        : false
    if (!prog || isAwaiting) {
      const { error: compErr } = await supabase.from('lead_campaign_completions').insert({
        user_id: row.user_id,
        lead_id: row.lead_id,
        campaign_id: row.zv_campaign_id,
      })
      if (compErr && (compErr as { code?: string }).code !== '23505') {
        console.warn('[worker] completion insert:', compErr.message)
      }
      if (prog && (prog as { id?: string }).id) {
        await supabase.from('lead_campaign_progress').delete().eq('id', (prog as { id: string }).id)
      }
      await supabase
        .from('leads')
        .update({ funnel_locked_until: null })
        .eq('id', row.lead_id)
        .eq('user_id', row.user_id)
    }
  }
}

async function sendOne(
  deps: WorkerDeps,
  row: ScheduledRow,
  recipient: string,
): Promise<{ ok: boolean; error: string | null; messageId: string | null }> {
  const { evolution } = deps
  const uid = row.user_id
  const body = await renderMessageTemplate({
    supabase: deps.supabase,
    userId: uid,
    leadId: row.lead_id,
    text: row.message_body ?? '',
  })
  const caption = body.trim() ? body : undefined
  const mediaUrl = row.media_url?.trim()

  if (mediaUrl) {
    const ct = row.content_type
    const trimmedMu = mediaUrl.trim()
    const heavyByUrl =
      (ct === 'video' || ct === 'document' || ct === 'image') &&
      isPublicHttpUrlStr(trimmedMu)

    // Vídeo/documento/imagem em URL pública: Evolution baixa direto (evita RAM no worker).
    if (heavyByUrl && ct !== 'audio') {
      const fn = safeFileNameFromPublicUrl(trimmedMu)
      const mime = mimeGuessFromFilename(fn)
      if (ct === 'image') {
        return sendMediaMessageWithConfig(
          uid,
          recipient,
          {
            media: trimmedMu,
            mediaType: 'image',
            mimeType: mime,
            fileName: fn,
            caption,
          },
          evolution,
        )
      }
      if (ct === 'video') {
        return sendMediaMessageWithConfig(
          uid,
          recipient,
          {
            media: trimmedMu,
            mediaType: 'video',
            mimeType: mime,
            fileName: fn,
            caption,
          },
          evolution,
        )
      }
      return sendMediaMessageWithConfig(
        uid,
        recipient,
        {
          media: trimmedMu,
          mediaType: 'document',
          mimeType: mime,
          fileName: fn,
          caption,
          ptt: false,
        },
        evolution,
      )
    }

    let b64: string
    let mimeType: string
    let fileName: string
    try {
      const d = await downloadMediaAsBase64(mediaUrl)
      b64 = d.base64
      mimeType = d.mimeType
      fileName = d.fileName
    } catch (e) {
      const msgErr = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msgErr, messageId: null }
    }

    if (ct === 'audio') {
      return sendAudioMessageWithConfig(uid, recipient, b64, evolution)
    }
    if (ct === 'text') {
      return sendMediaMessageWithConfig(
        uid,
        recipient,
        {
          media: b64,
          mediaType: 'document',
          mimeType,
          fileName,
          caption,
        },
        evolution,
      )
    }
    const mediaTypeMap: Record<string, EvolutionMediaType> = {
      image: 'image',
      video: 'video',
      document: 'document',
    }
    const mediaType: EvolutionMediaType = mediaTypeMap[ct] ?? 'document'
    return sendMediaMessageWithConfig(
      uid,
      recipient,
      {
        media: b64,
        mediaType,
        mimeType,
        fileName,
        caption,
        ptt: false,
      },
      evolution,
    )
  }

  if (!body.trim()) {
    return { ok: false, error: 'Mensagem vazia (sem texto e sem mídia).', messageId: null }
  }

  switch (row.content_type) {
    case 'text':
      return sendTextMessageWithConfig(uid, recipient, body, evolution)
    case 'audio':
      return sendAudioMessageWithConfig(uid, recipient, body, evolution)
    case 'image':
      return sendImageMessageWithConfig(uid, recipient, body, '', evolution)
    case 'document':
    case 'video':
      return {
        ok: false,
        error:
          'Documento/vídeo agendado exige a coluna `media_url` (URL pública) para o worker baixar o arquivo.',
        messageId: null,
      }
    default:
      return sendTextMessageWithConfig(uid, recipient, body, evolution)
  }
}

/**
 * Processa a fila de `scheduled_messages` prontas para envio.
 * Não interrompe o lote inteiro se uma mensagem falhar — cada linha é isolada.
 */
export async function checkAndSendScheduledMessages(
  deps: WorkerDeps,
): Promise<WorkerRunSummary> {
  const { supabase } = deps
  const nowUtcIso = new Date().toISOString()
  console.log(
    '[worker] Reivindicando lote via claim_scheduled_messages (UTC ref:',
    nowUtcIso,
    ')',
  )

  const { data, error } = await supabase.rpc('claim_scheduled_messages', {
    p_limit: BATCH_LIMIT,
  })

  const candidates = data
  console.log(
    '[worker] Resultado da busca:',
    candidates?.length ?? 0,
    'linhas reivindicadas. Erro do banco:',
    error,
  )

  if (error) {
    console.error('[worker] Falha ao reivindicar agendamentos:', error.message)
    return { processed: 0, skipped: 1 }
  }

  let processed = 0
  let skipped = 0

  for (const raw of candidates ?? []) {
    let row = raw as ScheduledRow

    try {
      const invocationStartedAtMs = Date.now()
      let chainDepth = 0
      inner: while (true) {
        let queuedInline: ZapVoiceQueuedNextInline | null = null

        let delayMs = resolveDispatchDelayMs(row)
        if (row.zv_funnel_step_id) {
          delayMs = Math.min(delayMs, 2500)
        }
        console.log(`[worker] Delay antes do envio: ${delayMs}ms | msg=${row.id}`)
        await sleep(delayMs)

        const { targets, error: resolveErr } = await resolveRecipientPhones(
          supabase,
          row,
        )
        if (resolveErr || targets.length === 0) {
          await supabase
            .from('scheduled_messages')
            .update({
              status: 'error',
              last_error: resolveErr ?? 'Sem destinatários.',
              updated_at: new Date().toISOString(),
            })
            .eq('id', row.id)
          processed += 1
          break inner
        }

        const sendResults: {
          ok: boolean
          error: string | null
          messageId: string | null
        }[] = []

        for (const recipient of targets) {
          try {
            const r = await sendOne(deps, row, recipient)
            sendResults.push(r)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            sendResults.push({ ok: false, error: msg, messageId: null })
          }
        }

        const oks = sendResults.filter((r) => r.ok)
        const fails = sendResults.filter((r) => !r.ok)

        if (oks.length === sendResults.length) {
          const ids = oks
            .map((r) => r.messageId)
            .filter((x): x is string => Boolean(x))
          const rec = normalizeRecurrence(row.recurrence)
          const bump = shouldRescheduleChatRecurrence(row)
          const nextAt = bump
            ? computeNextScheduledAtUtc(row.scheduled_at ?? undefined, rec)
            : null
          const useRecurring =
            bump && nextAt && new Date(nextAt).getTime() > Date.now()

          await supabase
            .from('scheduled_messages')
            .update(
              useRecurring
                ? {
                    status: 'pending',
                    scheduled_at: nextAt,
                    evolution_message_id: ids.length ? ids.join(',') : null,
                    last_error: null,
                    updated_at: new Date().toISOString(),
                  }
                : {
                    status: 'sent',
                    evolution_message_id: ids.length ? ids.join(',') : null,
                    last_error: null,
                    updated_at: new Date().toISOString(),
                  },
            )
            .eq('id', row.id)

          if (row.lead_id) {
            const evoId = oks[0]?.messageId ?? (ids[0] ?? null)
            const { error: chatErr } = await supabase.from('chat_messages').insert({
              lead_id: row.lead_id,
              sender_type: 'agencia',
              content_type: toChatContentType(row),
              message_body: messageBodyParaChat(row),
              media_url: row.media_url,
              evolution_message_id: evoId,
            })
            if (chatErr) {
              await supabase
                .from('scheduled_messages')
                .update({
                  last_error: `Enviado ao WhatsApp, mas o CRM não registrou a mensagem: ${chatErr.message}`.slice(
                    0,
                    4000,
                  ),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', row.id)
            } else {
              await supabase
                .from('leads')
                .update({ last_message_at: new Date().toISOString() })
                .eq('id', row.lead_id)
                .eq('user_id', row.user_id)
            }
          }

          if (row.lead_id && row.zv_campaign_id) {
            queuedInline = await enqueueNextFunnelStepAfterSend(supabase, row)
          }

          await maybeFinalizeZapVoiceCampaignLead(supabase, row)

          processed += 1

          if (queuedInline !== null) {
            const qi = queuedInline
            const gapMs = qi.gapMs
            const wallOk =
              remainingWallMs(invocationStartedAtMs) >=
              gapMs + INLINE_FUNNEL_RESUME_BUFFER_MS
            if (
              gapMs < INLINE_FUNNEL_GAP_THRESHOLD_MS &&
              wallOk &&
              chainDepth < MAX_FUNNEL_INLINE_DEPTH
            ) {
              chainDepth += 1
              console.log('[ZV-FUNNEL][worker] stay-awake mesma execução', {
                next_id: qi.scheduledMessageId,
                gapMs,
                chainDepth,
                wallMs: remainingWallMs(invocationStartedAtMs),
              })
              await sleep(gapMs)
              const { error: uErr } = await supabase
                .from('scheduled_messages')
                .update({
                  scheduled_at: new Date().toISOString(),
                  status: 'processing',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', qi.scheduledMessageId)
              if (uErr) {
                console.warn('[worker] stay-awake update:', uErr.message)
                break inner
              }
              const { data: nxtRow, error: nxErr } = await supabase
                .from('scheduled_messages')
                .select('*')
                .eq('id', qi.scheduledMessageId)
                .single()
              if (nxErr || !nxtRow) {
                console.warn('[worker] stay-awake fetch:', nxErr?.message)
                break inner
              }
              row = nxtRow as ScheduledRow
              continue inner
            }
          }

          break inner
        } else if (oks.length > 0) {
          const failText = fails
            .map((f) => f.error ?? 'Erro desconhecido')
            .join(' | ')
          await supabase
            .from('scheduled_messages')
            .update({
              status: 'error',
              evolution_message_id: oks
                .map((r) => r.messageId)
                .filter(Boolean)
                .join(','),
              last_error: `Envio parcial: ${oks.length} ok, ${fails.length} falha(s). ${failText}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', row.id)
          processed += 1
          break inner
        } else {
          const failText = fails
            .map((f) => f.error ?? 'Erro desconhecido')
            .join(' | ')
          console.error('[worker] envios falharam (100%)', {
            scheduled_id: row.id,
            detalhe: failText.slice(0, 800),
          })
          await supabase
            .from('scheduled_messages')
            .update({
              status: 'failed',
              evolution_message_id: null,
              last_error: failText.slice(0, 4000),
              updated_at: new Date().toISOString(),
            })
            .eq('id', row.id)

          if (row.lead_id && row.zv_campaign_id) {
            queuedInline = await enqueueNextFunnelStepAfterSend(supabase, row)
          }

          await maybeFinalizeZapVoiceCampaignLead(supabase, row)

          processed += 1

          if (queuedInline !== null) {
            const qi = queuedInline
            const gapMs = qi.gapMs
            const wallOk =
              remainingWallMs(invocationStartedAtMs) >=
              gapMs + INLINE_FUNNEL_RESUME_BUFFER_MS
            if (
              gapMs < INLINE_FUNNEL_GAP_THRESHOLD_MS &&
              wallOk &&
              chainDepth < MAX_FUNNEL_INLINE_DEPTH
            ) {
              chainDepth += 1
              console.log('[ZV-FUNNEL][worker] stay-awake após falha tratada', {
                next_id: qi.scheduledMessageId,
                gapMs,
                chainDepth,
                wallMs: remainingWallMs(invocationStartedAtMs),
              })
              await sleep(gapMs)
              const { error: uErr } = await supabase
                .from('scheduled_messages')
                .update({
                  scheduled_at: new Date().toISOString(),
                  status: 'processing',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', qi.scheduledMessageId)
              if (uErr) {
                console.warn('[worker] stay-awake update:', uErr.message)
                break inner
              }
              const { data: nxtRow, error: nxErr } = await supabase
                .from('scheduled_messages')
                .select('*')
                .eq('id', qi.scheduledMessageId)
                .single()
              if (nxErr || !nxtRow) {
                console.warn('[worker] stay-awake fetch:', nxErr?.message)
                break inner
              }
              row = nxtRow as ScheduledRow
              continue inner
            }
          }

          break inner
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'error',
          last_error: `Exceção no worker: ${msg}`.slice(0, 4000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      processed += 1
    }
  }

  return { processed, skipped }
}
