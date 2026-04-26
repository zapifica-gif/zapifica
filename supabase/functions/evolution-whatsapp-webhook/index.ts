// ============================================================================
// Webhook: Evolution API (messages.upsert) -> public.chat_messages
//
// Recebe mensagens do WhatsApp, cria/sincroniza leads automaticamente e salva
// mídias Base64 no bucket público `chat_media`.
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MEDIA_BUCKET = 'chat_media'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-webhook-secret, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type ChatContentType = 'text' | 'audio' | 'image' | 'document'

type TextAndType = {
  body: string
  content: ChatContentType
}

type MediaInfo = {
  base64: string | null
  mimeType: string
  extension: string
  fileName: string | null
}

type UpsertItem = {
  fromMe: boolean
  remoteJid: string
  msgId: string
  message: Record<string, unknown> | null
  envelope: Record<string, unknown>
  pushName: string | null
}

type LeadRow = { id: string; phone: string | null; name: string | null }
type LeadAiRow = { id: string; ai_enabled: boolean | null }

type CompanyContextRow = { master_prompt: string | null }
type TrainingTextRow = { content: string | null }
type TrainingCategoryRow = { id: string }

const FALLBACK_MASTER_PROMPT =
  'Você é o assistente virtual da agência de marketing Floripa Web. Seja direto, gentil, persuasivo e use respostas curtas em português do Brasil. Tente entender a necessidade do cliente.'

function buildDeepSeekSystemPrompt(params: {
  masterPrompt: string | null
  trainingTexts: string[]
}): string {
  const master = (params.masterPrompt ?? '').trim() || FALLBACK_MASTER_PROMPT
  const materials = params.trainingTexts
    .map((t) => t.trim())
    .filter(Boolean)

  const base =
    `${master}\n\n--- BASE DE CONHECIMENTO DA EMPRESA ---\n` +
    `Utilize estritamente as informações abaixo para responder ao cliente. ` +
    `Se a resposta não estiver no texto, diga que um humano vai assumir o atendimento.\n\n`

  // Defesa contra prompt infinito (token/contexto do modelo). Mantém o pedido do usuário,
  // mas impõe um teto seguro em caracteres.
  const MAX_CHARS = 12000
  let out = base
  for (const m of materials) {
    if (out.length >= MAX_CHARS) break
    const chunk = (m + '\n\n')
    out += chunk
  }
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS)
  }
  return out.trim()
}

type DeepSeekChatCompletion = {
  choices?: Array<{
    message?: { content?: string | null }
  }>
}

async function callDeepSeek(params: {
  apiKey: string
  userText: string
  systemPrompt: string
}): Promise<{ ok: boolean; text: string | null; error: string | null }> {
  const key = params.apiKey.trim()
  if (!key) {
    return { ok: false, text: null, error: 'DEEPSEEK_API_KEY não configurada.' }
  }

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: params.systemPrompt,
          },
          { role: 'user', content: params.userText },
        ],
      }),
    })

    const raw = await res.text()
    let data: DeepSeekChatCompletion | null = null
    try {
      data = raw ? (JSON.parse(raw) as DeepSeekChatCompletion) : null
    } catch {
      data = null
    }

    if (!res.ok) {
      return {
        ok: false,
        text: null,
        error: `DeepSeek ${res.status}: ${raw.slice(0, 400) || res.statusText}`,
      }
    }

    const text =
      data?.choices?.[0]?.message?.content?.trim() ??
      null

    if (!text) {
      return { ok: false, text: null, error: 'DeepSeek respondeu sem conteúdo.' }
    }

    return { ok: true, text, error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, text: null, error: msg || 'Falha ao chamar DeepSeek.' }
  }
}

