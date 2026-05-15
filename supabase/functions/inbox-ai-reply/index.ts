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
//      Prioridade de negócio: funil/campanha > override `ai_enabled` no CRM.
//   2) Delay aleatório de 5–6 s: dá ao webhook do funil tempo para gravar progresso.
//   3) HARD LOCK: progresso ativo, ai_paused_for_zv_dispatch, fila ZV pendente
//      ou última mensagem com ai_suppressed — sempre respeitados (idem).
//      Self-healing: se `ai_paused_for_zv_dispatch` estiver true sem funil ZV real
//      nem fila pendente, a Edge corrige `leads` e segue com o DeepSeek (6 leituras,
//      2s entre falhas ≈10s; re-poll de progresso/fila antes do self-heal quando pause ZV ativo).
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
// Permite override via secret/env sem redeploy (ex.: deepseek-chat vs deepseek-reasoner).
const DEEPSEEK_MODEL = (Deno.env.get('DEEPSEEK_MODEL')?.trim() || 'deepseek-reasoner')
/** Últimas N mensagens cronológicas carregadas (mais antiga → mais recente no prompt). */
const HISTORY_LIMIT = 20
// Reasoner tende a demorar mais. Mantemos folga abaixo do limite típico da Edge Function.
const DEEPSEEK_TIMEOUT_MS = 110_000
/** Entre leituras do self-heal e re-polls de progresso/fila (race pós-disparo vs inbox). */
const INBOX_ZV_SELF_HEAL_RETRY_MS = 2000
/**
 * 6 leituras com até 5 × 2s de espera = 10s de janela (≥5 tentativas com intervalo de 2s).
 * O loop de self-heal faz até (MAX_ATTEMPTS - 1) sleeps entre leituras.
 */
const INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS = 6

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-webhook-secret, content-type, apikey, x-inbox-ai-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ZAPIFICA_SYSTEM = `Você é a atendente comercial virtual da agência Zapifica.
Objetivo: converter leads em conversa/agenda, com respostas curtas, diretas, específicas e persuasivas, no estilo WhatsApp.

REGRAS EXTREMAMENTE RIGOROSAS DE TAMANHO (WHATSAPP):
- ATENÇÃO: O canal é WhatsApp. Suas respostas devem ser EXTREMAMENTE curtas, diretas, leves e conversacionais.
- REGRA DE OURO: responda usando NO MÁXIMO 1 ou 2 frases curtas (máximo de 1 a 2 linhas reais no celular). Vá direto ao ponto.
- PROIBIDO: é estritamente proibido enviar múltiplos parágrafos, listas longas, blocos de texto ou formatação complexa.
- PROIBIDO: nunca faça mais de UMA pergunta na mesma mensagem.
- Aja de forma natural, entregando UMA informação por vez, como um humano faria no WhatsApp, induzindo uma conversa fluida de bate e volta.

REGRAS IMPORTANTES (ZERO ALUCINAÇÃO):
- Baseie-se APENAS nas informações fornecidas no contexto (master prompt + base de conhecimento + histórico).
- NUNCA invente dados, preços, prazos, garantias, nomes de planos, números ou qualquer detalhe não presente no contexto.
- Se faltar informação, diga claramente o que está faltando e proponha o próximo passo com um humano para alinhar.

Como responder:
- Português do Brasil, tom cordial, profissional e direto.
- Seja específico: cite o que você entendeu da necessidade e o próximo passo.
- Faça 1–2 perguntas objetivas de qualificação quando necessário (ex.: segmento, cidade, ticket, prazo).
- Sempre feche com uma CTA simples (ex.: “posso te fazer 2 perguntas rápidas?” / “quer que eu te passe as opções?”).
- Mensagens curtas (em geral até 2–3 parágrafos), sem jargão excessivo.

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
  /** Preenchido pelo webhook Evolution — validado contra o dono do lead. */
  evolution_instance_name?: string | null
}

type LeadRow = {
  id: string
  user_id: string
  phone: string | null
  name: string | null
  funnel_locked_until?: string | null
  /** Trava Zap Voice por lead — sem janelas fixas de horas ligadas ao fim da campanha inteira */
  ai_paused_for_zv_dispatch?: boolean | null
  /** false = modo humano explícito; null/undefined/true = IA permitida (painel "IA Ligada"). */
  ai_enabled?: boolean | null
}

/** Mesma regra do evolution-whatsapp-webhook: só conta progresso cuja campanha pai está `active`. */
async function countLeadZvProgressBlockingAiInbox(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
): Promise<{ count: number; error: { message: string } | null }> {
  const { data: rows, error } = await supabase
    .from('lead_campaign_progress')
    .select('campaign_id')
    .eq('lead_id', leadId)
    .eq('user_id', userId)
    .in('status', ['active', 'awaiting_last_send'])
  if (error) {
    return { count: 0, error: { message: error.message } }
  }
  const list = rows ?? []
  if (list.length === 0) return { count: 0, error: null }
  const ids = [...new Set(list.map((r) => (r as { campaign_id: string }).campaign_id))]
  const { data: camps, error: cErr } = await supabase
    .from('zv_campaigns')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('id', ids)
  if (cErr) {
    console.warn('[inbox-ai-reply] count progress + campanha ativa:', cErr.message)
    return { count: list.length, error: null }
  }
  const active = new Set((camps ?? []).map((c) => (c as { id: string }).id))
  const count = list.filter((r) => active.has((r as { campaign_id: string }).campaign_id)).length
  return { count, error: null }
}

/** Mesma regra que `zapvoice-inbound`: mensagens ZV pendentes/processando bloqueiam IA genérica. */
async function countPendingZvScheduledForLead(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('lead_id', leadId)
    .not('zv_campaign_id', 'is', null)
    .in('status', ['pending', 'processing'])
    .eq('is_active', true)
  if (error) {
    console.warn('[inbox-ai-reply] contagem fila ZV:', error.message)
    return 0
  }
  return count ?? 0
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

/** Alinhado a `zapvoice-inbound.ts` (acentos, espaços). */
function normText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function splitTriggerKeywordsRaw(keywordsRaw: string): string[] {
  return String(keywordsRaw ?? '')
    .split(/[,\n;]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
}

function triggerConditionSatisfiedSingle(
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

function triggerConditionSatisfiedAny(
  condition: TriggerCondition,
  messageNorm: string,
  keywordsCsvRaw: string,
): boolean {
  const rawList = splitTriggerKeywordsRaw(keywordsCsvRaw)
  const kws = rawList.map(normText).filter(Boolean)
  if (kws.length === 0) return false

  if (condition === 'not_contains') {
    return kws.every((kw) => !messageNorm.includes(kw))
  }

  for (const kw of kws) {
    if (triggerConditionSatisfiedSingle(condition, messageNorm, kw)) return true
  }
  return false
}

/** Espera o webhook do Evolution/ZapVoice gravar progresso antes da IA consultar o banco (evita corrida). */
function inboxIaEntryDelayMs(): number {
  return Math.floor(Math.random() * (6000 - 5000 + 1)) + 5000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Uma tentativa de auto-cura (logs com `attempt` para Supabase Logs).
 */
async function trySelfHealStaleZvDispatchPauseInboxOnce(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  attempt: number,
): Promise<boolean> {
  const [progRes, pendRes] = await Promise.all([
    countLeadZvProgressBlockingAiInbox(supabase, userId, leadId),
    supabase
      .from('scheduled_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .not('zv_campaign_id', 'is', null)
      .in('status', ['pending', 'processing'])
      .eq('is_active', true),
  ])
  const pendCt = pendRes.count ?? 0
  const pendErrMsg = pendRes.error?.message ?? null
  const progErrMsg = progRes.error?.message ?? null

  console.log('[inbox-ai-reply][self-heal] snapshot', {
    lead_id: leadId,
    attempt,
    scheduled_zv_pending_or_processing_count: pendCt,
    scheduled_zv_count_error: pendErrMsg,
    lead_campaign_progress_blocking_count: progRes.count,
    progress_count_error: progErrMsg,
  })

  if (progRes.error || pendRes.error) {
    console.warn(
      '[inbox-ai-reply][self-heal] abort tentativa: checagem incompleta',
      attempt,
      progErrMsg ?? pendErrMsg,
    )
    return false
  }
  if (progRes.count > 0 || pendCt > 0) {
    console.log('[inbox-ai-reply][self-heal] abort tentativa: fila ou funil ainda bloqueia', {
      attempt,
      lead_id: leadId,
      pend_exact: pendCt,
      prog_blocking_exact: progRes.count,
    })
    return false
  }

  const { data: row, error: leErr } = await supabase
    .from('leads')
    .select('ai_paused_for_zv_dispatch')
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle()
  if (leErr || !row) {
    if (leErr) console.warn('[inbox-ai-reply][self-heal] read lead', attempt, leErr.message)
    return false
  }
  const flagOn =
    (row as { ai_paused_for_zv_dispatch?: boolean | null }).ai_paused_for_zv_dispatch === true
  console.log('[inbox-ai-reply][self-heal] lead flag', {
    attempt,
    lead_id: leadId,
    ai_paused_for_zv_dispatch: flagOn,
  })
  if (!flagOn) {
    console.log('[inbox-ai-reply][self-heal] ok tentativa: flag já false', { attempt, lead_id: leadId })
    return true
  }

  const { error: ue } = await supabase
    .from('leads')
    .update({
      ai_paused_for_zv_dispatch: false,
      funnel_locked_until: null,
    })
    .eq('id', leadId)
    .eq('user_id', userId)
  if (ue) {
    console.warn('[inbox-ai-reply][self-heal] UPDATE leads falhou', attempt, ue.message)
    return false
  }
  console.log('[inbox-ai-reply][self-heal] UPDATE ok', {
    attempt,
    lead_id: leadId,
    ai_paused_for_zv_dispatch: false,
    funnel_locked_until: null,
  })
  return true
}

/**
 * Auto-cura com retry (race: resposta do cliente no mesmo minuto que o disparo ainda grava `sent`/`completed`).
 */
async function trySelfHealStaleZvDispatchPauseInbox(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS; attempt++) {
    const ok = await trySelfHealStaleZvDispatchPauseInboxOnce(supabase, userId, leadId, attempt)
    if (ok) return true
    if (attempt < INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS) {
      console.log('[inbox-ai-reply][self-heal] aguardando retry (race dispatch ↔ inbox)', {
        lead_id: leadId,
        attempt,
        delay_ms: INBOX_ZV_SELF_HEAL_RETRY_MS,
        max_attempts: INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS,
      })
      await sleep(INBOX_ZV_SELF_HEAL_RETRY_MS)
    }
  }
  console.warn('[inbox-ai-reply][self-heal] esgotadas tentativas sem destravar', {
    lead_id: leadId,
    attempts: INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS,
  })
  return false
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
  const ingestInstance = (triggerRow.evolution_instance_name ?? '').trim()
  if (!ingestInstance) {
    return {
      error:
        'chat_messages sem evolution_instance_name — aplique a migration e faça deploy do evolution-whatsapp-webhook.',
    }
  }

  // Identifica o lead (user_id) e valida vínculo com a instância Evolution da mensagem.
  const { data: lead, error: leErr } = await supabase
    .from('leads')
    .select(
      'id, user_id, phone, name, funnel_locked_until, ai_paused_for_zv_dispatch, ai_enabled',
    )
    .eq('id', triggerRow.lead_id)
    .maybeSingle()

  if (leErr) {
    return { error: `lead: ${leErr.message}` }
  }
  if (!lead) {
    return { error: 'Lead não encontrado' }
  }

  const leadData = lead as LeadRow
  const expectedInstance = instanceNameFromUserId(leadData.user_id)
  if (ingestInstance !== expectedInstance) {
    return {
      error: 'Instância Evolution incompatível com o dono do lead (possível mistura de tenant ou payload adulterado).',
      expected_instance: expectedInstance,
      received_instance: ingestInstance,
    }
  }

  // Pausa humana já gravada antes deste disparo (ex.: fromMe chegou primeiro).
  const { data: pauseEarly, error: pauseEarlyErr } = await supabase
    .from('leads')
    .select('ai_paused_until')
    .eq('id', triggerRow.lead_id)
    .eq('user_id', leadData.user_id)
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
  // HARD BLOCK 1 (síncrono): gatilho de campanha ativa reserva a mensagem ao funil.
  // Prioridade absoluta sobre `ai_enabled`: o painel não pode “furar” campanha/fluxo.
  // (Mesma semântica de palavras-chave que `zapvoice-inbound.ts`.)
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
        const kwCsv = (row as { trigger_keyword?: string | null }).trigger_keyword ?? ''
        if (triggerConditionSatisfiedAny(cond, messageNorm, kwCsv)) {
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

  // HARD LOCK 2: progresso ZV, pausa por disparo, fila pendente, última linha suprimida.
  // Sempre aplica (independente de `ai_enabled`). Releitura pós-delay pega `ai_paused_for_zv_dispatch`.
  const { data: leadAfterDelay, error: leadAdErr } = await supabase
    .from('leads')
    .select('funnel_locked_until, ai_paused_for_zv_dispatch, ai_enabled')
    .eq('id', triggerRow.lead_id)
    .eq('user_id', leadData.user_id)
    .maybeSingle()
  if (leadAdErr) {
    return { error: `lead_after_delay: ${leadAdErr.message}` }
  }
  const leadZv = leadAfterDelay as LeadRow | null
  if (!leadZv) {
    return { error: 'lead_after_delay: lead não encontrado' }
  }

  /** Pause por disparo ZV: permite re-poll de progresso/fila antes de hard-block (race pós-última etapa). */
  const zvDispatchRaceSignal = leadZv.ai_paused_for_zv_dispatch === true

  let progBlockRes = await countLeadZvProgressBlockingAiInbox(
    supabase,
    leadData.user_id,
    triggerRow.lead_id,
  )
  if (progBlockRes.error) {
    console.warn('[inbox-ai-reply] progress ZV (pós-delay):', progBlockRes.error.message)
    return {
      ok: true,
      ignored: 'hard_lock_progress_check_error',
      lead_id: triggerRow.lead_id,
    }
  }
  if (progBlockRes.count > 0 && zvDispatchRaceSignal) {
    for (let attempt = 2; attempt <= INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS; attempt++) {
      console.log('[inbox-ai-reply][ZV-race] progress ainda bloqueia com pause dispatch — aguardando DB', {
        lead_id: triggerRow.lead_id,
        attempt,
        max_attempts: INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS,
        delay_ms: INBOX_ZV_SELF_HEAL_RETRY_MS,
        prog_blocking_count: progBlockRes.count,
      })
      await sleep(INBOX_ZV_SELF_HEAL_RETRY_MS)
      progBlockRes = await countLeadZvProgressBlockingAiInbox(
        supabase,
        leadData.user_id,
        triggerRow.lead_id,
      )
      if (progBlockRes.error) break
      if (progBlockRes.count === 0) break
    }
  }
  if (progBlockRes.error) {
    console.warn('[inbox-ai-reply] progress ZV (pós-delay, pós-race):', progBlockRes.error.message)
    return {
      ok: true,
      ignored: 'hard_lock_progress_check_error',
      lead_id: triggerRow.lead_id,
    }
  }
  if (progBlockRes.count > 0) {
    return { ok: true, ignored: 'hard_lock_progress_active', lead_id: triggerRow.lead_id }
  }

  let leadGate = leadZv
  if (leadGate.ai_paused_for_zv_dispatch === true) {
    const unblocked = await trySelfHealStaleZvDispatchPauseInbox(
      supabase,
      leadData.user_id,
      triggerRow.lead_id,
    )
    if (!unblocked) {
      return {
        ok: true,
        ignored: 'zv_dispatch_ai_paused_flag',
        lead_id: triggerRow.lead_id,
      }
    }
    const { data: refLead, error: refErr } = await supabase
      .from('leads')
      .select('funnel_locked_until, ai_paused_for_zv_dispatch, ai_enabled')
      .eq('id', triggerRow.lead_id)
      .eq('user_id', leadData.user_id)
      .maybeSingle()
    if (!refErr && refLead) {
      leadGate = { ...leadGate, ...(refLead as LeadRow) }
    } else {
      leadGate = {
        ...leadGate,
        ai_paused_for_zv_dispatch: false,
        funnel_locked_until: null,
      }
    }
  }

  let pendZv = await countPendingZvScheduledForLead(supabase, leadData.user_id, triggerRow.lead_id)
  if (pendZv > 0 && zvDispatchRaceSignal) {
    for (let attempt = 2; attempt <= INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS; attempt++) {
      console.log('[inbox-ai-reply][ZV-race] fila ZV ainda pendente com pause dispatch — aguardando DB', {
        lead_id: triggerRow.lead_id,
        attempt,
        max_attempts: INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS,
        delay_ms: INBOX_ZV_SELF_HEAL_RETRY_MS,
        pending_zv: pendZv,
      })
      await sleep(INBOX_ZV_SELF_HEAL_RETRY_MS)
      pendZv = await countPendingZvScheduledForLead(supabase, leadData.user_id, triggerRow.lead_id)
      if (pendZv === 0) break
    }
  }
  if (pendZv > 0) {
    return {
      ok: true,
      ignored: 'zv_scheduled_queue_pending',
      lead_id: triggerRow.lead_id,
      pending_zv: pendZv,
    }
  }

  const { data: lastMsg, error: lastErr } = await supabase
    .from('chat_messages')
    .select('id, ai_suppressed, created_at')
    .eq('lead_id', triggerRow.lead_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastErr) {
    return { error: `last_msg: ${lastErr.message}` }
  }
  const last = lastMsg as { id?: string; ai_suppressed?: boolean | null } | null
  if (last?.ai_suppressed === true) {
    return { ok: true, ignored: 'hard_lock_last_message_suppressed', lead_id: triggerRow.lead_id }
  }

  const lockedUntilIso = (leadGate.funnel_locked_until ?? null)?.trim?.() ?? null
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
    .eq('user_id', leadData.user_id)
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
    .select(
      'ai_paused_until, ai_paused_for_zv_dispatch, ai_enabled, funnel_locked_until',
    )
    .eq('id', triggerRow.lead_id)
    .eq('user_id', leadData.user_id)
    .maybeSingle()
  if (pausePreErr) {
    return { error: `ai_pause_pre_llm: ${pausePreErr.message}` }
  }
  const pre = pausePreLlm as {
    ai_paused_until?: unknown
    ai_paused_for_zv_dispatch?: boolean | null
    ai_enabled?: boolean | null
    funnel_locked_until?: string | null
  } | null
  if (isAiPausedUntilActive(pre?.ai_paused_until)) {
    return {
      ok: true,
      ignored: 'ai_paused_human_handoff',
      lead_id: triggerRow.lead_id,
    }
  }

  const zvRacePreSignal = pre?.ai_paused_for_zv_dispatch === true

  let progPreRes: Awaited<ReturnType<typeof countLeadZvProgressBlockingAiInbox>>
  let pendPre: number
  {
    const [p0, z0] = await Promise.all([
      countLeadZvProgressBlockingAiInbox(supabase, leadData.user_id, triggerRow.lead_id),
      countPendingZvScheduledForLead(supabase, leadData.user_id, triggerRow.lead_id),
    ])
    progPreRes = p0
    pendPre = z0
  }

  if (progPreRes.error) {
    console.warn('[inbox-ai-reply] progress ZV (pré-LLM):', progPreRes.error.message)
    return {
      ok: true,
      ignored: 'hard_lock_progress_check_error_pre_llm',
      lead_id: triggerRow.lead_id,
    }
  }

  if ((progPreRes.count > 0 || pendPre > 0) && zvRacePreSignal) {
    for (let attempt = 2; attempt <= INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS; attempt++) {
      console.log('[inbox-ai-reply][ZV-race][pre-LLM] progress ou fila ainda bloqueiam com pause dispatch', {
        lead_id: triggerRow.lead_id,
        attempt,
        max_attempts: INBOX_ZV_SELF_HEAL_MAX_ATTEMPTS,
        delay_ms: INBOX_ZV_SELF_HEAL_RETRY_MS,
        prog_blocking_count: progPreRes.count,
        pending_zv: pendPre,
      })
      await sleep(INBOX_ZV_SELF_HEAL_RETRY_MS)
      const [p1, z1] = await Promise.all([
        countLeadZvProgressBlockingAiInbox(supabase, leadData.user_id, triggerRow.lead_id),
        countPendingZvScheduledForLead(supabase, leadData.user_id, triggerRow.lead_id),
      ])
      progPreRes = p1
      pendPre = z1
      if (progPreRes.error) break
      if (progPreRes.count === 0 && pendPre === 0) break
    }
  }

  if (progPreRes.error) {
    console.warn('[inbox-ai-reply] progress ZV (pré-LLM, pós-race):', progPreRes.error.message)
    return {
      ok: true,
      ignored: 'hard_lock_progress_check_error_pre_llm',
      lead_id: triggerRow.lead_id,
    }
  }
  if (progPreRes.count > 0) {
    return { ok: true, ignored: 'hard_lock_progress_active_pre_llm', lead_id: triggerRow.lead_id }
  }
  if (pendPre > 0) {
    return {
      ok: true,
      ignored: 'zv_scheduled_queue_pending_pre_llm',
      lead_id: triggerRow.lead_id,
      pending_zv: pendPre,
    }
  }

  let preGate = pre
  if (preGate?.ai_paused_for_zv_dispatch === true) {
    const unblockedPre = await trySelfHealStaleZvDispatchPauseInbox(
      supabase,
      leadData.user_id,
      triggerRow.lead_id,
    )
    if (!unblockedPre) {
      return {
        ok: true,
        ignored: 'zv_dispatch_ai_paused_flag_pre_llm',
        lead_id: triggerRow.lead_id,
      }
    }
    const { data: refPre, error: refPreErr } = await supabase
      .from('leads')
      .select('funnel_locked_until, ai_paused_for_zv_dispatch')
      .eq('id', triggerRow.lead_id)
      .eq('user_id', leadData.user_id)
      .maybeSingle()
    if (!refPreErr && refPre) {
      preGate = { ...preGate, ...(refPre as typeof preGate) }
    } else {
      preGate = {
        ...preGate,
        ai_paused_for_zv_dispatch: false,
        funnel_locked_until: null,
      }
    }
  }

  const lockPre = (preGate?.funnel_locked_until ?? '').trim()
  if (lockPre) {
    const t = new Date(lockPre).getTime()
    if (!Number.isNaN(t) && Date.now() < t) {
      return {
        ok: true,
        ignored: 'lead_in_funnel_pre_llm',
        lead_id: triggerRow.lead_id,
        funnel_locked_until: lockPre,
      }
    }
  }

  if (preGate?.ai_enabled === false) {
    return {
      ok: true,
      ignored: 'ai_disabled_explicit',
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
      evolution_instance_name: expectedInstance,
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    return { error: `insert ia: ${insErr.message}` }
  }
  const iaId = (insData as { id: string } | null)?.id

  const evo = await sendEvolutionText(
    evolutionUrl,
    evolutionKey,
    expectedInstance,
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

  const evoInstRaw =
    typeof record.evolution_instance_name === 'string'
      ? record.evolution_instance_name.trim()
      : ''
  const triggerRow: ChatMessageRow = {
    id: typeof record.id === 'string' ? record.id : '',
    lead_id: typeof record.lead_id === 'string' ? record.lead_id : '',
    sender_type: 'cliente',
    content_type: typeof record.content_type === 'string' ? record.content_type : 'text',
    message_body: typeof record.message_body === 'string' ? record.message_body : null,
    ai_suppressed: boolValue(record.ai_suppressed) ?? null,
    created_at: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
    evolution_instance_name: evoInstRaw || null,
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
