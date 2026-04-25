// ============================================================================
// Webhook: Evolution API (messages.upsert) → public.chat_messages
//
// Regras desta função:
//   1. Extrai o número do remetente de `key.remoteJid` (ou `remoteJid`) e
//      remove qualquer sufixo tipo `@s.whatsapp.net`.
//   2. Normaliza o número pra formato BR com DDI 55 (toEvolutionDigits) e
//      também gera uma "cauda nacional" (últimos 10/11 dígitos) para casar
//      com leads salvos sem o 55.
//   3. Se o número não existir na tabela `leads` para aquele `user_id`,
//      CRIA o lead automaticamente (status = 'novo').
//   4. Só depois de garantir que o lead existe, insere a mensagem em
//      `chat_messages`.
//   5. Grupos (@g.us) e mensagens "fromMe" (enviadas pela agência) são
//      ignorados nesta rotina — o envio pelo app já grava a mensagem local.
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-webhook-secret, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------------------------------------------------------------------------
// Helpers de telefone
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers de payload da Evolution
// ---------------------------------------------------------------------------

function userIdFromZapificaInstance(instance: string): string | null {
  const p = 'zapifica_'
  if (!instance.startsWith(p)) return null
  const rest = instance.slice(p.length)
  if (!/^[0-9a-fA-F-]{36}$/.test(rest)) return null
  return rest
}

function extractTextAndType(msg: Record<string, unknown> | null | undefined): {
  body: string
  content: 'text' | 'audio' | 'image' | 'video' | 'document' | 'unknown'
} {
  if (!msg) return { body: '', content: 'unknown' }
  
  // Tratamento mais resiliente para vários formatos da Evolution
  if (typeof msg.conversation === 'string' && msg.conversation) {
    return { body: msg.conversation, content: 'text' }
  }
  
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined
  if (ext && typeof ext.text === 'string' && ext.text) {
    return { body: ext.text, content: 'text' }
  }
  
  if (msg.imageMessage && typeof msg.imageMessage === 'object') {
    const im = msg.imageMessage as Record<string, unknown>
    const c = typeof im.caption === 'string' && im.caption.trim() ? im.caption : ''
    return { body: c || '[imagem]', content: 'image' }
  }
  
  if (msg.audioMessage) return { body: '[áudio]', content: 'audio' }
  if (msg.videoMessage) return { body: '[vídeo]', content: 'video' }
  if (msg.documentMessage) return { body: '[documento]', content: 'document' }
  
  // Se ainda não achou, converte o objeto inteiro para string (melhor que falhar)
  return { body: JSON.stringify(msg).substring(0, 200), content: 'text' }
}

type UpsertItem = {
  fromMe: boolean
  remoteJid: string
  msgId: string
  message: Record<string, unknown> | null
  pushName: string | null
}

function normalizeKey(key: unknown): { remoteJid: string; id: string; fromMe: boolean } | null {
  if (!key || typeof key !== 'object') return null
  const o = key as Record<string, unknown>
  const remoteJid = typeof o.remoteJid === 'string' ? o.remoteJid : ''
  const id = typeof o.id === 'string' ? o.id : ''
  const fromMe = o.fromMe === true
  if (!remoteJid || !id) return null
  return { remoteJid, id, fromMe }
}

function collectUpsertItems(data: unknown): UpsertItem[] {
  if (data == null) return []

  if (Array.isArray(data)) {
    return data.flatMap((d) => (d && typeof d === 'object' ? collectUpsertItems(d) : []))
  }

  if (typeof data === 'object') {
    const o = data as Record<string, unknown>

    if (o.messages && Array.isArray(o.messages)) {
      return collectUpsertItems(o.messages)
    }

    const k = normalizeKey(o.key)
    if (k && o.message) {
      const pushName = typeof o.pushName === 'string' && o.pushName.trim() ? o.pushName.trim() : null
      return [
        {
          fromMe: k.fromMe,
          remoteJid: k.remoteJid,
          msgId: k.id,
          message: o.message as Record<string, unknown>,
          pushName,
        },
      ]
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Lookup + auto-criação de lead
// ---------------------------------------------------------------------------

type LeadRow = { id: string; phone: string | null; name: string | null }

type LeadIndex = {
  byFull: Map<string, string>
  byTail: Map<string, string>
  rows: LeadRow[]
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

  const displayName = (pushName && pushName.slice(0, 80)) || `Novo Lead ${prettifyPhone(fullDigits)}`

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

  const retry = await supabase.from('leads').select('id, phone, name').eq('user_id', userId)

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

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  // Bloco Try-Catch global para evitar que o worker capote (unhandled promise rejection)
  try {
    const secret = Deno.env.get('EVOLUTION_WEBHOOK_SECRET')?.trim() ?? ''
    if (secret) {
      const h = req.headers.get('x-webhook-secret')?.trim() ?? ''
      const auth = req.headers.get('authorization')?.trim() ?? ''
      const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : ''
      if (h !== secret && bearer !== secret) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const b = (body as Record<string, unknown>) || {}
    const event = (typeof b.event === 'string' && b.event) || ''
    const instance = (typeof b.instance === 'string' && b.instance) || ''

    const normalizedEvent = event.toLowerCase().replace('_', '.')
    if (normalizedEvent && normalizedEvent !== 'messages.upsert') {
      return new Response(JSON.stringify({ ok: true, ignored: true, event }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const userId = userIdFromZapificaInstance(instance)
    if (!userId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Instance não segue a convenção zapifica_<user_uuid>. Ajuste o nome da instância na Evolution.',
          instance,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      )
    }

    const items = collectUpsertItems(b.data ?? b)
    if (items.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: 'Nenhum item messages.upsert no payload' }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: allLeads, error: leErr } = await supabase
      .from('leads')
      .select('id, phone, name')
      .eq('user_id', userId)

    if (leErr) {
      return new Response(JSON.stringify({ error: leErr.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const index = buildLeadIndex((allLeads ?? []) as LeadRow[])

    let saved = 0
    let createdLeads = 0
    const skipped: string[] = []
    const errors: string[] = []

    for (const item of items) {
      try {
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

        const ensured = await ensureLeadId(supabase, userId, index, phoneDigits, item.pushName)
        if (!ensured.id) {
          errors.push(`lead:${phoneDigits}:${ensured.error ?? 'sem id'}`)
          continue
        }
        if (ensured.created) createdLeads++

        const { body: text, content: contentType } = extractTextAndType(item.message)

        const { error: insErr } = await supabase.from('chat_messages').insert({
          lead_id: ensured.id,
          sender_type: 'cliente',
          content_type: contentType,
          message_body: text,
          evolution_message_id: item.msgId,
        })

        if (insErr) {
          if (insErr.code === '23505') {
            skipped.push(`dup:${item.msgId}`)
            continue
          }
          errors.push(`msg:${item.msgId}:${insErr.message}`)
          continue
        }
        saved++
      } catch (itemError: any) {
        // Se der erro numa mensagem específica, registra e vai pra próxima
        console.error("Erro ao processar item específico:", itemError)
        errors.push(`msgError:${item.msgId}:${itemError.message}`)
      }
    }

    const ok = errors.length === 0
    return new Response(
      JSON.stringify({
        ok,
        saved,
        createdLeads,
        skipped,
        errors,
        count: items.length,
      }),
      {
        status: ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    )
  } catch (globalError: any) {
    // Captura qualquer erro global (O tal do Unhandled Promise Rejection)
    console.error("Erro Global no Webhook:", globalError)
    return new Response(JSON.stringify({ error: 'Erro interno no webhook', details: globalError.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
})