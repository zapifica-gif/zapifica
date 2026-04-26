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

function jsonToCsvRows(items: Record<string, unknown>[]): string {
  if (items.length === 0) return 'resultado\n"sem itens no dataset da Apify"'
  const colSet = new Set<string>()
  for (const o of items) {
    for (const k of Object.keys(o)) colSet.add(k)
  }
  const cols = [...colSet].sort()
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '""'
    if (typeof v === 'object') {
      return `"${JSON.stringify(v).replaceAll('"', '""')}"`
    }
    const s = String(v)
    return `"${s.replaceAll('"', '""')}"`
  }
  const header = cols.join(',')
  const lines = items.map((row) => cols.map((c) => esc((row as Record<string, unknown>)[c])).join(','))
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
    .select('id, user_id, requested_amount, status, apify_run_id')
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

    const csv = '\uFEFF' + jsonToCsvRows(items)
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

    await supabase
      .from('lead_extractions')
      .update({ status: 'completed', result_url: resultUrl })
      .eq('id', extractionId)

    return jsonResponse({
      ok: true,
      extractionId,
      resultUrl,
      itemCount: items.length,
    }, 200)
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
