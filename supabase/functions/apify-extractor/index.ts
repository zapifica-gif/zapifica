// Edge Function: apify-extractor
// Débito de créditos, registro, disparo do Actor Apify (run assíncrono) + webhooks

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Source = 'google_maps' | 'instagram'

// IDs: na API use `owner~name` (til) em vez de barra, ex. agents~google-maps-search
const APIFY_ACTOR_ID: Record<Source, string> = {
  google_maps: 'agents~google-maps-search', // pay-per-event (nova geração)
  instagram: 'dSCLg0C3YEZ83HzYX', // apify/instagram-profile-scraper
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function jsonErrorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err)
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function utf8ToBase64Json(obj: unknown): string {
  const s = JSON.stringify(obj)
  return btoa(unescape(encodeURIComponent(s)))
}

function buildWebhookRequestUrl(
  supabaseUrl: string,
  explicitUrl: string | null,
  secret: string,
): string {
  const base = (
    explicitUrl && explicitUrl.length > 0
      ? explicitUrl
      : `${supabaseUrl.replace(/\/$/, '')}/functions/v1/apify-webhook`
  ).trim()
  const u = new URL(base)
  if (secret) u.searchParams.set('secret', secret)
  return u.toString()
}

function parseInstagramUsernames(raw: string, max: number): string[] {
  const parts = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^@+/, ''))
    .filter(Boolean)
  if (parts.length > 0) {
    return parts.slice(0, Math.min(200, max))
  }
  const one = raw.trim().replace(/^@+/, '')
  return one ? [one] : []
}

