// Citações (quoted), fetch base64 via Evolution, transcrição de áudio (Gemini 1.5 Flash multimodal)
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

const GEMINI_MODEL = 'gemini-1.5-flash'

export async function transcribeAudioGemini(
  geminiKey: string,
  base64: string,
  mimeType: string,
): Promise<{ text: string | null; error: string | null }> {
  const key = geminiKey.trim()
  if (!key) {
    return { text: null, error: 'GEMINI_API_KEY ausente' }
  }

  // Gemini espera base64 puro (sem prefixo data:...;base64,)
  const cleanB64 = stripBase64(base64)
  const mt = (mimeType.split(';')[0]?.trim() || 'audio/ogg').toLowerCase()

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=` +
    encodeURIComponent(key)

  const prompt =
    'Transcreva este áudio de WhatsApp com precisão absoluta. ' +
    'Retorne APENAS o texto exato do que foi falado, sem explicações adicionais.'

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mt, data: cleanB64 } },
          ],
        },
      ],
    }),
  })

  const raw = await res.text()
  if (!res.ok) {
    console.error('[Gemini STT] falha', res.status, raw.slice(0, 300))
    return { text: null, error: raw.slice(0, 200) }
  }

  let out: string | null = null
  try {
    const j = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> }
      }>
    }
    out = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null
  } catch {
    out = raw.trim() || null
  }

  if (!out) {
    return { text: null, error: 'resposta vazia' }
  }

  return { text: out, error: null }
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
