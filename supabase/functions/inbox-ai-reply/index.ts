// ============================================================================
// Inbox: após insert em public.chat_messages (sender cliente) → DeepSeek
//     → grava resposta (sender_type ia) + envia WhatsApp (Evolution sendText)
//
// Acionada por: Supabase **Database Webhook** (INSERT em chat_messages), ou
// teste via curl com o mesmo corpo.
//
// Ordem com o ZapVoice (defesa em profundidade contra race condition):
//   1) HARD BLOCK síncrono: se o texto casa com gatilho de campanha ativa
//      do tenant, aborta antes do delay/LLM (return 'campaign_trigger_reserved').
//   2) Delay aleatório de 5–6 s: dá ao webhook do funil tempo para gravar progresso.
//   3) HARD LOCK: se há lead_campaign_progress ativo, aborta.
//
// Secrets obrigatórios:
//   * DEEPSEEK_API_KEY
//   * INBOX_AI_WEBHOOK_SECRET   (o Dashboard do DB Webhook envia: Authorization: Bearer <isto>)
//   * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   * EVOLUTION_API_URL, EVOLUTION_API_KEY
//
// Deploy:  npx supabase functions deploy inbox-ai-reply
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'
/** Últimas N mensagens cronológicas carregadas (mais antiga → mais recente no prompt). */
const HISTORY_LIMIT = 20
const DEEPSEEK_TIMEOUT_MS = 60_000

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-webhook-secret, content-type, apikey, x-inbox-ai-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ZAPIFICA_SYSTEM = `Age como a atendente comercial virtual da agência Zapifica.
Regras: responde em português (Brasil), tom cordial, profissional e direto, adequado ao WhatsApp.
Ajudas com informações da agência, prazos, qualificação de leads e próximos passos.
Não inventes preços, números contratuais ou serviços inexistentes: se faltar dado, diz que um consultor humano pode alinhar.
Mensagens curtas (em geral até 2–3 parágrafos), sem jargão excessivo.

REGRA DE OURO: Aja como um humano natural. NUNCA inicie todas as frases com o nome do cliente. Se você já o cumprimentou, continue a conversa normalmente sem repetir o nome.`

const MS_24H = 24 * 60 * 60 * 1000

/** timestamptz do PostgREST → comparação segura com Date.now() (evita falsos negativos de parse). */
function isAiPausedUntilActive(aiPausedUntil: unknown): boolean {
  if (aiPausedUntil == null) return false
  const raw =
    typeof aiPausedUntil === 'string'
      ? aiPausedUntil.trim()
      : String(aiPausedUntil).trim()
  if (!raw) return false
  const pauseTime = new Date(raw).getTime()
  if (!Number.isFinite(pauseTime)) return false
  return Date.now() < pauseTime
}

type ChatMessageRow = {
  id: string
  lead_id: string
  sender_type: string
  content_type: string
  message_body: string | null
  ai_suppressed?: boolean | null
  created_at: string
}

type LeadRow = {
  id: string
  user_id: string
  phone: string | null
  name: string | null
  funnel_locked_until?: string | null
}

function extractClientFirstNameForAi(
  leadName: string | null | undefined,
  phoneDigits: string | null | undefined,
): string | null {
  const name = (leadName ?? '').trim()
  if (!name) return null
  const phoneNorm = (phoneDigits ?? '').replace(/\D/g, '')
  const nameDigitsOnly = name.replace(/\D/g, '')
  if (phoneNorm && nameDigitsOnly === phoneNorm) return null
  const rawDigits = phoneDigits ?? ''
  if ((rawDigits && name === rawDigits.trim()) || (phoneNorm && name.replace(/\s/g, '') === phoneNorm)) {
    return null
  }
  const first = (name.split(/\s+/)[0] ?? '').trim()
  const cleaned = first
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}'-]/gu, '')
    .replace(/^['-]+|['-]+$/g, '')
  return cleaned || null
}

function formatConversationHistoryPortuguese(
  rows: ReadonlyArray<{ sender_type: string; message_body: string | null }>,
): string {
  const lines: string[] = []
  for (const m of rows) {
    const t = (m.message_body ?? '').trim()
    if (!t) continue
    const role =
      m.sender_type === 'cliente'
        ? 'Cliente'
        : m.sender_type === 'agencia' || m.sender_type === 'ia'
          ? 'Você'
          : `Remetente(${m.sender_type})`
    lines.push(`${role}: ${t}`)
  }
  return lines.join('\n')
}

