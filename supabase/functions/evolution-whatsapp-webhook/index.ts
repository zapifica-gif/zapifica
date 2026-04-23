// ============================================================================
// Webhook: eventos web da Evolution (ex.: messages.upsert) → public.chat_messages
//
// 1) Copie a URL pública: https://<ref>.supabase.co/functions/v1/evolution-whatsapp-webhook
// 2) No painel da Evolution, registe o webhook para o evento "messages.upsert" (ou
//    Webhook Geral) apontando para essa URL.
// 3) supabase secrets set EVOLUTION_WEBHOOK_SECRET=... (opcional, recomendado)
//
// Requer secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem no host)
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-webhook-secret, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function userIdFromZapificaInstance(instance: string): string | null {
  const p = 'zapifica_'
  if (!instance.startsWith(p)) return null
  const rest = instance.slice(p.length)
  if (!/^[0-9a-fA-F-]{36}$/.test(rest)) return null
  return rest
}

function extractTextAndType(msg: Record<string, unknown> | null | undefined): {
  body: string
  content: 'text' | 'audio' | 'image'
} {
  if (!msg) return { body: '', content: 'text' }
  if (msg.conversation && typeof msg.conversation === 'string') {
    return { body: msg.conversation, content: 'text' }
  }
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined
  if (ext?.text && typeof ext.text === 'string') {
    return { body: ext.text, content: 'text' }
  }
  if (msg.imageMessage && typeof msg.imageMessage === 'object') {
    const im = msg.imageMessage as Record<string, unknown>
    const c =
      typeof im.caption === 'string' && im.caption.trim() ? im.caption : ''
    return { body: c || '[imagem]', content: 'image' }
  }
  if (msg.audioMessage) {
    return { body: '[áudio]', content: 'audio' }
  }
  if (msg.videoMessage) {
    return { body: '[vídeo]', content: 'text' }
  }
  if (msg.documentMessage) {
    return { body: '[documento]', content: 'text' }
  }
  return { body: '[mensagem]', content: 'text' }
}

type UpsertItem = {
  fromMe: boolean
  remoteJid: string
  msgId: string
  message: Record<string, unknown> | null
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
    return data.flatMap((d) =>
      d && typeof d === 'object' ? collectUpsertItems(d) : [],
    )
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (o.messages && Array.isArray(o.messages)) {
      return collectUpsertItems(o.messages)
    }
    const k = normalizeKey(o.key)
    if (k && o.message) {
      return [
        {
          fromMe: k.fromMe,
          remoteJid: k.remoteJid,
          msgId: k.id,
          message: o.message as Record<string, unknown>,
        },
      ]
    }
  }
  return []
}

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

  const secret = Deno.env.get('EVOLUTION_WEBHOOK_SECRET')?.trim() ?? ''
  if (secret) {
    const h = req.headers.get('x-webhook-secret')?.trim() ?? ''
    const auth = req.headers.get('authorization')?.trim() ?? ''
    const bearer = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7)
      : ''
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

  if (event && event.toLowerCase() !== 'messages.upsert') {
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
        error:
          'Instance não segue a convenção zapifica_<user_uuid>. Ajuste o nome da instância no Evolution.',
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
    .select('id, phone')
    .eq('user_id', userId)

  if (leErr) {
    return new Response(JSON.stringify({ error: leErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  const leads = (allLeads ?? []) as { id: string; phone: string | null }[]
  const leadByPhone = new Map<string, string>()
  for (const l of leads) {
    const d = toEvolutionDigits(l.phone ?? null)
    if (d) leadByPhone.set(d, l.id)
  }

  let saved = 0
  const skipped: string[] = []

  for (const item of items) {
    if (item.fromMe) {
      skipped.push(`fromMe:${item.msgId}`)
      continue
    }
    const phoneDigits = toEvolutionDigits(item.remoteJid)
    if (!phoneDigits) {
      skipped.push(`badJid:${item.remoteJid}`)
      continue
    }
    const leadId = leadByPhone.get(phoneDigits)
    if (!leadId) {
      skipped.push(`noLead:${phoneDigits}`)
      continue
    }
    const { body: text, content: contentType } = extractTextAndType(item.message)
    if (!item.msgId) {
      skipped.push('noMsgId')
      continue
    }
    const { error: insErr } = await supabase.from('chat_messages').insert({
      lead_id: leadId,
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
      return new Response(JSON.stringify({ error: insErr.message, detail: insErr }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
    saved++
  }

  return new Response(
    JSON.stringify({ ok: true, saved, skipped, count: items.length }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
  )
})
