// Edge Function: process-scheduled-messages
// Fila: public.scheduled_messages → Evolution API
// - Agenda tradicional, segmentos, e agendamentos do Chat (lead_id + media_url).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (obrigatório; bypass RLS no banco)
//          EVOLUTION_API_URL, EVOLUTION_API_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { encode as toBase64 } from 'https://deno.land/std@0.168.0/encoding/base64.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ContentType = 'text' | 'audio' | 'image' | 'document' | 'video'

type ScheduledRow = {
  id: string
  user_id: string
  event_id: string | null
  lead_id: string | null
  media_url: string | null
  is_active: boolean
  recipient_type: 'personal' | 'segment'
  content_type: ContentType
  message_body: string | null
  scheduled_at: string | null
  status: string
  segment_lead_ids: string[] | null
  recipient_phone: string | null
  evolution_instance_name: string | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  zv_campaign_id?: string | null
  zv_funnel_step_id?: string | null
  /** Espelho de zv_funnels.step_order ao enfileirar (migration 20260430180000). */
  zv_funnel_step_order?: number | null
}

type ChatContentType = 'text' | 'audio' | 'image' | 'document'

function asFiniteOrd(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
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

function toChatContentType(contentType: ContentType): ChatContentType {
  if (contentType === 'video') return 'document'
  if (
    contentType === 'text' ||
    contentType === 'audio' ||
    contentType === 'image' ||
    contentType === 'document'
  ) {
    return contentType
  }
  return 'text'
}

function messageBodyParaChat(row: ScheduledRow): string {
  const t = row.message_body?.trim()
  if (t) return t
  switch (row.content_type) {
    case 'image':
      return '[imagem]'
    case 'audio':
      return '[áudio]'
    case 'video':
      return '[vídeo]'
    case 'document':
      return 'Arquivo agendado'
    default:
      return 'Mensagem agendada'
  }
}

function extractMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const messageBlock = o.message as Record<string, unknown> | undefined
  const keyBlock =
    (messageBlock?.key as Record<string, unknown> | undefined) ??
    (o.key as Record<string, unknown> | undefined)
  if (keyBlock && typeof keyBlock.id === 'string') return keyBlock.id
  return null
}

async function downloadMediaAsBase64(url: string): Promise<{
  base64: string
  mimeType: string
  fileName: string
}> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `Falha HTTP ${res.status} ao baixar mídia: ${url.slice(0, 200)}`,
    )
  }
  const mimeType =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const buf = new Uint8Array(await res.arrayBuffer())
  const fileName = (() => {
    try {
      const path = new URL(url).pathname
      return decodeURIComponent(path.split('/').pop() || 'arquivo') || 'arquivo'
    } catch {
      return 'arquivo'
    }
  })()
  return { base64: toBase64(buf), mimeType, fileName }
}

function stripDataUrlBase64(input: string): string {
  const t = input.trim()
  if (t.startsWith('data:')) {
    const i = t.indexOf('base64,')
    if (i >= 0) return t.slice(i + 7).trim()
  }
  return t
}

/**
 * Sleep simples — usado para o delay humanizado entre disparos e para esperar
 * o efeito do `presence` na Evolution antes de enviar de fato a mensagem.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Delay humanizado entre 5s e 15s entre cada disparo. Reduz drasticamente a
 * chance de ban por padrão de envio robotizado.
 */
function humanizedDelayMs(): number {
  return Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000
}

function pickRandomIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min)
  const b = Math.floor(max)
  if (b < a) return a
  return Math.floor(Math.random() * (b - a + 1)) + a
}

function resolveDispatchDelayMs(row: ScheduledRow): number {
  const minS = typeof row.min_delay_seconds === 'number' ? row.min_delay_seconds : null
  const maxS = typeof row.max_delay_seconds === 'number' ? row.max_delay_seconds : null
  if (minS == null || maxS == null) {
    return humanizedDelayMs()
  }
  const safeMin = Number.isFinite(minS) ? Math.max(0, minS) : 0
  const safeMax = Number.isFinite(maxS) ? Math.max(0, maxS) : safeMin
  const seconds = pickRandomIntInclusive(safeMin, safeMax)
  return seconds * 1000
}

