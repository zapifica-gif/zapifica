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
}

type ChatContentType = 'text' | 'audio' | 'image' | 'document'

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

type EvolutionPresence = 'composing' | 'recording' | 'paused'

function presenceForContent(contentType: ContentType): EvolutionPresence {
  // Áudio = "gravando…" no WhatsApp; demais = "digitando…".
  if (contentType === 'audio') return 'recording'
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

  const nowIso = new Date().toISOString()
  console.log(
    '[Agenda Suprema] Agora (UTC) para a query:',
    nowIso,
    '| pendentes com scheduled_at <= agora (UTC).',
  )

  const { data: candidates, error: fetchError } = await supabase
    .from('scheduled_messages')
    .select(
      'id, user_id, event_id, lead_id, media_url, is_active, recipient_type, content_type, message_body, scheduled_at, status, segment_lead_ids, recipient_phone, evolution_instance_name',
    )
    .eq('status', 'pending')
    .eq('is_active', true)
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(30)

  if (fetchError) {
    console.error('[process-scheduled-messages] query:', fetchError)
    return new Response(
      JSON.stringify({ error: fetchError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (!candidates || candidates.length === 0) {
    return new Response(
      JSON.stringify({ message: 'Nenhuma mensagem pendente.' }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  let sent = 0
  let failed = 0

  for (const rawMsg of candidates) {
    const msg = rawMsg as ScheduledRow

    const { data: claimed, error: claimErr } = await supabase
      .from('scheduled_messages')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', msg.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) {
      continue
    }

    console.log('[Agenda Suprema] Disparando mensagem ID:', msg.id)

    try {
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
      const caption = (msg.message_body ?? '').trim() || undefined
      const mediaUrl = msg.media_url?.trim() ?? null

      type DispatchPlan =
        | { kind: 'text'; text: string }
        | { kind: 'media'; mediatype: 'image' | 'video' | 'document'; body: Record<string, unknown> }
        | { kind: 'audio'; body: Record<string, unknown> }

      let plan: DispatchPlan

      if (mediaUrl) {
        const { base64, mimeType, fileName } = await downloadMediaAsBase64(mediaUrl)
        const ct = msg.content_type
        if (ct === 'audio') {
          plan = {
            kind: 'audio',
            body: {
              audio: stripDataUrlBase64(base64),
              delay: 1000,
              encoding: true,
              ptt: true,
            },
          }
        } else if (ct === 'text') {
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
        } else if (ct === 'image') {
          plan = {
            kind: 'media',
            mediatype: 'image',
            body: {
              mediatype: 'image',
              media: base64,
              ...(caption ? { caption } : {}),
            },
          }
        } else if (ct === 'video') {
          plan = {
            kind: 'media',
            mediatype: 'video',
            body: {
              mediatype: 'video',
              media: base64,
              ...(caption ? { caption } : {}),
            },
          }
        } else {
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
        const body = msg.message_body ?? ''
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

        // Anti-ban / humanização: simula "digitando…" (texto) ou "gravando…"
        // (áudio) por 2-5 segundos antes de mandar a mensagem de verdade.
        const presence = presenceForContent(msg.content_type)
        const presenceDelayMs = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000
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

      sent += 1
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
    }

    // Anti-ban: cooldown aleatório entre 5s e 15s antes do próximo disparo.
    // Só vale entre mensagens — depois da última do lote, não atrasa o retorno.
    const isLast = msg === (candidates[candidates.length - 1] as ScheduledRow)
    if (!isLast) {
      const cooldown = humanizedDelayMs()
      console.log(`[Agenda Suprema] Cooldown anti-ban: ${cooldown}ms`)
      await sleep(cooldown)
    }
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