type TriggerCondition = 'equals' | 'contains' | 'starts_with' | 'not_contains'

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function triggerConditionSatisfied(
  condition: TriggerCondition,
  messageNorm: string,
  keywordRaw: string,
): boolean {
  const kw = normText(keywordRaw)
  if (condition === 'not_contains') {
    if (!kw) return false
    return !messageNorm.includes(kw)
  }
  if (!kw) return false
  switch (condition) {
    case 'equals':
      return messageNorm === kw
    case 'contains':
      return messageNorm.includes(kw)
    case 'starts_with':
      return messageNorm.startsWith(kw)
    default:
      return false
  }
}

/** Espera o webhook do Evolution/ZapVoice gravar progresso antes da IA consultar o banco (evita corrida). */
function inboxIaEntryDelayMs(): number {
  return Math.floor(Math.random() * (6000 - 5000 + 1)) + 5000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function instanceNameFromUserId(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9-]/g, '_')
  return `zapifica_${safe}`.slice(0, 80)
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

function extractAuthBearer(req: Request): string {
  const h = req.headers.get('authorization')?.trim() ?? ''
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
  return req.headers.get('x-inbox-ai-secret')?.trim() ?? ''
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

/** Extrai o record a partir do payload do Supabase Database Webhook ou de teste manual. */
function extractInsertRecord(
  body: unknown,
): { table: string; type: string; record: Record<string, unknown> | null } {
  if (!body || typeof body !== 'object') {
    return { table: '', type: '', record: null }
  }
  const b = body as Record<string, unknown>
  const type = typeof b.type === 'string' ? b.type : ''
  const table = typeof b.table === 'string' ? b.table : ''
  const rec = b.record
  if (rec && typeof rec === 'object') {
    return { type, table, record: rec as Record<string, unknown> }
  }
  return { type, table, record: null }
}

function boolValue(value: unknown): boolean | null {
  if (value === true) return true
  if (value === false) return false
  return null
}

async function callDeepSeek(
  systemPrompt: string,
  userMessages: { role: string; content: string }[],
  apiKey: string,
): Promise<{ text: string | null; error: string | null }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS)
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.45,
        max_tokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          ...userMessages,
        ],
      }),
    })
    const raw = await res.text()
    if (!res.ok) {
      return { text: null, error: `DeepSeek ${res.status}: ${raw.slice(0, 500)}` }
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return { text: null, error: 'DeepSeek: resposta não-JSON' }
    }
    const o = data as Record<string, unknown>
    const choices = o.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      return { text: null, error: 'DeepSeek: sem choices' }
    }
    const c0 = choices[0] as Record<string, unknown>
    const msg = c0.message as Record<string, unknown> | undefined
    const content = typeof msg?.content === 'string' ? msg.content : ''
    const trimmed = content.trim()
    if (!trimmed) {
      return { text: null, error: 'DeepSeek: resposta vazia' }
    }
    return { text: trimmed, error: null }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (m.includes('aborted') || m.includes('AbortError')) {
      return { text: null, error: 'DeepSeek: timeout' }
    }
    return { text: null, error: m }
  } finally {
    clearTimeout(t)
  }
}

function extractEvolutionMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const messageBlock = o.message as Record<string, unknown> | undefined
  const keyBlock =
    (messageBlock?.key as Record<string, unknown> | undefined) ??
    (o.key as Record<string, unknown> | undefined)
  if (keyBlock && typeof keyBlock.id === 'string' && keyBlock.id.length > 0) {
    return keyBlock.id
  }
  return null
}

