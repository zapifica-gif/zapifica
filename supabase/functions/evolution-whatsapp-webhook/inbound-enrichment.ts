// Citações (quoted), fetch base64 via Evolution, transcrição Whisper (OpenAI)
// Usado por evolution-whatsapp-webhook

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

/** Extrai o melhor texto legível de um nó `quotedMessage` do WhatsApp. */
export function textFromQuotedNode(node: Record<string, unknown> | null): string | null {
  if (!node) return null

  const c = stringValue(node.conversation)
  if (c) return c

  const ext = nestedRecord(node, 'extendedTextMessage')
  const et = stringValue(ext?.text)
  if (et) return et

  const img = nestedRecord(node, 'imageMessage')
  if (img) return stringValue(img.caption) ?? '[imagem]'

  const vid = nestedRecord(node, 'videoMessage')
  if (vid) return stringValue(vid.caption) ?? '[vídeo]'

  if (nestedRecord(node, 'audioMessage')) return '[áudio]'

  const doc = nestedRecord(node, 'documentMessage')
  if (doc) {
    return firstString(doc.title, doc.fileName, doc.caption) ?? '[documento]'
  }

  return null
}

function contextInfoFromMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  const e = nestedRecord(msg, 'extendedTextMessage')
  const c1 = nestedRecord(e, 'contextInfo')
  if (c1) return c1
  for (const k of [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
  ] as const) {
    const sub = nestedRecord(msg, k)
    const c = nestedRecord(sub, 'contextInfo')
    if (c) return c
  }
  return null
}

/**
 * Texto da mensagem que o cliente estava citando (resposta rápida / reply).
 */
export function extractQuotedTextFromMessage(
  msg: Record<string, unknown> | null,
): string | null {
  if (!msg) return null
  const ctx = contextInfoFromMessage(msg)
  if (!ctx) return null
  const qm = nestedRecord(ctx, 'quotedMessage')
  if (qm) {
    const t = textFromQuotedNode(qm)
    if (t) return t.slice(0, 4000)
  }
  return null
}

export function formatReplyWithQuote(
  quoted: string | null,
  replyBody: string,
): string {
  if (!quoted?.trim()) return replyBody
  const safe = quoted.replace(/"/g, "'").trim()
  return `[Respondendo à mensagem: "${safe}"] ${replyBody}`
}

// --- Evolution: base64 da mídia (quando o webhook veio sem base64) ---

function pickKeyFromEnvelope(envelope: Record<string, unknown>): Record<
  string,
  unknown
> | null {
  return nestedRecord(envelope, 'key') ?? null
}

export async function fetchBase64FromEvolutionApi(
  baseUrl: string,
  apiKey: string,
  instance: string,
  envelope: Record<string, unknown>,
): Promise<{ base64: string | null; mimeType: string; error: string | null }> {
  const clean = baseUrl.replace(/\/+$/, '')
  const key = pickKeyFromEnvelope(envelope)
  if (!key) {
    return { base64: null, mimeType: 'application/octet-stream', error: 'sem key no envelope' }
  }

  const paths = [
    `${clean}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
    `${clean}/v1/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
  ]

  const body = JSON.stringify({ message: { key } })

  for (const url of paths) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    })
    const raw = await res.text()
    let data: Record<string, unknown> | null = null
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    } catch {
      data = { raw: raw.slice(0, 200) } as unknown as Record<string, unknown>
    }
    if (!res.ok) {
      console.warn('[Evolution] getBase64FromMediaMessage HTTP', res.status, raw.slice(0, 200))
      continue
    }
    const b64 = firstString(
      data?.base64,
      typeof data?.data === 'string' ? (data as { data: string }).data : null,
      asRecord(data?.data)?.base64,
      (data as { media?: { base64?: string } })?.media?.base64,
    )
    if (b64) {
      const cleanB64 = stripBase64(b64)
      const mime = stringValue(
        (data as { mimetype?: string }).mimetype,
      ) ?? 'audio/ogg; codecs=opus'
      return { base64: cleanB64, mimeType: mime, error: null }
    }
  }

  return { base64: null, mimeType: 'audio/ogg', error: 'base64 vazio após tentativas' }
}

function stripBase64(s: string): string {
  const t = s.trim()
  const marker = ';base64,'
  const i = t.toLowerCase().indexOf(marker)
  if (i >= 0) return t.slice(i + marker.length)
  return t
}

function bytesFromBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/\s/g, '')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function transcribeWhisper(
  openaiKey: string,
  base64: string,
  mimeType: string,
): Promise<{ text: string | null; error: string | null }> {
  if (!openaiKey.trim()) {
    return { text: null, error: 'OPENAI_API_KEY ausente' }
  }
  const ext = pickExtension(mimeType)
  const fileName = `audio.${ext}`
  const bytes = bytesFromBase64(base64)
  const blob = new Blob([bytes], { type: mimeType.split(';')[0]?.trim() || 'audio/ogg' })

  const form = new FormData()
  form.append('file', blob, fileName)
  form.append('model', 'whisper-1')
  form.append('language', 'pt')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey.trim()}`,
    },
    body: form,
  })

  const raw = await res.text()
  if (!res.ok) {
    console.error('[Whisper] falha', res.status, raw.slice(0, 300))
    return { text: null, error: raw.slice(0, 200) }
  }
  let text: string | null = null
  try {
    const j = JSON.parse(raw) as { text?: string }
    text = j.text?.trim() ?? null
  } catch {
    text = raw.trim() || null
  }
  if (!text) {
    return { text: null, error: 'resposta vazia' }
  }
  return { text, error: null }
}

function pickExtension(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('webm')) return 'webm'
  return 'ogg'
}
