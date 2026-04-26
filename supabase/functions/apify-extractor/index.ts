// Edge Function: apify-extractor
// Dedução de créditos, registro em lead_extractions e disparo (mock) da Apify.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Source = 'google_maps' | 'instagram'

const ACTOR_PATH: Record<Source, string> = {
  google_maps: 'compass~crawler-google-places', // padrão Comunidade: Google Maps Scraper
  instagram: 'apify~instagram-scraper', // referência: ajuste ao Actor real
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

function buildApifyInput(params: {
  source: Source
  searchTerm: string
  country: string
  state: string
  city: string
  maxItems: number
}): Record<string, unknown> {
  const area = [params.city, params.state, params.country].filter(Boolean).join(', ')
  if (params.source === 'google_maps') {
    return {
      searchStringsArray: [params.searchTerm],
      locationQuery: area,
      maxCrawledPlaces: params.maxItems,
      language: 'pt',
    }
  }
  return {
    search: params.searchTerm,
    resultsLimit: params.maxItems,
    searchType: 'hashtag',
    // Campos reais do Actor de Instagram costumam variar; isto alinha a arquitetura
    locations: [area],
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
      // 200: o cliente @supabase/supabase-js parseia o corpo em qualquer status;
      // saldo insuficiente fica em ok:false para a tela ajustar o saldo sem tratar 402.
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

    const apifyToken = (Deno.env.get('APIFY_API_TOKEN') ?? '').trim()
    const mockApify = Deno.env.get('APIFY_MOCK')?.trim() === '1' || !apifyToken
    const apifyInput = buildApifyInput({
      source: source as Source,
      searchTerm,
      country,
      state,
      city,
      maxItems: requestedAmount,
    })

    // URL padrão da API Apify (run síncrono do Actor); com mock evita erro de auth em dev
    const actor = ACTOR_PATH[source as Source]
    const apifyRunUrl = mockApify
      ? 'https://httpbin.org/post'
      : `https://api.apify.com/v2/acts/${actor}/runs?token=${encodeURIComponent(apifyToken)}`

    let apifyRunId: string | null = null
    try {
      const apRes = await fetch(apifyRunUrl, {
        method: 'POST',
        headers: mockApify
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mockApify
            ? { mock: true, source, input: apifyInput, userId: user.id, extractionId: row.id }
            : { ...apifyInput, webhooks: [] },
        ),
      })
      if (!apRes.ok) {
        const t = await apRes.text()
        throw new Error(`Apify HTTP ${apRes.status}: ${t.slice(0, 400)}`)
      }
      const out = await apRes.json().catch(() => null) as
        | { data?: { id?: string; defaultDatasetId?: string } }
        | { json?: { mock?: boolean } }
        | null
      if (out && typeof out === 'object' && 'data' in out && out.data?.id) {
        apifyRunId = out.data.id
      }
    } catch (e) {
      await supabase
        .from('lead_extractions')
        .update({ status: 'failed' })
        .eq('id', row.id)
      await supabase.rpc('refund_extraction_credits', {
        p_user_id: user.id,
        p_amount: requestedAmount,
      })
      return jsonResponse({
        ok: false,
        error: e instanceof Error ? e.message : 'Falha ao contatar a Apify.',
        refunded: true,
      }, 500)
    }

    const resultUrl = apifyRunId
      ? `https://console.apify.com/actors/runs/${apifyRunId}`
      : null

    await supabase
      .from('lead_extractions')
      .update({ status: 'processing', result_url: resultUrl })
      .eq('id', (row as { id: string }).id)

    return jsonResponse({
      ok: true,
      mock: mockApify,
      extraction: { ...(row as object), status: 'processing' as const, result_url: resultUrl },
      newBalance: ded.new_balance,
    })
  } catch (err: unknown) {
    console.error('[apify-extractor] erro inesperado:', err)
    return jsonErrorResponse(err, 500)
  }
})