async function sendEvolutionText(params: {
  baseUrl: string
  apiKey: string
  instanceName: string
  toDigits: string
  text: string
}): Promise<{ ok: boolean; messageId: string | null; error: string | null }> {
  const baseUrl = params.baseUrl.trim()
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const url = `${cleanBaseUrl}/message/sendText/${encodeURIComponent(params.instanceName)}`

  // Humanização: digitando... por tempo proporcional ao tamanho da resposta.
  // Min 2s, Max 8s, 40ms por caractere.
  const typingDelay = Math.min(Math.max(params.text.length * 40, 2000), 8000)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: params.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: params.toDigits,
      text: params.text,
      delay: typingDelay,
      presence: 'composing',
    }),
  })

  const raw = await res.text()
  let data: unknown = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw }
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      messageId: null,
      error: `Evolution ${res.status}: ${raw.slice(0, 400) || res.statusText}`,
    }
  }

  const msgId = normalizeKey((data as Record<string, unknown> | null)?.key)?.id ?? null
  return { ok: true, messageId: msgId, error: null }
}

type LeadIndex = {
  byFull: Map<string, string>
  byTail: Map<string, string>
  rows: LeadRow[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function toEvolutionDigits(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  if (t.includes('@g.us')) return t
  const core = t.includes('@') ? t.split('@')[0] ?? '' : t
  const digits = core.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('55') && digits.length >= 12) return digits
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  if (digits.length >= 12) return digits
  return null
}

function nationalTail(digits: string | null | undefined): string | null {
  if (!digits) return null
  if (digits.includes('@')) return null
  const only = digits.replace(/\D/g, '')
  if (!only) return null
  if (only.startsWith('55') && only.length >= 12) {
    return only.slice(2)
  }
  return only.slice(-11)
}

function prettifyPhone(digits: string): string {
  const tail = nationalTail(digits) ?? digits.replace(/\D/g, '')
  if (tail.length === 11) {
    return `(${tail.slice(0, 2)}) ${tail.slice(2, 7)}-${tail.slice(7)}`
  }
  if (tail.length === 10) {
    return `(${tail.slice(0, 2)}) ${tail.slice(2, 6)}-${tail.slice(6)}`
  }
  return `+${digits.replace(/\D/g, '')}`
}

function userIdFromZapificaInstance(instance: string): string | null {
  const p = 'zapifica_'
  if (!instance.startsWith(p)) return null
  const rest = instance.slice(p.length)
  if (!/^[0-9a-fA-F-]{36}$/.test(rest)) return null
  return rest
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nestedRecord(
  parent: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  if (!parent) return null
  return asRecord(parent[key])
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const s = stringValue(value)
    if (s) return s
  }
  return null
}

function extractTextAndType(
  msg: Record<string, unknown> | null | undefined,
): TextAndType {
  if (!msg) return { body: '', content: 'text' }

  const conversation = stringValue(msg.conversation)
  if (conversation) return { body: conversation, content: 'text' }

  const ext = nestedRecord(msg, 'extendedTextMessage')
  const extendedText = stringValue(ext?.text)
  if (extendedText) return { body: extendedText, content: 'text' }

  const image = nestedRecord(msg, 'imageMessage')
  if (image) {
    return {
      body: stringValue(image.caption) ?? '[imagem]',
      content: 'image',
    }
  }

  if (nestedRecord(msg, 'audioMessage')) {
    return { body: '[áudio]', content: 'audio' }
  }

  const document = nestedRecord(msg, 'documentMessage')
  if (document) {
    return {
      body:
        firstString(document.title, document.fileName, document.caption) ??
        '[documento]',
      content: 'document',
    }
  }

  const video = nestedRecord(msg, 'videoMessage')
  if (video) {
    return {
      body: stringValue(video.caption) ?? '[vídeo]',
      content: 'document',
    }
  }

  return { body: '[mensagem]', content: 'text' }
}

function extensionFromMimeType(mimeType: string): string {
  const clean = mimeType.split(';')[0]?.trim().toLowerCase() || ''
  const known: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
  }
  if (known[clean]) return known[clean]
  const fallback = clean.split('/')[1]?.replace(/[^a-z0-9]/g, '')
  return fallback || 'bin'
}

function extensionFromFileName(fileName: string | null): string | null {
  if (!fileName) return null
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(fileName)
  return match?.[1]?.toLowerCase() ?? null
}

