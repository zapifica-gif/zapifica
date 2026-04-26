// Webhook: Apify notifica término do run (SUCCEEDED/FAILED/…)
// POST (sem CORS; chamada server-to-server)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TERMINAL_FAIL_EVENTS = new Set([
  'ACTOR.RUN.FAILED',
  'ACTOR.RUN.ABORTED',
  'ACTOR.RUN.TIMED_OUT',
])

type ApifyWebhookPayload = {
  eventType?: string
  eventData?: { actorRunId?: string }
  resource?: {
    id?: string
    status?: string
    defaultDatasetId?: string
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Texto plano no CSV: sem quebras de linha/vírgulas no meio do campo (não quebra a planilha). */
function sanitizeCsvCellValue(raw: string): string {
  return raw
    .replace(/\r\n|\n|\r/g, ' ')
    .replace(/,/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function toPlainString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map((x) => toPlainString(x)).filter(Boolean).join(' ')
  if (typeof v === 'object') {
    // endereço às vezes vem aninhado
    return sanitizeCsvCellValue(JSON.stringify(v))
  }
  return String(v)
}

function firstNonEmptyField(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (v == null || v === '') continue
    const t = toPlainString(v)
    if (t) return sanitizeCsvCellValue(t)
  }
  return ''
}

/**
 * Limpa um telefone para o formato “somente dígitos”, do jeito que a Evolution
 * espera no campo `number` ao disparar uma campanha (ex.: 5548999990000).
 * Remove parênteses, traços, espaços e qualquer caractere não numérico.
 */
function cleanPhoneDigits(raw: string): string {
  return raw.replace(/\D/g, '')
}

/**
 * Regex de números de WhatsApp brasileiros encontrados dentro de textos livres
 * (biografia do Instagram, descrição de empresa, etc.).
 *
 * Casa formatos comuns:
 *   - 11 99999-9999
 *   - (48) 9 8888-8888
 *   - +55 48 99999-9999
 *   - Whatsapp: 48999998888
 *
 * Faz captura permissiva e a limpeza/normalização para "somente dígitos" é
 * feita por `extractFirstBrazilianPhone`.
 */
const BR_PHONE_REGEX =
  /(?:whatsapp|wa\.me|whats|contato|fone|tel|wpp|zap)?[\s:.-]*\+?5?5?\s?\(?\d{2}\)?[\s.-]?\d?[\s.-]?\d{4}[\s.-]?\d{4}/gi

/**
 * Encontra o primeiro número de WhatsApp brasileiro válido dentro de um texto
 * livre e devolve só os dígitos com DDI 55. Devolve string vazia se não achar.
 */
function extractFirstBrazilianPhone(text: string): string {
  if (!text) return ''
  const matches = text.match(BR_PHONE_REGEX)
  if (!matches) return ''
  for (const raw of matches) {
    const digits = cleanPhoneDigits(raw)
    // Aceita DDI+DDD+8/9 dígitos (10..13 dígitos no total).
    if (digits.length < 10 || digits.length > 13) continue
    if (digits.startsWith('55') && digits.length >= 12) return digits
    if (digits.length === 10 || digits.length === 11) return `55${digits}`
    if (digits.length >= 12) return digits
  }
  return ''
}

/** Escapa RFC 4180: aspas dobradas; valor já vem sanitizado. */
function quoteCsvField(s: string): string {
  return `"${s.replaceAll('"', '""')}"`
}

/** Colunas alinhadas ao dataset `agents~google-maps-search` (variação de chaves com fallback). */
function googleMapsSearchItemsToCsv(items: Record<string, unknown>[]): string {
  const header = [
    'nome_empresa',
    'telefone',
    'website',
    'endereco',
    'url_local',
  ]
  if (items.length === 0) {
    return `${header.map(quoteCsvField).join(',')}\n`
  }
  const lines: string[] = [header.map(quoteCsvField).join(',')]
  for (const item of items) {
    const nome = firstNonEmptyField(item, [
      'title',
      'name',
      'placeName',
      'displayName',
      'searchResultTitle',
      'label',
    ])
    const foneRaw = firstNonEmptyField(item, [
      'phone',
      'phoneNumber',
      'internationalPhoneNumber',
      'phoneUnformatted',
    ])
    const fone = cleanPhoneDigits(foneRaw)
    const site = firstNonEmptyField(item, ['website', 'websiteUrl', 'web', 'urlWebsite'])
    const ender = firstNonEmptyField(item, [
      'address',
      'fullAddress',
      'addressFormatted',
      'formattedAddress',
      'street',
      'subtitle',
      'subTitle',
    ])
    const umap = firstNonEmptyField(item, [
      'url',
      'googleMapsUrl',
      'mapUrl',
      'placeUrl',
      'searchResultPageUrl',
    ])
    lines.push(
      [nome, fone, site, ender, umap].map(quoteCsvField).join(','),
    )
  }
  return lines.join('\n')
}

/** Heurística: chaves cujos valores devem ir “só com dígitos” no CSV. */
function isPhoneLikeKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k === 'phone' ||
    k === 'whatsapp' ||
    k === 'tel' ||
    k === 'celular' ||
    k.includes('phone') ||
    k.includes('whatsapp') ||
    k.includes('telefone') ||
    k.includes('mobile')
  )
}