function buildApifyInput(params: {
  source: Source
  searchTerm: string
  country: string
  state: string
  city: string
  requestedAmount: number
}): Record<string, unknown> {
  const { source, searchTerm, country, state, city, requestedAmount } = params
  const q = Math.min(200, Math.max(1, requestedAmount))
  if (source === 'google_maps') {
    // agents~google-maps-search: schema exige exatamente "searchTerms"
    const line = `${searchTerm} em ${city}, ${state}, ${country}`
    return {
      searchTerms: [line],
      maxItemsPerQuery: q,
      language: 'pt',
    }
  }
  const usernames = parseInstagramUsernames(searchTerm, q)
  return {
    usernames,
    includeAboutSection: false,
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? ''
    const apifyToken = (Deno.env.get('APIFY_API_TOKEN') ?? '').trim()
    const mockFromEnv = Deno.env.get('APIFY_MOCK')?.trim() === '1'
    const apiWebhookOverride = (Deno.env.get('APIFY_WEBHOOK_URL') ?? '').trim() || null
    const apiWebhookSecret = (Deno.env.get('APIFY_WEBHOOK_SECRET') ?? '').trim()

    if (!supabaseUrl || !anonKey) {
      return jsonResponse(
        { ok: false, error: 'Supabase não configurado (SUPABASE_URL / SUPABASE_ANON_KEY).' },
        500,
      )
    }
    if (!serviceKey) {
      return jsonResponse(
        { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY não configurada na função.' },
        500,
      )
    }
    if (!apifyToken && !mockFromEnv) {
      return jsonResponse(
        { ok: false, error: 'Defina APIFY_API_TOKEN (ou APIFY_MOCK=1 em ambiente de teste).' },
        500,
      )
    }

    const authHeader = req.headers.get('Authorization')?.trim() ?? ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ ok: false, error: 'Authorization Bearer ausente.' }, 401)
    }

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const {
      data: { user },
      error: userErr,
    } = await supabaseUser.auth.getUser()
    if (userErr || !user) {
      return jsonResponse({ ok: false, error: 'Sessão inválida.' }, 401)
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido' })
    }

    const o = body as Record<string, unknown>
    const source = o.source === 'instagram' ? 'instagram' : 'google_maps'
    const searchTerm = typeof o.searchTerm === 'string' ? o.searchTerm.trim() : ''
    const country = typeof o.country === 'string' ? o.country.trim() : ''
    const state = typeof o.state === 'string' ? o.state.trim() : ''
    const city = typeof o.city === 'string' ? o.city.trim() : ''
    const rawAmount = o.requestedAmount ?? o.requested_amount
    const requestedAmount =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.floor(rawAmount) : 0

    if (!searchTerm) {
      return jsonResponse({ ok: false, error: 'Termo de busca é obrigatório.' })
    }
    if (!country || !state || !city) {
      return jsonResponse({
        ok: false,
        error: 'Preencha país, estado e cidade para a localização.',
      })
    }
    if (requestedAmount < 1 || requestedAmount > 200) {
      return jsonResponse({
        ok: false,
        error: 'Quantidade de leads deve ser entre 1 e 200.',
      })
    }

    if (source === 'instagram' && parseInstagramUsernames(searchTerm, requestedAmount).length === 0) {
      return jsonResponse({ ok: false, error: 'Para Instagram, informe ao menos um @ de perfil (ou nomes separados por vírgula).' })
    }

    const location = `${city}, ${state}, ${country}`

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const { data: deduceRows, error: dedErr } = await supabase.rpc('try_deduct_extraction_credits', {
      p_user_id: user.id,
      p_amount: requestedAmount,
    })
    if (dedErr) {
      return jsonResponse({ ok: false, error: dedErr.message }, 500)
    }

    const ded = (deduceRows as { ok?: boolean; new_balance?: number }[] | null)?.[0]
    if (!ded?.ok) {
      return jsonResponse({
        ok: false,
        error: 'Saldo insuficiente para esta extração.',
        balance: ded?.new_balance ?? 0,
      })
    }

    const { data: row, error: insErr } = await supabase
      .from('lead_extractions')
      .insert({
        user_id: user.id,
        source,
        search_term: searchTerm,
        location,
        requested_amount: requestedAmount,
        status: 'pending',
        result_url: null,
      })
      .select('id, user_id, source, search_term, location, requested_amount, status, result_url, created_at')
      .single()

    if (insErr || !row) {
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: user.id,
        p_amount: requestedAmount,
      })
      return jsonResponse(
        { ok: false, error: insErr?.message ?? 'Falha ao registrar extração.' },
        500,
      )
    }

    const apifyInput = buildApifyInput({
      source: source as Source,
      searchTerm,
      country,
      state,
      city,
      requestedAmount,
    })
    const mockApify = mockFromEnv

    const rowId = (row as { id: string }).id

    let apifyRunId: string | null = null

    try {
      if (mockApify) {
        const apRes = await fetch('https://httpbin.org/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mock: true, userId: user.id, extractionId: rowId, input: apifyInput }),
        })
        if (!apRes.ok) {
          const t = await apRes.text()
          throw new Error(`Mock HTTP ${apRes.status}: ${t.slice(0, 200)}`)
        }
        // Sem run id real — o webhook Apify não é usado
        apifyRunId = null
      } else {
        const actorId = APIFY_ACTOR_ID[source as Source]
        const requestUrl = buildWebhookRequestUrl(
          supabaseUrl,
          apiWebhookOverride,
          apiWebhookSecret,
        )
        const adHocWebhooks = [
          {
            eventTypes: [
              'ACTOR.RUN.SUCCEEDED',
              'ACTOR.RUN.FAILED',
              'ACTOR.RUN.ABORTED',
              'ACTOR.RUN.TIMED_OUT',
            ],
            requestUrl,
          },
        ]
        const webhooksParam = utf8ToBase64Json(adHocWebhooks)
        const apifyRunUrl =
          `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${
            encodeURIComponent(apifyToken)
          }&webhooks=${encodeURIComponent(webhooksParam)}`

        const apifyRes = await fetch(apifyRunUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(apifyInput),
        })
        if (!apifyRes.ok) {
          const errorText = await apifyRes.text()
          console.error('Erro da Apify:', errorText)
          await supabase
            .from('lead_extractions')
            .update({ status: 'failed' })
            .eq('id', rowId)
          await supabase.rpc('refund_extraction_credits', {
            p_user_id: user.id,
            p_amount: requestedAmount,
          })
          return jsonResponse(
            {
              ok: false,
              error: `A Apify recusou a requisição (HTTP ${apifyRes.status}). Detalhe em apifyError.`,
              apifyError: errorText,
              apifyStatus: apifyRes.status,
              refunded: true,
            },
            200,
          )
        }
        const out = (await apifyRes.json().catch((parseErr) => {
          console.error('[apify-extractor] JSON inválido na resposta da Apify:', parseErr)
          return null
        })) as { data?: { id?: string; defaultDatasetId?: string } } | null
        if (out?.data?.id) {
          apifyRunId = out.data.id
        } else {
          const raw = JSON.stringify(out)
          console.error(
            '[apify-extractor] Resposta Apify sem data.id. Corpo (trecho):',
            raw.slice(0, 800),
          )
          throw new Error('Resposta Apify sem data.id do run (veja logs da função).')
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[apify-extractor] Falha ao contatar/interpretar a Apify:', msg, e)
      await supabase
        .from('lead_extractions')
        .update({ status: 'failed' })
        .eq('id', rowId)
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: user.id,
        p_amount: requestedAmount,
      })
      return jsonResponse(
        {
          ok: false,
          error: msg,
          refunded: true,
        },
        200,
      )
    }

    const { error: upErr } = await supabase
      .from('lead_extractions')
      .update({
        status: 'processing',
        apify_run_id: apifyRunId,
        result_url: null,
      })
      .eq('id', rowId)

    if (upErr) {
      if (!mockApify && apifyToken) {
        // Run já criou na Apify; o webhook ainda encontra por apify_run_id se tiver; sem corrigir
        console.error('[apify-extractor] Falha ao persistir apify_run_id:', upErr)
      }
    }

    return jsonResponse({
      ok: true,
      mock: mockApify,
      extraction: {
        ...(row as object),
        status: 'processing' as const,
        apify_run_id: apifyRunId,
        result_url: null,
      },
      newBalance: ded.new_balance,
    })
  } catch (err: unknown) {
    console.error('[apify-extractor] erro inesperado:', err)
    return jsonErrorResponse(err, 500)
  }
})
