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

function extractMediaInfo(
  msg: Record<string, unknown> | null,
  envelope: Record<string, unknown>,
): MediaInfo {
  const image = nestedRecord(msg, 'imageMessage')
  const audio = nestedRecord(msg, 'audioMessage')
  const document = nestedRecord(msg, 'documentMessage')
  const video = nestedRecord(msg, 'videoMessage')
  const mediaNode = image ?? audio ?? document ?? video

  const rawBase64 = firstString(
    envelope.base64,
    envelope.media,
    msg?.base64,
    mediaNode?.base64,
  )

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
    base64: rawBase64 ? stripBase64Prefix(rawBase64) : null,
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

/**
 * Busca Ativa (Reverse Fetch).
 *
 * A Evolution às vezes não envia o `base64` da mídia direto no webhook (por
 * questões de performance do motor) — mesmo com todas as flags ativadas.
 * Quando isso acontece, chamamos o endpoint oficial:
 *
 *   POST {EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/{instance}
 *   header: apikey: {EVOLUTION_API_KEY}
 *
 * O endpoint exige a mensagem COMPLETA (com `key` + `message`). Por isso a
 * função aceita `rawItem` (o envelope que veio do upsert) e tenta variações
 * de body conhecidas até a Evolution aceitar:
 *
 *   1. { message: <envelope com key+message> }      ← formato oficial v2
 *   2. <envelope direto>                            ← algumas builds antigas
 *   3. { message: <só o item.message interno> }     ← último recurso
 *
 * A resposta vem como `{ base64, mimetype, ... }` e nós usamos isso para
 * subir o arquivo para o bucket `chat_media` normalmente.
 */
async function fetchBase64FromEvolution(params: {
  evoUrl: string
  evoKey: string
  instance: string
  rawItem: Record<string, unknown>
  innerMessage: Record<string, unknown> | null
}): Promise<{
  base64: string | null
  mimeType: string | null
  fileName: string | null
  error: string | null
}> {
  const { evoUrl, evoKey, instance, rawItem, innerMessage } = params

  if (!evoUrl || !evoKey) {
    return {
      base64: null,
      mimeType: null,
      fileName: null,
      error:
        'EVOLUTION_API_URL ou EVOLUTION_API_KEY ausentes nas variáveis de ambiente da Edge Function.',
    }
  }

  if (!rawItem && !innerMessage) {
    return {
      base64: null,
      mimeType: null,
      fileName: null,
      error: 'mensagem original ausente — nada para resgatar',
    }
  }

  const baseUrl = evoUrl.replace(/\/+$/, '')
  const candidatePaths = [
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
    `/v1/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
  ]

  // Variações de body para sobreviver a versões diferentes da Evolution.
  type BodyShape = { label: string; payload: unknown }
  const bodyVariants: BodyShape[] = []

  if (rawItem) {
    bodyVariants.push({ label: 'wrapped-envelope', payload: { message: rawItem } })
    bodyVariants.push({ label: 'raw-envelope', payload: rawItem })
  }
  if (innerMessage) {
    bodyVariants.push({
      label: 'inner-message',
      payload: { message: innerMessage },
    })
  }

  let lastError: string | null = null

  for (const path of candidatePaths) {
    for (const variant of bodyVariants) {
      const url = `${baseUrl}${path}`
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: evoKey,
          },
          body: JSON.stringify(variant.payload),
        })

        const raw = await res.text()
        let data: unknown = null
        if (raw) {
          try {
            data = JSON.parse(raw) as unknown
          } catch {
            data = { raw }
          }
        }

        console.log('[Zapifica][reverseFetch] tentativa', {
          path,
          variant: variant.label,
          status: res.status,
          ok: res.ok,
          gotBase64:
            asRecord(data) && typeof asRecord(data)?.base64 === 'string'
              ? `len=${(asRecord(data)?.base64 as string).length}`
              : false,
        })

        if (!res.ok) {
          if (res.status === 404 || res.status === 400) {
            lastError = `HTTP ${res.status} em ${path} (${variant.label})`
            continue
          }
          return {
            base64: null,
            mimeType: null,
            fileName: null,
            error: `HTTP ${res.status} em ${path} (${variant.label}): ${
              typeof data === 'object' ? JSON.stringify(data) : String(data ?? '')
            }`,
          }
        }

        const root = asRecord(data) ?? {}
        const base64 =
          stringValue(root.base64) ??
          stringValue(root.media) ??
          stringValue(root.data)
        const mimeType =
          stringValue(root.mimetype) ?? stringValue(root.mimeType)
        const fileName =
          stringValue(root.fileName) ?? stringValue(root.filename)

        if (!base64) {
          lastError = `Resposta sem base64 em ${path} (${variant.label})`
          continue
        }

        return {
          base64,
          mimeType,
          fileName,
          error: null,
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
  }

  return {
    base64: null,
    mimeType: null,
    fileName: null,
    error: lastError ?? 'Não foi possível resgatar a mídia da Evolution.',
  }
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

  // Credenciais para a Busca Ativa (Reverse Fetch) na Evolution.
  // Mantemos compatibilidade lendo dois nomes possíveis de variável.
  const evoUrl = (
    Deno.env.get('EVOLUTION_API_URL') ??
    Deno.env.get('EVOLUTION_URL') ??
    ''
  ).trim()
  const evoKey = (
    Deno.env.get('EVOLUTION_API_KEY') ??
    Deno.env.get('EVOLUTION_GLOBAL_KEY') ??
    ''
  ).trim()
  if (!evoUrl || !evoKey) {
    console.warn(
      '[evolution-whatsapp-webhook] EVOLUTION_API_URL/EVOLUTION_API_KEY ausentes — Busca Ativa de mídia ficará desabilitada.',
    )
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

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
    const media = extractMediaInfo(item.message, item.envelope)

    // Busca Ativa (Reverse Fetch): se a mensagem é de mídia mas a Evolution
    // não mandou o base64 direto no webhook (acontece por performance do
    // motor), pedimos ele explicitamente via POST para o endpoint oficial.
    const isMediaContent =
      contentType === 'image' ||
      contentType === 'audio' ||
      contentType === 'document'

    if (isMediaContent && !media.base64) {
      console.log('[Zapifica] Buscando mídia ativamente na Evolution...', {
        msgId: item.msgId,
        contentType,
        mimeType: media.mimeType,
        fileName: media.fileName,
      })

      const rescue = await fetchBase64FromEvolution({
        evoUrl,
        evoKey,
        instance,
        rawItem: item.envelope,
        innerMessage: item.message,
      })

      if (rescue.base64) {
        console.log('[Zapifica] Mídia resgatada com sucesso!', {
          msgId: item.msgId,
          mimeType: rescue.mimeType ?? media.mimeType,
          base64Length: rescue.base64.length,
        })
        media.base64 = stripBase64Prefix(rescue.base64)
        if (rescue.mimeType) {
          media.mimeType = rescue.mimeType
          media.extension =
            extensionFromMimeType(rescue.mimeType) || media.extension
        }
        if (rescue.fileName) {
          media.fileName = rescue.fileName
          const fromName = extensionFromFileName(rescue.fileName)
          if (fromName) media.extension = fromName
        }
      } else {
        console.warn(
          '[Zapifica] Não foi possível resgatar a mídia da Evolution — seguindo sem o arquivo.',
          { msgId: item.msgId, error: rescue.error },
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