function formatDateBR(d: Date): string {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  return fmt.format(d)
}

function weekdayBR(d: Date): string {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
  })
  return fmt.format(d)
}

function timeHHMM(d: Date): string {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  })
  return fmt.format(d)
}

function greetingByTime(d: Date): string {
  // Baseado na hora de São Paulo
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '12')
  if (h >= 5 && h < 12) return 'Bom dia'
  if (h >= 12 && h < 18) return 'Boa tarde'
  return 'Boa noite'
}

function firstName(full: string | null | undefined): string {
  const t = (full ?? '').trim()
  if (!t) return 'Cliente'
  return t.split(/\s+/)[0] ?? t
}

type UserSettingsRow = {
  agencia_nome: string | null
  vendedor_primeiro_nome: string | null
  telefone_contato: string | null
  instagram_empresa: string | null
  site_empresa: string | null
  avalie_google: string | null
  endereco: string | null
  telefones: string[] | null
}

async function renderMessageTemplate(params: {
  supabase: ReturnType<typeof createClient>
  userId: string
  leadId: string | null
  text: string
}): Promise<string> {
  const t = params.text
  if (!t || t.indexOf('{') === -1) return t

  const now = new Date()
  const leadPromise = params.leadId
    ? params.supabase.from('leads').select('name').eq('id', params.leadId).maybeSingle()
    : Promise.resolve({ data: null as any, error: null as any })

  const settingsPromise = params.supabase
    .from('user_settings')
    .select(
      'agencia_nome, vendedor_primeiro_nome, telefone_contato, instagram_empresa, site_empresa, avalie_google, endereco, telefones',
    )
    .eq('user_id', params.userId)
    .maybeSingle()

  const [leadRes, setRes] = await Promise.all([leadPromise, settingsPromise])
  const leadName = (leadRes.data as { name?: string | null } | null)?.name ?? null
  const settings = (setRes.data as UserSettingsRow | null) ?? null
  const fn = firstName(leadName)
  const full = (leadName ?? '').trim() || 'Cliente'
  const agencia = (settings?.agencia_nome ?? '').trim()
  const ender = (settings?.endereco ?? '').trim()
  const vend = (settings?.vendedor_primeiro_nome ?? '').trim()

  const rep: Record<string, string> = {
    '{saudacao_tempo}': greetingByTime(now),
    '{hoje_data}': formatDateBR(now),
    '{dia_semana}': weekdayBR(now),
    '{hora_atual}': timeHHMM(now),
    '{cliente_primeiro_nome}': fn,
    '{cliente_nome}': full,
    '{nome}': fn,
    '{agencia_nome}': agencia,
    '{empresa_nome}': agencia,
    '{vendedor_primeiro_nome}': vend,
    '{vendedor_nome}': vend,
    '{telefone_contato}': (settings?.telefone_contato ?? '').trim(),
    '{instagram_empresa}': (settings?.instagram_empresa ?? '').trim(),
    '{site_empresa}': (settings?.site_empresa ?? '').trim(),
    '{avalie_google}': (settings?.avalie_google ?? '').trim(),
    '{endereco}': ender,
    '{empresa_endereço}': ender,
    '{telefones}': (settings?.telefones ?? []).filter(Boolean).join(' / '),
  }

  let out = t
  for (const [k, v] of Object.entries(rep)) {
    out = out.replaceAll(k, v || '')
  }
  return out
}

type EvolutionPresence = 'composing' | 'recording' | 'paused'

type DispatchPlan =
  | { kind: 'text'; text: string }
  | { kind: 'media'; mediatype: 'image' | 'video' | 'document'; body: Record<string, unknown> }
  | { kind: 'audio'; body: Record<string, unknown> }

/** Alinha presence ao que a Evolution recebe: áudio = gravando, resto = digitando. */
function presenceForPlan(plan: DispatchPlan): EvolutionPresence {
  if (plan.kind === 'audio') return 'recording'
  return 'composing'
}

/**
 * Avisa a Evolution para mostrar "digitando…" / "gravando áudio…" antes do
 * envio real. Usa o endpoint `chat/sendPresence/{instance}`. Falhas aqui não
 * podem derrubar o disparo: logamos e seguimos.
 */