function stripBase64Prefix(value: string): string {
  const trimmed = value.trim()
  const marker = ';base64,'
  const markerIndex = trimmed.toLowerCase().indexOf(marker)
  if (markerIndex >= 0) {
    return trimmed.slice(markerIndex + marker.length)
  }
  return trimmed
}

/**
 * Extrai os metadados e o Base64 da mídia procurando em TODAS as raízes
 * possíveis do payload da Evolution. Quando `webhookBase64: true` está
 * ativo, o motor envia o conteúdo em uma destas localizações:
 *
 *   • item.base64                      ← raiz do envelope (mais comum na v2)
 *   • item.message.base64              ← raiz do nó message
 *   • item.message.<imageMessage|audioMessage|videoMessage|documentMessage>.base64
 *
 * A função recebe o `item` inteiro (envelope) e fareja todas estas posições.
 */
function extractMediaInfo(item: UpsertItem): MediaInfo {
  const envelope = item.envelope
  const msg = item.message ?? {}

  const image = nestedRecord(msg, 'imageMessage')
  const audio = nestedRecord(msg, 'audioMessage')
  const document = nestedRecord(msg, 'documentMessage')
  const video = nestedRecord(msg, 'videoMessage')
  const mediaNode = image ?? audio ?? document ?? video

  // Caça o Base64 em todas as raízes conhecidas — a primeira não-vazia vence.
  const base64 =
    stringValue(envelope.base64) ??
    stringValue(envelope.media) ??
    stringValue(msg.base64) ??
    stringValue(image?.base64) ??
    stringValue(audio?.base64) ??
    stringValue(video?.base64) ??
    stringValue(document?.base64) ??
    null

  const mimeType =
    firstString(mediaNode?.mimetype, mediaNode?.mimeType, envelope.mimetype) ??
    (image
      ? 'image/jpeg'
      : audio
        ? 'audio/ogg'
        : video
          ? 'video/mp4'
          : 'application/octet-stream')

  const fileName = firstString(
    mediaNode?.fileName,
    mediaNode?.filename,
    mediaNode?.title,
    envelope.fileName,
    envelope.filename,
  )

  return {
    base64: base64 ? stripBase64Prefix(base64) : null,
    mimeType,
    extension: extensionFromFileName(fileName) ?? extensionFromMimeType(mimeType),
    fileName,
  }
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/\s/g, '')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function uploadMedia(
  supabase: SupabaseClient,
  params: {
    userId: string
    leadId: string
    msgId: string
    media: MediaInfo
  },
): Promise<{ url: string | null; error: string | null }> {
  if (!params.media.base64) return { url: null, error: null }

  try {
    const bytes = decodeBase64(params.media.base64)
    const path = [
      safePathPart(params.userId),
      safePathPart(params.leadId),
      `${safePathPart(params.msgId)}.${params.media.extension}`,
    ].join('/')

    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(path, bytes, {
        contentType: params.media.mimeType,
        upsert: true,
      })

    if (error) {
      console.error('[Zapifica] Upload no Storage falhou', {
        bucket: MEDIA_BUCKET,
        path,
        contentType: params.media.mimeType,
        error: error.message,
      })
      return { url: null, error: error.message }
    }

    const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path)
    const publicUrl = data.publicUrl
    console.log('[Zapifica] URL pública gerada:', publicUrl)
    return { url: publicUrl, error: null }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[Zapifica] Upload no Storage explodiu', { error: message })
    return { url: null, error: message }
  }
}

function normalizeKey(
  key: unknown,
): { remoteJid: string; id: string; fromMe: boolean } | null {
  const o = asRecord(key)
  if (!o) return null
  const remoteJid = stringValue(o.remoteJid) ?? ''
  const id = stringValue(o.id) ?? ''
  const fromMe = o.fromMe === true
  if (!remoteJid || !id) return null
  return { remoteJid, id, fromMe }
}

