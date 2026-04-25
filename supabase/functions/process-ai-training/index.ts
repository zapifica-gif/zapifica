// Edge Function: process-ai-training
// POST { type: 'link', url } | { type: 'file', filePath }
// Extrai texto → DeepSeek deepseek-reasoner → resumo em ai_training_materials

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local')) return true
  if (h === '0.0.0.0') return true
  if (h.endsWith('.onion')) return true
  if (h === 'metadata.google.internal') return true
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
  if (ipv4) {
    const p = h.split('.').map((x) => Number(x))
    if (p[0] === 10) return true
    if (p[0] === 127) return true
    if (p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  }
  return false
}

function normalizeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (isPrivateOrBlockedHost(u.hostname)) return null
    return u
  } catch {
    return null
  }
}

/** Extrai texto legível do HTML (remove script/style/nav/footer e tags). */
function extractTextFromHtml(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
  s = s.replace(/<header[\s\S]*?<\/header>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ')
  s = s.replace(/&amp;/g, '&')
  s = s.replace(/&lt;/g, '<')
  s = s.replace(/&gt;/g, '>')
  s = s.replace(/&quot;/g, '"')
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

async function fetchHtmlText(url: URL): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const res = await fetch(url.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'ZapificaTrainingBot/1.0',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
  })
  if (!res.ok) {
    return { ok: false, error: `Falha ao baixar URL (${res.status})` }
  }
  const ct = res.headers.get('content-type')?.toLowerCase() ?? ''
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    return { ok: false, error: 'URL não retornou HTML (content-type inesperado).' }
  }
  const html = await res.text()
  const text = extractTextFromHtml(html)
  if (!text) return { ok: false, error: 'Não foi possível extrair texto útil do HTML.' }
  return { ok: true, text }
}

async function extractPdfText(bytes: Uint8Array): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    // Import dinâmico para evitar crash no boot do runtime.
    const mod = await import('npm:pdf-parse')
    const pdfParse = (mod as { default?: (input: Uint8Array) => Promise<{ text?: string }> }).default
    if (!pdfParse) return { ok: false, error: 'Biblioteca pdf-parse indisponível neste runtime.' }

    const pdfData = await pdfParse(bytes)
    const text = (pdfData?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return { ok: false, error: 'PDF sem texto extraível (pode ser imagem escaneada).' }
    return { ok: true, text }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Falha ao ler PDF: ${msg}` }
  }
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function callDeepSeekReasoner(params: {
  apiKey: string
  rawText: string
}): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const key = params.apiKey.trim()
  if (!key) return { ok: false, error: 'DEEPSEEK_API_KEY não configurada.' }

  const clipped = params.rawText.length > 120_000
    ? params.rawText.slice(0, 120_000) + '\n\n[... texto truncado para limite de contexto ...]'
    : params.rawText

  const system =
    'Você é um analista de negócios especialista. Leia o texto bruto abaixo retirado de um documento/site da empresa. Extraia e resuma todas as informações cruciais sobre serviços, preços, regras e cultura. Crie um resumo limpo, direto e estratégico que será usado como base de conhecimento para um bot de atendimento no WhatsApp. Ignore lixos de formatação.'

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: clipped },
      ],
    }),
  })

  const raw = await res.text()
  let data: { choices?: Array<{ message?: { content?: string | null } }> } | null = null
  try {
    data = raw ? (JSON.parse(raw) as typeof data) : null
  } catch {
    data = null
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `DeepSeek ${res.status}: ${raw.slice(0, 500) || res.statusText}`,
    }
  }

  const summary =
    data?.choices?.[0]?.message?.content?.trim() ?? ''
  if (!summary) {
    return { ok: false, error: 'DeepSeek (reasoner) respondeu sem conteúdo.' }
  }

  return { ok: true, summary }
}

function jsonErrorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err)
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

serve(async (req) => {
  // Preflight precisa ser a PRIMEIRA coisa (fora do try/catch).
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim() ?? ''
    const deepSeekKey = Deno.env.get('DEEPSEEK_API_KEY')?.trim() ?? ''

    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ error: 'Supabase não configurado (SUPABASE_URL / SUPABASE_ANON_KEY).' }, 500)
    }
    if (!deepSeekKey) {
      return jsonResponse({ error: 'DEEPSEEK_API_KEY não configurada na função.' }, 500)
    }

    const authHeader = req.headers.get('Authorization')?.trim() ?? ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Authorization Bearer ausente.' }, 401)
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser()
    if (userErr || !user) {
      return jsonResponse({ error: 'Sessão inválida.' }, 401)
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'JSON inválido' }, 400)
    }

    const o = body as Record<string, unknown>
    const type = typeof o.type === 'string' ? o.type : ''

    let rawText = ''
    let materialType: 'link' | 'file' = 'file'
    let materialUrl: string | null = null

    if (type === 'link') {
      materialType = 'link'
      const urlStr = typeof o.url === 'string' ? o.url : ''
      const u = normalizeUrl(urlStr)
      if (!u) {
        return jsonResponse({ error: 'URL inválida ou bloqueada.' }, 400)
      }
      materialUrl = u.toString()
      const html = await fetchHtmlText(u)
      if (!html.ok) return jsonResponse({ error: html.error }, 400)
      rawText = html.text
    } else if (type === 'file') {
      materialType = 'file'
      const filePath = typeof o.filePath === 'string' ? o.filePath.trim() : ''
      if (!filePath || !filePath.startsWith(`${user.id}/`)) {
        return jsonResponse({ error: 'filePath inválido (deve começar com seu user_id/).' }, 400)
      }

      const { data, error: dlErr } = await supabase.storage
        .from('training_files')
        .download(filePath)
      if (dlErr || !data) {
        return jsonResponse({ error: dlErr?.message ?? 'Falha ao baixar arquivo do Storage.' }, 400)
      }

      const lower = filePath.toLowerCase()
      if (lower.endsWith('.txt')) {
        const text = normalizeSpaces(await data.text())
        if (!text) return jsonResponse({ error: 'Arquivo TXT vazio.' }, 400)
        rawText = text
      } else if (lower.endsWith('.pdf')) {
        const arrayBuffer = await data.arrayBuffer()
        const buffer = new Uint8Array(arrayBuffer)
        const extracted = await extractPdfText(buffer)
        if (!extracted.ok) return jsonResponse({ error: extracted.error }, 400)
        rawText = extracted.text
      } else {
        return jsonResponse(
          { error: 'Por enquanto só processamos PDF e TXT nesta função. Converta DOC/DOCX para PDF.' },
          400,
        )
      }

      const { data: pub } = supabase.storage.from('training_files').getPublicUrl(filePath)
      materialUrl = pub.publicUrl
    } else {
      return jsonResponse({ error: 'type deve ser "link" ou "file".' }, 400)
    }

    const ai = await callDeepSeekReasoner({ apiKey: deepSeekKey, rawText })
    if (!ai.ok) {
      return jsonResponse({ error: ai.error }, 500)
    }

    const { data: inserted, error: insErr } = await supabase
      .from('ai_training_materials')
      .insert({
        user_id: user.id,
        type: materialType,
        content: ai.summary,
        url: materialUrl,
        is_processed: true,
      })
      .select('id, type, content, url, is_processed, created_at')
      .single()

    if (insErr) {
      return jsonResponse({ error: insErr.message }, 500)
    }

    return jsonResponse({ ok: true, material: inserted })
  } catch (err: unknown) {
    console.error('[process-ai-training] erro inesperado:', err)
    return jsonErrorResponse(err, 500)
  }
})