/** Colunas para o output do `apify~instagram-scraper` (resultsType=details). */
function instagramItemsToCsv(items: Record<string, unknown>[]): string {
  const header = [
    'nome',
    'username',
    'telefone',
    'biografia',
    'website',
    'seguidores',
    'url_perfil',
  ]
  if (items.length === 0) {
    return `${header.map(quoteCsvField).join(',')}\n`
  }
  const lines: string[] = [header.map(quoteCsvField).join(',')]
  for (const item of items) {
    const username = firstNonEmptyField(item, ['username', 'userName', 'handle'])
    const nome = firstNonEmptyField(item, [
      'fullName',
      'full_name',
      'displayName',
      'name',
      'title',
    ])
    const bioRaw = firstNonEmptyField(item, [
      'biography',
      'bio',
      'description',
      'aboutSection',
    ])
    // Telefone: 1) campos de contato comercial; 2) regex sobre a biografia
    const phoneFromFields = firstNonEmptyField(item, [
      'businessPhoneNumber',
      'business_phone_number',
      'contactPhoneNumber',
      'public_phone_number',
      'publicPhoneNumber',
      'phone',
      'phoneNumber',
    ])
    const phone = phoneFromFields
      ? cleanPhoneDigits(phoneFromFields)
      : extractFirstBrazilianPhone(bioRaw)
    const website = firstNonEmptyField(item, [
      'externalUrl',
      'external_url',
      'website',
      'businessWebsite',
    ])
    const followers = firstNonEmptyField(item, [
      'followersCount',
      'followers_count',
      'followers',
    ])
    const url = firstNonEmptyField(item, [
      'url',
      'profileUrl',
      'profile_url',
    ])
    const fallbackUrl =
      url || (username ? `https://www.instagram.com/${username}/` : '')
    lines.push(
      [nome, username, phone, bioRaw, website, followers, fallbackUrl]
        .map(quoteCsvField)
        .join(','),
    )
  }
  return lines.join('\n')
}

function genericJsonToCsvRows(items: Record<string, unknown>[]): string {
  if (items.length === 0) return 'resultado\n"sem itens no dataset da Apify"'
  const colSet = new Set<string>()
  for (const o of items) {
    for (const k of Object.keys(o)) colSet.add(k)
  }
  const cols = [...colSet].sort()
  const esc = (key: string, v: unknown): string => {
    if (v === null || v === undefined) return '""'
    if (typeof v === 'object') {
      return quoteCsvField(sanitizeCsvCellValue(JSON.stringify(v)))
    }
    const sanitized = sanitizeCsvCellValue(String(v))
    if (isPhoneLikeKey(key) && sanitized) {
      return quoteCsvField(cleanPhoneDigits(sanitized))
    }
    return quoteCsvField(sanitized)
  }
  const header = cols.map(quoteCsvField).join(',')
  const lines = items.map((row) =>
    cols.map((c) => esc(c, (row as Record<string, unknown>)[c])).join(','),
  )
  return [header, ...lines].join('\n')
}