function collectUpsertItems(data: unknown): UpsertItem[] {
  if (data == null) return []

  if (Array.isArray(data)) {
    return data.flatMap((d) => collectUpsertItems(d))
  }

  const o = asRecord(data)
  if (!o) return []

  if (Array.isArray(o.messages)) {
    return collectUpsertItems(o.messages)
  }

  const k = normalizeKey(o.key)
  const message = asRecord(o.message)
  if (k && message) {
    return [
      {
        fromMe: k.fromMe,
        remoteJid: k.remoteJid,
        msgId: k.id,
        message,
        envelope: o,
        pushName: stringValue(o.pushName),
      },
    ]
  }

  return []
}

function buildLeadIndex(rows: LeadRow[]): LeadIndex {
  const byFull = new Map<string, string>()
  const byTail = new Map<string, string>()

  for (const r of rows) {
    const full = toEvolutionDigits(r.phone ?? null)
    if (full && !byFull.has(full)) byFull.set(full, r.id)
    const tail = nationalTail(full ?? r.phone ?? null)
    if (tail && !byTail.has(tail)) byTail.set(tail, r.id)
  }

  return { byFull, byTail, rows }
}

function findLeadId(idx: LeadIndex, fullDigits: string): string | null {
  const hitFull = idx.byFull.get(fullDigits)
  if (hitFull) return hitFull
  const tail = nationalTail(fullDigits)
  if (tail) {
    const hitTail = idx.byTail.get(tail)
    if (hitTail) return hitTail
  }
  return null
}

