// ============================================================================
// Edge Function: process-scheduled-messages
//
// Lê a fila de public.scheduled_messages no Supabase e dispara pela Evolution
// API os lembretes agendados pela Agenda Suprema.
//
// Quando roda:
//   * Idealmente por pg_cron + pg_net (ver README/migrations) a cada minuto.
//   * Também pode ser chamada manualmente com:
//       curl -X POST \
//         "https://<ref>.supabase.co/functions/v1/process-scheduled-messages" \
//         -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
//
// Variáveis de ambiente esperadas (configurar com `supabase secrets set`):
//   * SUPABASE_URL              (injetada automaticamente pelo Supabase)
//   * SUPABASE_SERVICE_ROLE_KEY (injetada automaticamente pelo Supabase)
//   * EVOLUTION_API_URL         (ex.: https://evolution-api-production.up.railway.app)
//   * EVOLUTION_API_KEY         (apikey global / instance key)
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ScheduledRow = {
  id: string
  user_id: string
  event_id: string | null
  is_active: boolean
  recipient_type: 'personal' | 'segment'
  content_type: 'text' | 'audio' | 'image'
  message_body: string | null
  scheduled_at: string | null
  status: string
  segment_lead_ids: string[] | null
  recipient_phone: string | null
  evolution_instance_name: string | null
}

/**
 * Mesma convenção do front (src/services/evolution.ts:instanceNameFromUserId)
 * para que Agenda e Zap Voice compartilhem a mesma instância da Evolution.
 */
function instanceNameFromUserId(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9-]/g, '_')
  return `zapifica_${safe}`.slice(0, 80)
}

/**
 * Canoniza o número para o formato que a Evolution exige (dígitos + DDI 55).
 *   * Aceita máscara, com ou sem 55, ou JID de grupo (@g.us).
 *   * Se receber 10 ou 11 dígitos (DDD + número), anexa 55 automaticamente.
 */
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

function endpointForContentType(
  contentType: ScheduledRow['content_type'],
): string {
  switch (contentType) {
    case 'audio':
      return 'message/sendWhatsAppAudio'
    case 'image':
      return 'message/sendMedia'
    case 'text':
    default:
      return 'message/sendText'
  }
}

function bodyForContentType(
  contentType: ScheduledRow['content_type'],
  phone: string,
  messageBody: string,
): Record<string, unknown> {
  switch (contentType) {
    case 'audio':
      return { number: phone, audio: messageBody }
    case 'image':
      return { number: phone, mediatype: 'image', media: messageBody }
    case 'text':
    default:
      return { number: phone, text: messageBody }
  }
}

serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const evolutionUrl = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(
    /\/+$/,
    '',
  )
  const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY') ?? ''

  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({
        error:
          'Secrets do Supabase ausentes (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (!evolutionUrl || !evolutionApiKey) {
    return new Response(
      JSON.stringify({
        error:
          'Secrets da Evolution ausentes. Rode: supabase secrets set EVOLUTION_API_URL=... EVOLUTION_API_KEY=...',
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

  const { data: candidates, error: fetchError } = await supabase
    .from('scheduled_messages')
    .select(
      'id, user_id, event_id, is_active, recipient_type, content_type, message_body, scheduled_at, status, segment_lead_ids, recipient_phone, evolution_instance_name',
    )
    .eq('status', 'pending')
    .eq('is_active', true)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(30)

  if (fetchError) {
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

    // Claim atômico: só segue quem efetivamente mudou de pending -> processing.
    const { data: claimed, error: claimErr } = await supabase
      .from('scheduled_messages')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', msg.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) {
      // Outra execução pegou; pulamos sem errar.
      continue
    }

    try {
      // 1) Resolve a lista de destinatários, sempre normalizando para E.164.
      let phones: string[] = []

      if (msg.recipient_type === 'personal') {
        const digits = toEvolutionDigits(msg.recipient_phone)
        if (!digits) {
          // Fallback: olha profiles.whatsapp/phone do próprio dono.
          const { data: prof } = await supabase
            .from('profiles')
            .select('phone, whatsapp')
            .eq('id', msg.user_id)
            .maybeSingle()
          const fromProfile =
            toEvolutionDigits(prof?.whatsapp ?? null) ??
            toEvolutionDigits(prof?.phone ?? null)
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
          .map((l: { phone: string | null }) =>
            toEvolutionDigits(l.phone),
          )
          .filter((x): x is string => Boolean(x))
      }

      if (phones.length === 0) {
        throw new Error(
          'Nenhum telefone válido para envio (lembra: DDI 55 + DDD + número).',
        )
      }

      // 2) Instance name: sempre a do usuário; evolution_instance_name legado só
      //    é usado quando segue a convenção "zapifica_*", senão caímos no fallback.
      const legacyInstance = msg.evolution_instance_name?.trim() ?? ''
      const instanceName =
        legacyInstance && legacyInstance.startsWith('zapifica_')
          ? legacyInstance
          : instanceNameFromUserId(msg.user_id)

      // 3) Dispara para cada telefone encontrado.
      const endpoint = endpointForContentType(msg.content_type)
      let lastEvolutionId: string | null = null

      for (const phone of phones) {
        const url = `${evolutionUrl}/${endpoint}/${encodeURIComponent(instanceName)}`
        const payload = bodyForContentType(
          msg.content_type,
          phone,
          msg.message_body ?? '',
        )

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
        try {
          bodyJson = JSON.parse(bodyText)
        } catch {
          // resposta não-JSON (ex.: 404 HTML do gateway) — mantém texto cru.
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

        if (bodyJson && typeof bodyJson === 'object') {
          const o = bodyJson as Record<string, unknown>
          const messageBlock = o.message as Record<string, unknown> | undefined
          const keyBlock =
            (messageBlock?.key as Record<string, unknown> | undefined) ??
            (o.key as Record<string, unknown> | undefined)
          if (keyBlock && typeof keyBlock.id === 'string') {
            lastEvolutionId = keyBlock.id
          }
        }
      }

      await supabase
        .from('scheduled_messages')
        .update({
          status: 'sent',
          evolution_message_id: lastEvolutionId,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', msg.id)

      sent += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'error',
          last_error: message.slice(0, 4000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', msg.id)
      failed += 1
    }
  }

  return new Response(
    JSON.stringify({
      message: `Processadas ${candidates.length} mensagens.`,
      sent,
      failed,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