serve(async (req) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return jsonResponse({ ok: true, service: 'apify-webhook' })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
  const apifyToken = (Deno.env.get('APIFY_API_TOKEN') ?? '').trim()
  const webhookSecret = (Deno.env.get('APIFY_WEBHOOK_SECRET') ?? '').trim()

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Supabase não configurado' }, 500)
  }
  if (!apifyToken) {
    return jsonResponse({ error: 'APIFY_API_TOKEN ausente' }, 500)
  }

  if (webhookSecret) {
    const url = new URL(req.url)
    const got = url.searchParams.get('secret') ?? url.searchParams.get('token') ?? ''
    if (got !== webhookSecret) {
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }
  }

  let body: ApifyWebhookPayload
  try {
    body = (await req.json()) as ApifyWebhookPayload
  } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400)
  }

  const eventType = body.eventType ?? ''
  const resource = body.resource
  const runId = resource?.id ?? body.eventData?.actorRunId
  if (!runId) {
    return jsonResponse({ error: 'Run id ausente' }, 400)
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: ext, error: findErr } = await supabase
    .from('lead_extractions')
    .select('id, user_id, requested_amount, status, apify_run_id, source')
    .eq('apify_run_id', runId)
    .maybeSingle()

  if (findErr) {
    return jsonResponse({ error: findErr.message }, 500)
  }
  if (!ext) {
    // Run não mapeado (ex.: outro teste no console) — 200 evita reenvios agressivos
    return jsonResponse({ ok: true, ignored: true, runId }, 200)
  }

  if (ext.status === 'completed' || ext.status === 'failed') {
    return jsonResponse({ ok: true, idempotent: true, extractionId: ext.id }, 200)
  }

  const requestedAmount = ext.requested_amount
  const userId = ext.user_id as string
  const extractionId = ext.id as string

  const isSucceeded = eventType === 'ACTOR.RUN.SUCCEEDED' || resource?.status === 'SUCCEEDED'
  const isFailed =
    TERMINAL_FAIL_EVENTS.has(eventType) ||
    ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(resource?.status ?? '')

  if (isSucceeded) {
    let datasetId = resource?.defaultDatasetId ?? ''
    if (!datasetId) {
      const rr = await fetch(
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${
          encodeURIComponent(apifyToken)
        }`,
      )
      if (rr.ok) {
        const runJson = (await rr.json()) as { data?: { defaultDatasetId?: string } }
        datasetId = runJson.data?.defaultDatasetId ?? ''
      }
    }
    if (!datasetId) {
      await supabase
        .from('lead_extractions')
        .update({ status: 'failed' })
        .eq('id', extractionId)
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: userId,
        p_amount: requestedAmount,
      })
      return jsonResponse({ ok: false, error: 'defaultDatasetId ausente', refunded: true }, 200)
    }

    const itemsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(
      datasetId,
    )}/items?format=json&clean=true&token=${encodeURIComponent(apifyToken)}`

    let items: Record<string, unknown>[]
    try {
      const r = await fetch(itemsUrl)
      if (!r.ok) {
        const t = await r.text()
        throw new Error(`Apify items ${r.status}: ${t.slice(0, 200)}`)
      }
      const j = (await r.json()) as unknown
      items = Array.isArray(j) ? (j as Record<string, unknown>[]) : []
    } catch (e) {
      await supabase
        .from('lead_extractions')
        .update({ status: 'failed' })
        .eq('id', extractionId)
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: userId,
        p_amount: requestedAmount,
      })
      return jsonResponse(
        {
          ok: false,
          error: e instanceof Error ? e.message : 'Falha ao baixar dataset',
          refunded: true,
        },
        200,
      )
    }

    const extSource = (ext as { source?: string | null }).source
    let csvBody: string
    if (extSource === 'google_maps') {
      csvBody = googleMapsSearchItemsToCsv(items)
    } else if (extSource === 'instagram') {
      csvBody = instagramItemsToCsv(items)
    } else {
      csvBody = genericJsonToCsvRows(items)
    }
    const csv = '\uFEFF' + csvBody
    const path = `${userId}/${extractionId}.csv`
    const upload = await supabase.storage
      .from('lead_extractions')
      .upload(path, new Blob([csv], { type: 'text/csv' }), {
      contentType: 'text/csv; charset=utf-8',
      upsert: true,
    })
    if (upload.error) {
      await supabase
        .from('lead_extractions')
        .update({ status: 'failed' })
        .eq('id', extractionId)
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: userId,
        p_amount: requestedAmount,
      })
      return jsonResponse({ ok: false, error: upload.error.message, refunded: true }, 200)
    }

    const { data: pub } = supabase.storage.from('lead_extractions').getPublicUrl(path)
    const resultUrl = pub.publicUrl

    // Cobrança justa: a Apify cobrou `requested_amount`, mas só vieram `items.length`.
    // Devolvemos a diferença no saldo do tenant via RPC (com idempotência por extraction_id).
    const extractedCount = items.length
    const refundAmount = Math.max(0, requestedAmount - extractedCount)

    if (refundAmount > 0) {
      const { error: refundErr } = await supabase.rpc('refund_partial_credits', {
        p_user_id: userId,
        p_extraction_id: extractionId,
        p_amount: refundAmount,
      })
      if (refundErr) {
        console.error('[apify-webhook] refund_partial_credits falhou:', refundErr)
      }
    }

    await supabase
      .from('lead_extractions')
      .update({
        status: 'completed',
        result_url: resultUrl,
        extracted_count: extractedCount,
      })
      .eq('id', extractionId)

    return jsonResponse(
      {
        ok: true,
        extractionId,
        resultUrl,
        itemCount: extractedCount,
        refunded: refundAmount,
      },
      200,
    )
  }

  if (isFailed) {
    await supabase
      .from('lead_extractions')
      .update({ status: 'failed' })
      .eq('id', extractionId)
    await supabase.rpc('refund_extraction_credits', {
      p_user_id: userId,
      p_amount: requestedAmount,
    })
    return jsonResponse({ ok: true, failed: true, extractionId, refunded: true }, 200)
  }

  // Outros eventos (ex.: RUN.CREATED) — nada
  return jsonResponse({ ok: true, skipped: true, eventType }, 200)
})