async function ensureLeadId(
  supabase: SupabaseClient,
  userId: string,
  idx: LeadIndex,
  fullDigits: string,
  pushName: string | null,
): Promise<{ id: string | null; created: boolean; error: string | null }> {
  const existing = findLeadId(idx, fullDigits)
  if (existing) return { id: existing, created: false, error: null }

  const displayName =
    (pushName && pushName.slice(0, 80)) ||
    `Novo Lead ${prettifyPhone(fullDigits)}`

  const { data, error } = await supabase
    .from('leads')
    .insert({
      user_id: userId,
      name: displayName,
      phone: fullDigits,
      status: 'novo',
    })
    .select('id, phone, name')
    .single()

  if (!error && data) {
    const row = data as LeadRow
    idx.rows.push(row)
    idx.byFull.set(fullDigits, row.id)
    const tail = nationalTail(fullDigits)
    if (tail) idx.byTail.set(tail, row.id)
    return { id: row.id, created: true, error: null }
  }

  const retry = await supabase
    .from('leads')
    .select('id, phone, name')
    .eq('user_id', userId)

  if (!retry.error && Array.isArray(retry.data)) {
    const refreshed = buildLeadIndex(retry.data as LeadRow[])
    idx.byFull = refreshed.byFull
    idx.byTail = refreshed.byTail
    idx.rows = refreshed.rows
    const again = findLeadId(idx, fullDigits)
    if (again) return { id: again, created: false, error: null }
  }

  return { id: null, created: false, error: error?.message ?? 'insert lead falhou' }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  // Política aberta intencional: a função aceita qualquer chamada POST porque
  // está exposta sem JWT e a Evolution API gerencia o canal. Mantemos suporte
  // OPCIONAL ao header `x-webhook-secret` apenas para registrar avisos quando
  // alguém configurar um segredo, mas NUNCA bloqueamos a entrada por isso.
  const expectedSecret = Deno.env.get('EVOLUTION_WEBHOOK_SECRET')?.trim() ?? ''
  if (expectedSecret) {
    const h = req.headers.get('x-webhook-secret')?.trim() ?? ''
    const auth = req.headers.get('authorization')?.trim() ?? ''
    const bearer = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7)
      : ''
    if (h !== expectedSecret && bearer !== expectedSecret) {
      console.warn(
        '[evolution-whatsapp-webhook] x-webhook-secret divergente — seguindo sem bloquear (Evolution não envia o segredo).',
      )
    }
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    console.error('[evolution-whatsapp-webhook] payload inválido (JSON)')
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const b = asRecord(body) ?? {}
  const event = stringValue(b.event) ?? ''
  const instance = stringValue(b.instance) ?? ''

  console.log('[evolution-whatsapp-webhook] payload recebido', {
    event,
    instance,
    hasData: Object.prototype.hasOwnProperty.call(b, 'data'),
  })

  const normalizedEvent = event.toLowerCase().replace('_', '.')
  if (normalizedEvent && normalizedEvent !== 'messages.upsert') {
    return jsonResponse({ ok: true, ignored: true, event })
  }

  const userId = userIdFromZapificaInstance(instance)
  if (!userId) {
    console.error(
      '[evolution-whatsapp-webhook] instância fora da convenção zapifica_<uuid>',
      { instance },
    )
    return jsonResponse({
      ok: false,
      error:
        'Instance não segue a convenção zapifica_<user_uuid>. Ajuste o nome da instância na Evolution.',
      instance,
    })
  }

  const items = collectUpsertItems(b.data ?? b)
  if (items.length === 0) {
    return jsonResponse({ ok: true, message: 'Nenhum item messages.upsert no payload' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Server misconfigured' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const deepSeekKey = Deno.env.get('DEEPSEEK_API_KEY')?.trim() ?? ''
  const evolutionUrl = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY')?.trim() ?? ''

  const { data: allLeads, error: leErr } = await supabase
    .from('leads')
    .select('id, phone, name')
    .eq('user_id', userId)

  if (leErr) {
    return jsonResponse({ error: leErr.message }, 500)
  }

  const index = buildLeadIndex((allLeads ?? []) as LeadRow[])

  let saved = 0
  let createdLeads = 0
  const skipped: string[] = []
  const errors: string[] = []

  for (const item of items) {
    if (item.remoteJid.includes('@g.us')) {
      skipped.push(`group:${item.msgId}`)
      continue
    }

    if (item.fromMe) {
      skipped.push(`fromMe:${item.msgId}`)
      continue
    }

    if (!item.msgId) {
      skipped.push('noMsgId')
      continue
    }

    const phoneDigits = toEvolutionDigits(item.remoteJid)
    if (!phoneDigits || phoneDigits.includes('@')) {
      skipped.push(`badJid:${item.remoteJid}`)
      continue
    }

    const ensured = await ensureLeadId(
      supabase,
      userId,
      index,
      phoneDigits,
      item.pushName,
    )
    if (!ensured.id) {
      errors.push(`lead:${phoneDigits}:${ensured.error ?? 'sem id'}`)
      continue
    }
    if (ensured.created) createdLeads += 1

    const { body: text, content: contentType } = extractTextAndType(item.message)
    const media = extractMediaInfo(item)

    const isMediaContent =
      contentType === 'image' ||
      contentType === 'audio' ||
      contentType === 'document'

    if (isMediaContent) {
      if (media.base64) {
        console.log('[Zapifica] Base64 capturado direto do webhook', {
          msgId: item.msgId,
          contentType,
          mimeType: media.mimeType,
          base64Length: media.base64.length,
        })
      } else {
        console.warn(
          '[Zapifica] Mensagem de mídia sem base64 no payload — verifique se webhookBase64=true está ativo na Evolution.',
          {
            msgId: item.msgId,
            contentType,
            mimeType: media.mimeType,
            fileName: media.fileName,
          },
        )
      }
    }

    const upload = await uploadMedia(supabase, {
      userId,
      leadId: ensured.id,
      msgId: item.msgId,
      media,
    })

    if (upload.error) {
      console.error('[evolution-whatsapp-webhook] falha ao salvar mídia', {
        msgId: item.msgId,
        error: upload.error,
      })
      errors.push(`media:${item.msgId}:${upload.error}`)
      continue
    }

    const { error: insErr } = await supabase.from('chat_messages').insert({
      lead_id: ensured.id,
      sender_type: 'cliente',
      content_type: contentType,
      message_body: text,
      evolution_message_id: item.msgId,
      media_url: upload.url,
    })

    if (insErr) {
      if (insErr.code === '23505') {
        skipped.push(`dup:${item.msgId}`)
        continue
      }
      errors.push(`msg:${item.msgId}:${insErr.message}`)
      continue
    }
    saved += 1

    // ───────────────────────────────────────────────────────────────────────
    // IA (DeepSeek) com handover por lead.ai_enabled
    // Apenas quando for mensagem do cliente (fromMe:false já filtrado) e TEXTO.
    // ───────────────────────────────────────────────────────────────────────
    if (contentType === 'text' && text.trim()) {
      const { data: leadAi, error: aiErr } = await supabase
        .from('leads')
        .select('id, ai_enabled')
        .eq('id', ensured.id)
        .eq('user_id', userId)
        .maybeSingle()

      if (aiErr) {
        console.error('[IA] Falha ao ler ai_enabled do lead:', aiErr.message)
      } else {
        const enabled = (leadAi as LeadAiRow | null)?.ai_enabled !== false
        if (enabled) {
          if (!deepSeekKey) {
            console.warn('[IA] DEEPSEEK_API_KEY ausente; ignorando resposta automática.')
          } else if (!evolutionUrl || !evolutionApiKey) {
            console.warn('[IA] EVOLUTION_API_URL/KEY ausentes; não consigo responder.')
          } else {
            const [{ data: ctx, error: ctxErr }, { data: mats, error: matsErr }] =
              await Promise.all([
                supabase
                  .from('ai_company_context')
                  .select('master_prompt')
                  .eq('user_id', userId)
                  .maybeSingle(),
                supabase
                  .from('ai_training_categories')
                  .select('id')
                  .eq('user_id', userId)
                  .eq('is_active', true),
              ])

            if (ctxErr) {
              console.error('[IA] Falha ao carregar master_prompt:', ctxErr.message)
            }
            if (matsErr) {
              console.error('[IA] Falha ao carregar categorias ativas:', matsErr.message)
            }

            const masterPrompt = (ctx as CompanyContextRow | null)?.master_prompt ?? null
            const activeCategoryIds = ((mats ?? []) as TrainingCategoryRow[]).map((r) => r.id)
            const mats2 = activeCategoryIds.length
              ? await supabase
                .from('ai_training_materials')
                .select('content')
                .eq('user_id', userId)
                .eq('type', 'text')
                .eq('is_processed', true)
                .in('category_id', activeCategoryIds)
              : { data: [] as TrainingTextRow[], error: null as { message: string } | null }

            if (mats2.error) {
              console.error('[IA] Falha ao carregar materiais (categorias ativas):', mats2.error.message)
            }

            const trainingTexts = ((mats2.data ?? []) as TrainingTextRow[])
              .map((r) => r.content ?? '')
              .filter((t) => Boolean(t && t.trim()))

            const systemPrompt = buildDeepSeekSystemPrompt({
              masterPrompt,
              trainingTexts,
            })

            const ai = await callDeepSeek({
              apiKey: deepSeekKey,
              userText: text,
              systemPrompt,
            })
            if (!ai.ok || !ai.text) {
              console.error('[IA] DeepSeek falhou:', ai.error ?? 'sem erro')
            } else {
              const evo = await sendEvolutionText({
                baseUrl: evolutionUrl,
                apiKey: evolutionApiKey,
                instanceName: instance,
                toDigits: phoneDigits,
                text: ai.text,
              })

              if (!evo.ok) {
                console.error('[IA] Falha ao enviar via Evolution:', evo.error ?? 'sem erro')
              } else {
                const { error: iaInsErr } = await supabase.from('chat_messages').insert({
                  lead_id: ensured.id,
                  sender_type: 'ia',
                  content_type: 'text',
                  message_body: ai.text,
                  evolution_message_id: evo.messageId,
                  media_url: null,
                })
                if (iaInsErr) {
                  console.error('[IA] Falha ao salvar resposta no chat_messages:', iaInsErr.message)
                }
              }
            }
          }
        }
      }
    }
  }

  const ok = errors.length === 0
  console.log('[evolution-whatsapp-webhook] resumo', {
    instance,
    userId,
    saved,
    createdLeads,
    skipped: skipped.length,
    errors: errors.length,
    count: items.length,
  })

  return jsonResponse(
    {
      ok,
      saved,
      createdLeads,
      skipped,
      errors,
      count: items.length,
    },
    ok ? 200 : 500,
  )
})