async function sendEvolutionText(
  baseUrl: string,
  apiKey: string,
  instanceName: string,
  number: string,
  text: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = `${baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number, text: text.slice(0, 12000) }),
  })
  const textBody = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(textBody)
  } catch {
    // manter nulo; usar texto
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : textBody.slice(0, 400) || res.statusText
    return { ok: false, error: `Evolution ${res.status}: ${msg}` }
  }
  return { ok: true, data: data ?? textBody }
}

async function runPipeline(
  supabase: SupabaseClient,
  triggerRow: ChatMessageRow,
  deepseekKey: string,
  evolutionUrl: string,
  evolutionKey: string,
): Promise<Record<string, unknown>> {
  // Identifica o lead primeiro (precisamos do user_id para checar campanhas).
  const { data: lead, error: leErr } = await supabase
    .from('leads')
    .select('id, user_id, phone, name, funnel_locked_until')
    .eq('id', triggerRow.lead_id)
    .maybeSingle()

  if (leErr) {
    return { error: `lead: ${leErr.message}` }
  }
  if (!lead) {
    return { error: 'Lead não encontrado' }
  }

  const leadData = lead as LeadRow

  // Pausa humana já gravada antes deste disparo (ex.: fromMe chegou primeiro).
  const { data: pauseEarly, error: pauseEarlyErr } = await supabase
    .from('leads')
    .select('ai_paused_until')
    .eq('id', triggerRow.lead_id)
    .maybeSingle()
  if (pauseEarlyErr) {
    return { error: `ai_pause_check_early: ${pauseEarlyErr.message}` }
  }
  if (
    isAiPausedUntilActive(
      (pauseEarly as { ai_paused_until?: unknown } | null)?.ai_paused_until,
    )
  ) {
    return {
      ok: true,
      ignored: 'ai_paused_human_handoff',
      lead_id: triggerRow.lead_id,
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // HARD BLOCK 1 (síncrono, antes do delay e do LLM):
  // Se o texto bate com o gatilho de QUALQUER campanha ativa do tenant,
  // a mensagem pertence ao funil. A IA aborta sem gastar 5,5 s nem tokens.
  // ───────────────────────────────────────────────────────────────────────
  if (triggerRow.content_type === 'text') {
    const raw = (triggerRow.message_body ?? '').trim()
    if (
      raw &&
      !/^\[(imagem|áudio|vídeo|documento|mensagem)\]$/i.test(raw)
    ) {
      const messageNorm = normText(raw)
      const { data: campRows, error: campErr } = await supabase
        .from('zv_campaigns')
        .select('id, trigger_keyword, trigger_condition')
        .eq('user_id', leadData.user_id)
        .eq('status', 'active')
      if (campErr) {
        return { error: `zv_campaigns: ${campErr.message}` }
      }
      for (const row of campRows ?? []) {
        const cond = ((row as { trigger_condition?: string }).trigger_condition ??
          'equals') as TriggerCondition
        const kw = (row as { trigger_keyword?: string | null }).trigger_keyword ?? ''
        if (triggerConditionSatisfied(cond, messageNorm, kw)) {
          return {
            ok: true,
            ignored: 'campaign_trigger_reserved',
            lead_id: triggerRow.lead_id,
            zv_campaign_id: (row as { id?: string }).id ?? null,
          }
        }
      }
    }
  }

  // Delay anti-corrida: dá ao webhook do funil tempo para gravar progresso/lock.
  await sleep(inboxIaEntryDelayMs())

  // HARD LOCK 2: progresso ZapVoice (active ou aguardando último envio).
  const { count: progCount, error: progErr } = await supabase
    .from('lead_campaign_progress')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', triggerRow.lead_id)
    .eq('user_id', leadData.user_id)
    .in('status', ['active', 'awaiting_last_send'])
  if (progErr) {
    return { error: `progress: ${progErr.message}` }
  }
  if ((progCount ?? 0) > 0) {
    return { ok: true, ignored: 'hard_lock_progress_active', lead_id: triggerRow.lead_id }
  }

  // HARD LOCK: última mensagem com supressão (corrida com insert do webhook).
  const { data: lastMsg, error: lastErr } = await supabase
    .from('chat_messages')
    .select('ai_suppressed, created_at')
    .eq('lead_id', triggerRow.lead_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastErr) {
    return { error: `last_msg: ${lastErr.message}` }
  }
  if ((lastMsg as { ai_suppressed?: boolean | null } | null)?.ai_suppressed === true) {
    return { ok: true, ignored: 'hard_lock_last_message_suppressed', lead_id: triggerRow.lead_id }
  }
  const lockedUntilIso = (leadData.funnel_locked_until ?? null)?.trim?.() ?? null
  if (lockedUntilIso) {
    const t = new Date(lockedUntilIso).getTime()
    if (!Number.isNaN(t) && Date.now() < t) {
      return {
        ok: true,
        ignored: 'lead_in_funnel',
        lead_id: leadData.id,
        funnel_locked_until: lockedUntilIso,
      }
    }
  }

  // Human handoff: releitura após o delay anti-corrida (fromMe pode ter pausado a IA durante a espera).
  const { data: pauseRow, error: pauseErr } = await supabase
    .from('leads')
    .select('ai_paused_until')
    .eq('id', triggerRow.lead_id)
    .maybeSingle()
  if (pauseErr) {
    return { error: `ai_pause_check: ${pauseErr.message}` }
  }
  const pauseRawLate = (pauseRow as { ai_paused_until?: unknown } | null)?.ai_paused_until
  if (isAiPausedUntilActive(pauseRawLate)) {
    return {
      ok: true,
      ignored: 'ai_paused_human_handoff',
      lead_id: triggerRow.lead_id,
    }
  }

  const destination = toEvolutionDigits(leadData.phone)
  if (!destination) {
    return { error: 'Telefone do lead inválido para a Evolution' }
  }

  const cutoff24hIso = new Date(Date.now() - MS_24H).toISOString()
  const [{ data: historyDesc, error: hErr }, { count: countMsgs24h, error: c24Err }] =
    await Promise.all([
      supabase
        .from('chat_messages')
        .select('id, lead_id, sender_type, content_type, message_body, created_at')
        .eq('lead_id', triggerRow.lead_id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT),
      supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', triggerRow.lead_id)
        .gte('created_at', cutoff24hIso),
    ])

  if (hErr) {
    return { error: `history: ${hErr.message}` }
  }
  const interactionCount24h = countMsgs24h ?? 0
  const includeClientNameHint = !c24Err && interactionCount24h < 2

  const rowsChrono = [...(historyDesc ?? [])].reverse() as ChatMessageRow[]

  const triggerText = (triggerRow.message_body ?? '').trim()
  if (!triggerText) {
    return { error: 'Sem texto na mensagem do cliente para a IA responder' }
  }

  const historyPortugueseBlock = formatConversationHistoryPortuguese(rowsChrono)
  const clientFirst = extractClientFirstNameForAi(leadData.name, destination)

  let systemPrompt = ZAPIFICA_SYSTEM

  if (clientFirst && includeClientNameHint) {
    systemPrompt +=
      `\n\n--- CONTEXTO DO CONTATO ---\n` +
      `O nome do cliente com quem você está falando é ${clientFirst}. ` +
      `Só cumprimente pelo nome quando fizer sentido no início; depois converse de forma natural, sem repetir o nome.\n`
  }

  if (historyPortugueseBlock.trim()) {
    systemPrompt +=
      `\n--- HISTÓRICO RECENTE DA CONVERSA ---\n` +
      `Trecho em ordem cronológica (do mais antigo ao mais recente). ` +
      `"Cliente" é a pessoa atendida; "Você" é a empresa (humano ou você, o assistente).\n\n` +
      `${historyPortugueseBlock}\n`
  }

  const { data: pausePreLlm, error: pausePreErr } = await supabase
    .from('leads')
    .select('ai_paused_until')
    .eq('id', triggerRow.lead_id)
    .maybeSingle()
  if (pausePreErr) {
    return { error: `ai_pause_pre_llm: ${pausePreErr.message}` }
  }
  if (isAiPausedUntilActive((pausePreLlm as { ai_paused_until?: unknown } | null)?.ai_paused_until)) {
    return {
      ok: true,
      ignored: 'ai_paused_human_handoff',
      lead_id: triggerRow.lead_id,
    }
  }

  const { text, error: dsErr } = await callDeepSeek(
    systemPrompt,
    [{ role: 'user', content: triggerText }],
    deepseekKey,
  )
  if (dsErr || !text) {
    return { error: dsErr ?? 'DeepSeek sem texto' }
  }

  const { data: insData, error: insErr } = await supabase
    .from('chat_messages')
    .insert({
      lead_id: triggerRow.lead_id,
      sender_type: 'ia',
      content_type: 'text',
      message_body: text,
      evolution_message_id: null,
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    return { error: `insert ia: ${insErr.message}` }
  }
  const iaId = (insData as { id: string } | null)?.id

  const instanceName = instanceNameFromUserId(leadData.user_id)
  const evo = await sendEvolutionText(
    evolutionUrl,
    evolutionKey,
    instanceName,
    destination,
    text,
  )

  if (!evo.ok) {
    const notice =
      text +
      '\n\n— (Aviso: a resposta não foi entregue automaticamente ao WhatsApp. Erro: ' +
      evo.error.slice(0, 200) +
      '.)'
    if (iaId) {
      await supabase
        .from('chat_messages')
        .update({ message_body: notice })
        .eq('id', iaId)
    }
    return {
      ok: true,
      deepseek: true,
      insert_ia_id: iaId,
      evolution_sent: false,
      evolution_error: evo.error,
    }
  }

  const eid = extractEvolutionMessageId(evo.data)
  if (iaId && eid) {
    await supabase
      .from('chat_messages')
      .update({ evolution_message_id: eid })
      .eq('id', iaId)
  }

  return {
    ok: true,
    deepseek: true,
    insert_ia_id: iaId,
    evolution_message_id: eid,
    evolution_sent: true,
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const expectedSecret = Deno.env.get('INBOX_AI_WEBHOOK_SECRET')?.trim() ?? ''
  if (!expectedSecret) {
    return jsonResponse(
      {
        error:
          'Configure a secret INBOX_AI_WEBHOOK_SECRET (e use o mesmo no Database Webhook).',
      },
      500,
    )
  }

  const got = extractAuthBearer(req)
  if (got !== expectedSecret) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const deepseekKey = Deno.env.get('DEEPSEEK_API_KEY')?.trim() ?? ''
  if (!deepseekKey) {
    return jsonResponse(
      { error: 'Defina a secret DEEPSEEK_API_KEY no projeto (Supabase secrets).' },
      500,
    )
  }

  const evolutionUrl = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  const evolutionKey = Deno.env.get('EVOLUTION_API_KEY') ?? ''
  if (!evolutionUrl || !evolutionKey) {
    return jsonResponse(
      {
        error:
          'Defina EVOLUTION_API_URL e EVOLUTION_API_KEY (as mesmas que o process-scheduled-messages).',
      },
      500,
    )
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes' }, 500)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const { type, table, record } = extractInsertRecord(body)
  if (type && type.toUpperCase() !== 'INSERT') {
    return jsonResponse({ ok: true, ignored: 'not_insert', type })
  }
  if (table && table !== 'chat_messages') {
    return jsonResponse({ ok: true, ignored: 'wrong_table', table })
  }
  if (!record) {
    return jsonResponse({ error: 'Payload sem record' }, 400)
  }

  const sender = typeof record.sender_type === 'string' ? record.sender_type : ''
  if (sender !== 'cliente') {
    return jsonResponse({ ok: true, ignored: 'sender_not_cliente', sender_type: sender })
  }

  const triggerRow: ChatMessageRow = {
    id: typeof record.id === 'string' ? record.id : '',
    lead_id: typeof record.lead_id === 'string' ? record.lead_id : '',
    sender_type: 'cliente',
    content_type: typeof record.content_type === 'string' ? record.content_type : 'text',
    message_body: typeof record.message_body === 'string' ? record.message_body : null,
    ai_suppressed: boolValue(record.ai_suppressed) ?? null,
    created_at: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
  }
  if (!triggerRow.lead_id) {
    return jsonResponse({ error: 'record.lead_id em falta' }, 400)
  }
  if (triggerRow.ai_suppressed === true) {
    return jsonResponse({ ok: true, ignored: 'ai_suppressed_on_message', lead_id: triggerRow.lead_id })
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  try {
    const result = await runPipeline(
      supabase,
      triggerRow,
      deepseekKey,
      evolutionUrl,
      evolutionKey,
    )
    if (result.error) {
      // Falha lógica (DeepSeek, DB, lead): 500 → Database Webhook pode reintentar
      return jsonResponse(
        { ok: false, ...result },
        500,
      )
    }
    return jsonResponse({ ...result, ok: true }, 200)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return jsonResponse({ ok: false, error: message }, 500)
  }
})