async function sendEvolutionPresence(
  evolutionUrl: string,
  evolutionApiKey: string,
  instanceName: string,
  number: string,
  presence: EvolutionPresence,
  delayMs: number,
): Promise<void> {
  const url = `${evolutionUrl}/chat/sendPresence/${encodeURIComponent(instanceName)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: evolutionApiKey,
      },
      body: JSON.stringify({
        number,
        presence,
        delay: delayMs,
      }),
    })
    if (!res.ok) {
      const t = await res.text()
      console.warn(
        `[Agenda Suprema] presence ${presence} HTTP ${res.status}: ${t.slice(0, 200)}`,
      )
    }
  } catch (e) {
    console.warn('[Agenda Suprema] presence falhou:', e)
  }
}

/** Gap entre etapas do fluxo menor que isto ⇒ processa inline (sem esperar próximo cron). */
const INLINE_FUNNEL_GAP_THRESHOLD_MS = 45_000
/** Teto de duração da invocação Edge para continuar drain (ms). */
const INLINE_FUNNEL_MAX_WALL_MS = 115_000
const MAX_FUNNEL_INLINE_DEPTH = 32

/** Margem sobre o gap para concluir o próximo disparo na mesma invocação. */
const INLINE_FUNNEL_RESUME_BUFFER_MS = 2_500

function remainingWallMs(invocationStartedAtMs: number): number {
  return INLINE_FUNNEL_MAX_WALL_MS - (Date.now() - invocationStartedAtMs)
}

serve(async () => {
  console.log('[Agenda Suprema] Robô acordou! Buscando pendentes...')

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
  const evolutionUrl = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(
    /\/+$/,
    '',
  )
  const evolutionApiKey = (Deno.env.get('EVOLUTION_API_KEY') ?? '').trim()

  if (!supabaseUrl || !serviceKey) {
    console.error(
      '[Agenda Suprema] Falha: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas secrets desta função (para o worker ignorar RLS).',
    )
    return new Response(
      JSON.stringify({
        error:
          'Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas secrets da função (Edge / Dashboard).',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (!evolutionUrl || !evolutionApiKey) {
    return new Response(
      JSON.stringify({
        error:
          'Secrets da Evolution ausentes. Configure EVOLUTION_API_URL e EVOLUTION_API_KEY.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
  const invocationStartedAtMs = Date.now()

  const nowIso = new Date().toISOString()
  console.log(
    '[Agenda Suprema] Agora (UTC) para a query:',
    nowIso,
    '| pendentes com scheduled_at <= agora (UTC).',
  )

  // Reserva atômica (FOR UPDATE SKIP LOCKED via RPC): evita dois workers processarem a mesma linha.
  const { data: claimedRows, error: fetchError } = await supabase.rpc(
    'claim_scheduled_messages',
    { p_limit: 30 },
  )

  if (fetchError) {
    console.error('[process-scheduled-messages] claim_scheduled_messages:', fetchError)
    return new Response(
      JSON.stringify({ error: fetchError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const candidates = (claimedRows ?? []) as ScheduledRow[]

  if (!candidates || candidates.length === 0) {
    return new Response(
      JSON.stringify({ message: 'Nenhuma mensagem pendente.' }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  let sent = 0
  let failed = 0

  for (const rawMsg of candidates) {
    let msg = rawMsg as ScheduledRow

    try {
      let chainDepth = 0
      inner: while (true) {
        let queuedInline: { id: string; gapMs: number } | null = null

        console.log('[Agenda Suprema] Disparando mensagem ID:', msg.id)

        // Anti-ban (configurável): delay aleatório antes de cada disparo.
      // Etapas do Zap Voice (zv_funnel_step_id): não empilhar atrasos longos + presença
      let dispatchDelayMs = resolveDispatchDelayMs(msg)
      if (msg.zv_funnel_step_id) {
        dispatchDelayMs = Math.min(dispatchDelayMs, 2500)
      }
      console.log(`[Agenda Suprema] Delay antes do envio: ${dispatchDelayMs}ms`)
      await sleep(dispatchDelayMs)

      // --- 1) Destinatários ---
      let phones: string[] = []

      if (msg.lead_id) {
        if (msg.recipient_phone?.trim()) {
          const raw = msg.recipient_phone.trim()
          const d = toEvolutionDigits(raw) ?? (raw.includes('@') ? raw : null)
          if (d) phones = [d]
        }
        if (phones.length === 0) {
          const { data: lead } = await supabase
            .from('leads')
            .select('phone')
            .eq('id', msg.lead_id)
            .eq('user_id', msg.user_id)
            .maybeSingle()
          const p = toEvolutionDigits(
            (lead as { phone: string | null } | null)?.phone ?? null,
          )
          if (p) phones = [p]
        }
      } else if (msg.recipient_type === 'personal') {
        const digits = toEvolutionDigits(msg.recipient_phone)
        if (!digits) {
          const { data: prof } = await supabase
            .from('profiles')
            .select('phone, whatsapp')
            .eq('id', msg.user_id)
            .maybeSingle()
          const fromProfile =
            toEvolutionDigits(
              (prof as { phone?: string; whatsapp?: string } | null)?.whatsapp,
            ) ??
            toEvolutionDigits(
              (prof as { phone?: string; whatsapp?: string } | null)?.phone,
            )
          if (fromProfile) phones = [fromProfile]
        } else {
          phones = [digits]
        }
      } else if (
        msg.recipient_type === 'segment' &&
        msg.segment_lead_ids &&
        msg.segment_lead_ids.length > 0
      ) {
        const { data: leads } = await supabase
          .from('leads')
          .select('phone')
          .eq('user_id', msg.user_id)
          .in('id', msg.segment_lead_ids)
        phones = (leads ?? [])
          .map((l: { phone: string | null }) => toEvolutionDigits(l.phone))
          .filter((x): x is string => Boolean(x))
      }

      if (phones.length === 0) {
        throw new Error(
          'Nenhum telefone válido para envio (DDI 55 + DDD + número, ou JID de grupo).',
        )
      }

      const legacyInstance = msg.evolution_instance_name?.trim() ?? ''
      const instanceName =
        legacyInstance && legacyInstance.startsWith('zapifica_')
          ? legacyInstance
          : instanceNameFromUserId(msg.user_id)

      // --- 2) Monta envio (texto, mídia com URL, ou legado com corpo) ---
      // Endpoints: message/sendText | message/sendMedia | message/sendWhatsAppAudio
      const renderedBody = await renderMessageTemplate({
        supabase,
        userId: msg.user_id,
        leadId: msg.lead_id,
        text: (msg.message_body ?? '').trim(),
      })
      const caption = renderedBody.trim() || undefined
      const mediaUrl = msg.media_url?.trim() ?? null

      let plan: DispatchPlan

      if (mediaUrl) {
        const { base64, mimeType, fileName } = await downloadMediaAsBase64(mediaUrl)
        const ct = msg.content_type
        switch (ct) {
          case 'audio':
            plan = {
              kind: 'audio',
              body: {
                audio: stripDataUrlBase64(base64),
                delay: 1000,
                encoding: true,
                ptt: true,
              },
            }
            break
          case 'image':
            plan = {
              kind: 'media',
              mediatype: 'image',
              body: {
                mediatype: 'image',
                media: base64,
                ...(caption ? { caption } : {}),
              },
            }
            break
          case 'video':
            plan = {
              kind: 'media',
              mediatype: 'video',
              body: {
                mediatype: 'video',
                media: base64,
                ...(caption ? { caption } : {}),
              },
            }
            break
          case 'document':
            plan = {
              kind: 'media',
              mediatype: 'document',
              body: {
                mediatype: 'document',
                mimetype: mimeType,
                fileName,
                media: base64,
                ...(caption ? { caption } : {}),
              },
            }
            break
          case 'text':
            // legado: linha de agenda antiga com URL mas tipo texto
            plan = {
              kind: 'media',
              mediatype: 'document',
              body: {
                mediatype: 'document',
                mimetype: mimeType,
                fileName,
                media: base64,
                ...(caption ? { caption } : {}),
              },
            }
            break
          default:
            plan = {
              kind: 'media',
              mediatype: 'document',
              body: {
                mediatype: 'document',
                mimetype: mimeType,
                fileName,
                media: base64,
                ...(caption ? { caption } : {}),
              },
            }
        }
      } else {
        const body = renderedBody ?? ''
        if (!body.trim() && msg.content_type === 'text') {
          throw new Error('Mensagem de texto vazia.')
        }
        if (!body.trim() && (msg.content_type === 'document' || msg.content_type === 'video')) {
          throw new Error(
            'Documento/vídeo agendado requer a URL pública em `media_url` para o worker baixar o arquivo.',
          )
        }
        if (!body.trim() && (msg.content_type === 'audio' || msg.content_type === 'image')) {
          throw new Error('Mídia sem conteúdo: preencha `message_body` (legado) ou `media_url`.')
        }
        if (msg.content_type === 'text') {
          plan = { kind: 'text', text: body }
        } else if (msg.content_type === 'audio') {
          plan = {
            kind: 'audio',
            body: {
              audio: stripDataUrlBase64(body),
              delay: 1000,
              encoding: true,
              ptt: true,
            },
          }
        } else if (msg.content_type === 'image') {
          plan = {
            kind: 'media',
            mediatype: 'image',
            body: {
              mediatype: 'image',
              media: body.trim(),
            },
          }
        } else {
          plan = { kind: 'text', text: body }
        }
      }

      let lastEvolutionId: string | null = null

      for (const phone of phones) {
        let endpoint: string
        let payload: Record<string, unknown>
        if (plan.kind === 'text') {
          endpoint = 'message/sendText'
          payload = { number: phone, text: plan.text }
        } else if (plan.kind === 'audio') {
          endpoint = 'message/sendWhatsAppAudio'
          payload = { number: phone, ...plan.body }
        } else {
          endpoint = 'message/sendMedia'
          payload = { number: phone, ...plan.body }
        }

        // Anti-ban / humanização: "digitando…" (texto/mídia) ou "gravando…" (áudio).
        const presence = presenceForPlan(plan)
        let presenceDelayMs = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000
        if (msg.zv_funnel_step_id) {
          presenceDelayMs = Math.floor(Math.random() * (1200 - 400 + 1)) + 400
        }
        await sendEvolutionPresence(
          evolutionUrl,
          evolutionApiKey,
          instanceName,
          phone,
          presence,
          presenceDelayMs,
        )
        await sleep(presenceDelayMs)

        const url = `${evolutionUrl}/${endpoint}/${encodeURIComponent(instanceName)}`
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: evolutionApiKey,
          },
          body: JSON.stringify(payload),
        })

        const bodyText = await response.text()
        let bodyJson: unknown = null
        if (bodyText) {
          try {
            bodyJson = JSON.parse(bodyText)
          } catch {
            // não-JSON
          }
        }

        if (!response.ok) {
          const detail =
            (bodyJson &&
              typeof bodyJson === 'object' &&
              'message' in bodyJson &&
              String((bodyJson as { message: unknown }).message)) ||
            bodyText.slice(0, 400) ||
            response.statusText
          throw new Error(
            `Evolution ${response.status} em ${endpoint}/${instanceName}: ${detail}`,
          )
        }
        if (bodyJson) {
          const id = extractMessageId(bodyJson)
          if (id) lastEvolutionId = id
        }
      }

      const { error: upErr } = await supabase
        .from('scheduled_messages')
        .update({
          status: 'sent',
          evolution_message_id: lastEvolutionId,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', msg.id)
      if (upErr) {
        throw new Error(`Supabase: falha ao marcar sent: ${upErr.message}`)
      }

      if (msg.lead_id) {
        const { error: chatErr } = await supabase.from('chat_messages').insert({
          lead_id: msg.lead_id,
          sender_type: 'agencia',
          content_type: toChatContentType(msg.content_type),
          message_body: messageBodyParaChat(msg),
          media_url: msg.media_url,
          evolution_message_id: lastEvolutionId,
        })
        if (chatErr) {
          console.error('[process-scheduled-messages] chat_messages insert:', chatErr)
          await supabase
            .from('scheduled_messages')
            .update({
              last_error: `Enviado ao WhatsApp, mas o CRM não registrou: ${chatErr.message}`.slice(
                0,
                4000,
              ),
              updated_at: new Date().toISOString(),
            })
            .eq('id', msg.id)
        }
      }

      // --- Zap Voice: Etapa N enviada → enfileira Etapa N+1 na fila ---
      if (
        msg.lead_id &&
        msg.zv_campaign_id &&
        msg.zv_funnel_step_id
      ) {
        const funnelStepUuid = String(msg.zv_funnel_step_id).trim()

        console.log('[ZV-FUNNEL] início encadeamento pós-envio', {
          sched_id: msg.id,
          lead_id: msg.lead_id,
          zv_campaign_id: msg.zv_campaign_id,
          zv_funnel_step_id: funnelStepUuid,
          zv_funnel_step_order_col: msg.zv_funnel_step_order ?? null,
        })

        const { data: zvCampRow, error: campE } = await supabase
          .from('zv_campaigns')
          .select('flow_id')
          .eq('user_id', msg.user_id)
          .eq('id', msg.zv_campaign_id)
          .maybeSingle()
        if (campE) {
          console.warn('[ZV-FUNNEL] ler campanha:', campE.message)
        }
        const zvFlowId = (zvCampRow as { flow_id: string | null } | null)?.flow_id ?? null

        const { data: prog2, error: prog2Err } = await supabase
          .from('lead_campaign_progress')
          .select('id')
          .eq('user_id', msg.user_id)
          .eq('lead_id', msg.lead_id)
          .eq('campaign_id', msg.zv_campaign_id)
          .in('status', ['active', 'awaiting_last_send'])
          .maybeSingle()
        if (prog2Err) {
          console.warn('[ZV-FUNNEL] ler lead_campaign_progress:', prog2Err.message)
        }

        // 1) Preferir número gravado na fila (coerente mesmo se UUID falhar ao bater na tabela)
        let curOrd = asFiniteOrd(msg.zv_funnel_step_order ?? null)

        // 2) Fallback: FK em zv_funnels
        if (curOrd === null) {
          const { data: csr, error: curErr } = await supabase
            .from('zv_funnels')
            .select('id, step_order')
            .eq('id', funnelStepUuid)
            .limit(1)
            .maybeSingle()
          if (curErr) {
            console.warn('[ZV-FUNNEL] ler etapa atual por UUID:', curErr.message)
          }
          curOrd = csr ? asFiniteOrd((csr as { step_order?: unknown }).step_order) : null
          console.log('[ZV-FUNNEL] fallback UUID → step_order=', curOrd, 'row?', Boolean(csr))
        }

        if (!zvFlowId) {
          console.error('[ZV-FUNNEL] ABORT sem flow_id na campanha', msg.zv_campaign_id)
        } else if (!prog2?.id) {
          console.error('[ZV-FUNNEL] ABORT sem lead_campaign_progress ativo para lead/campanha')
        } else if (curOrd === null) {
          console.error(
            '[ZV-FUNNEL] ABORT não resolveu step_order (coluna nova ausente até migrar?). rode: supabase db push',
          )
        } else {
          const { data: nextStep, error: nxErr } = await supabase
            .from('zv_funnels')
            .select(
              'id, step_order, message, media_type, media_url, min_delay_seconds, max_delay_seconds',
            )
            .eq('flow_id', zvFlowId)
            .gt('step_order', curOrd)
            .order('step_order', { ascending: true })
            .limit(1)
            .maybeSingle()

          if (nxErr) {
            console.warn('[ZV-FUNNEL] query próxima etapa:', nxErr.message)
          }
          console.log('[ZV-FUNNEL] próxima etapa após ord', curOrd, '→', nextStep?.id ?? 'nenhuma')

          if (!nextStep) {
            console.log('[ZV-FUNNEL] fim do fluxo neste envio (sem etapa seguinte)')
          } else {
            const minS =
              typeof (nextStep as Record<string, unknown>).min_delay_seconds === 'number'
                ? Math.max(0, Number((nextStep as { min_delay_seconds: number }).min_delay_seconds))
                : typeof msg.min_delay_seconds === 'number'
                  ? Math.max(0, msg.min_delay_seconds)
                  : 2
            const maxS =
              typeof (nextStep as Record<string, unknown>).max_delay_seconds === 'number'
                ? Math.max(minS, Number((nextStep as { max_delay_seconds: number }).max_delay_seconds))
                : typeof msg.max_delay_seconds === 'number'
                  ? Math.max(minS, msg.max_delay_seconds)
                  : 15
            const delayS = pickRandomIntInclusive(minS, maxS)
            const scheduledAt = new Date(Date.now() + delayS * 1000).toISOString()

            const rendered = await renderMessageTemplate({
              supabase,
              userId: msg.user_id,
              leadId: msg.lead_id,
              text: String((nextStep as { message?: string | null }).message ?? ''),
            })

            const ct = String((nextStep as { media_type?: string }).media_type ?? 'text')
            const mediaUrl2 =
              ct === 'text'
                ? null
                : String((nextStep as { media_url?: string | null }).media_url ?? '').trim() ||
                  null

            const nextOrdRaw = asFiniteOrd((nextStep as { step_order?: unknown }).step_order)

            const ins2 = await supabase
              .from('scheduled_messages')
              .insert({
                user_id: msg.user_id,
                lead_id: msg.lead_id,
                zv_campaign_id: msg.zv_campaign_id,
                zv_funnel_step_id: String((nextStep as { id: string }).id),
                zv_funnel_step_order: nextOrdRaw,
                is_active: true,
                recipient_type: 'personal',
                content_type: ct,
                message_body: rendered || null,
                media_url: mediaUrl2,
                scheduled_at: scheduledAt,
                status: 'pending',
                recipient_phone: msg.recipient_phone,
                event_id: null,
                evolution_instance_name: msg.evolution_instance_name,
                min_delay_seconds: minS,
                max_delay_seconds: maxS,
              })
              .select('id')
              .single()

            if (ins2.error) {
              console.error(
                '[ZV-FUNNEL] FALHA insert próxima etapa (ver RLS/schema):',
                ins2.error.code,
                ins2.error.message,
                JSON.stringify(ins2.error),
              )
            } else {
              console.log('[ZV-FUNNEL] próxima etapa AGENDADA', {
                new_sched_preview: scheduledAt,
                next_step_order: nextOrdRaw,
                next_media: ct,
                new_id: ins2.data?.id,
              })
              const nsOrd = Number((nextStep as { step_order?: number }).step_order ?? 0)
              const { data: stepBeyondQueued } = await supabase
                .from('zv_funnels')
                .select('id')
                .eq('flow_id', zvFlowId)
                .gt('step_order', nsOrd)
                .limit(1)
                .maybeSingle()
              const isLastEnqueued = stepBeyondQueued == null
              await supabase
                .from('lead_campaign_progress')
                .update({
                  next_step_order: nsOrd + 1,
                  status:
                    isLastEnqueued ? ('awaiting_last_send' as const) : ('active' as const),
                })
                .eq('id', String((prog2 as { id: string }).id))
              if (ins2.data?.id) {
                queuedInline = { id: ins2.data.id, gapMs: delayS * 1000 }
              }
            }
          }
        }
      }

      // --- Zap Voice: sem pendentes nesta campanha+lead → conclui e libera IA ---
      if (msg.lead_id && msg.zv_campaign_id) {
        const { data: prog, error: progErr } = await supabase
          .from('lead_campaign_progress')
          .select('id, status')
          .eq('user_id', msg.user_id)
          .eq('lead_id', msg.lead_id)
          .eq('campaign_id', msg.zv_campaign_id)
          .in('status', ['active', 'awaiting_last_send'])
          .maybeSingle()
        if (progErr) {
          console.warn('[Agenda Suprema] Falha ao ler progress:', progErr.message)
        }

        const { count, error: cntErr } = await supabase
          .from('scheduled_messages')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', msg.user_id)
          .eq('lead_id', msg.lead_id)
          .eq('zv_campaign_id', msg.zv_campaign_id)
          .in('status', ['pending', 'processing'])
          .eq('is_active', true)

        if (cntErr) {
          console.warn('[Agenda Suprema] Falha ao checar fim do funil:', cntErr.message)
        } else if ((count ?? 0) === 0) {
          const isAwaiting =
            prog && typeof (prog as any).status === 'string'
              ? String((prog as any).status) === 'awaiting_last_send'
              : false

          if (!prog || isAwaiting) {
            const { error: compErr } = await supabase
              .from('lead_campaign_completions')
              .insert({
                user_id: msg.user_id,
                lead_id: msg.lead_id,
                campaign_id: msg.zv_campaign_id,
              })
            if (compErr && compErr.code !== '23505') {
              console.warn('[Agenda Suprema] Falha ao gravar completion:', compErr.message)
            }
            if (prog && (prog as any).id) {
              const { error: delErr } = await supabase
                .from('lead_campaign_progress')
                .delete()
                .eq('id', (prog as any).id)
              if (delErr) {
                console.warn('[Agenda Suprema] Falha ao remover progress:', delErr.message)
              }
            }

            const { error: unlockErr } = await supabase
              .from('leads')
              .update({ funnel_locked_until: null })
              .eq('id', msg.lead_id)
              .eq('user_id', msg.user_id)
            if (unlockErr) {
              console.warn('[Agenda Suprema] Falha ao liberar funil no lead:', unlockErr.message)
            } else {
              console.log('[Agenda Suprema] Campanha finalizada — IA liberada', {
                lead_id: msg.lead_id,
                zv_campaign_id: msg.zv_campaign_id,
              })
            }
          }
        }
      }

      sent += 1

      if (queuedInline !== null) {
        const qi = queuedInline
        const gapMs = qi.gapMs
        const wallOk =
          remainingWallMs(invocationStartedAtMs) >= gapMs + INLINE_FUNNEL_RESUME_BUFFER_MS
        if (
          gapMs < INLINE_FUNNEL_GAP_THRESHOLD_MS &&
          wallOk &&
          chainDepth < MAX_FUNNEL_INLINE_DEPTH
        ) {
          chainDepth += 1
          console.log('[ZV-FUNNEL] stay-awake (mesma invocação)', {
            next_id: qi.id,
            gapMs,
            chainDepth,
            wallMs: remainingWallMs(invocationStartedAtMs),
          })
          await sleep(gapMs)
          const { error: uErr } = await supabase
            .from('scheduled_messages')
            .update({
              scheduled_at: new Date().toISOString(),
              status: 'processing',
              updated_at: new Date().toISOString(),
            })
            .eq('id', qi.id)
          if (uErr) {
            console.warn('[ZV-FUNNEL] stay-awake não pôde preparar linha:', uErr.message)
            break inner
          }
          const { data: nxtRow, error: nxtErr } = await supabase
            .from('scheduled_messages')
            .select('*')
            .eq('id', qi.id)
            .single()
          if (nxtErr || !nxtRow) {
            console.warn('[ZV-FUNNEL] stay-awake fetch linha:', nxtErr?.message)
            break inner
          }
          msg = nxtRow as ScheduledRow
          continue inner
        }
        console.log('[ZV-FUNNEL] stay-awake omitido (gap longo, budget ou profundidade)', {
          gapMs,
          wallOk,
          chainDepth,
        })
      }

      break inner
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[process-scheduled-messages] ERRO FATAL NO DISPARO:', err)
      const { error: e2 } = await supabase
        .from('scheduled_messages')
        .update({
          status: 'error',
          last_error: message.slice(0, 4000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', msg.id)
      if (e2) {
        await supabase
          .from('scheduled_messages')
          .update({ status: 'error', updated_at: new Date().toISOString() })
          .eq('id', msg.id)
      }
      failed += 1
      // Fluxo Zap Voice: erro no envio deixa o lead preso sem IA (funnel lock). Liberamos explicitamente.
      if (msg.lead_id && (msg.zv_campaign_id ?? msg.zv_funnel_step_id)) {
        const { error: uLock } = await supabase
          .from('leads')
          .update({ funnel_locked_until: null })
          .eq('id', msg.lead_id)
          .eq('user_id', msg.user_id)
        if (uLock) {
          console.warn('[process-scheduled-messages] funnel unlock falhou:', uLock.message)
        } else {
          console.warn('[process-scheduled-messages] funnel unlock após erro (Zap Voice)', msg.lead_id)
        }
      }
    }

    // Sem cooldown global aqui: o delay configurável já é aplicado por mensagem.
  }

  return new Response(
    JSON.stringify({
      message: `Processadas ${candidates.length} mensagens (lote).`,
      sent,
      failed,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
