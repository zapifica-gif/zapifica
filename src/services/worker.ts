import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { EvolutionHttpConfig, EvolutionMediaType } from './evolution'
import {
  sendAudioMessageWithConfig,
  sendImageMessageWithConfig,
  sendMediaMessageWithConfig,
  sendTextMessageWithConfig,
} from './evolution'

export type WorkerDeps = {
  supabase: SupabaseClient
  evolution: EvolutionHttpConfig
}

/**
 * Lê `CHAVE_MESTRA_ZAPIFICA` do ambiente (Node/scripts). Mesmo segredo da Edge Function.
 */
function readChaveMestraZapificaFromEnv(): string {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> }
  }
  return (g.process?.env?.CHAVE_MESTRA_ZAPIFICA ?? '').trim()
}

/**
 * Cliente Supabase com bypass RLS, para rodar o worker fora da Edge (cron local, script).
 * Exige `CHAVE_MESTRA_ZAPIFICA` no ambiente (normalmente a service role do projeto).
 */
export function createSupabaseComChaveMestraZapifica(
  supabaseUrl: string,
): SupabaseClient {
  const key = readChaveMestraZapificaFromEnv()
  if (!key) {
    throw new Error(
      'Defina CHAVE_MESTRA_ZAPIFICA no ambiente (mesmo valor configurado na Edge Function).',
    )
  }
  return createClient(supabaseUrl.trim(), key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

export type WorkerRunSummary = {
  /** Linhas reivindicadas e processadas (tentativa de envio) */
  processed: number
  /** Falhas ao reivindicar ou erros não recuperáveis */
  skipped: number
}

type ScheduledRow = {
  id: string
  user_id: string
  lead_id: string | null
  media_url: string | null
  recipient_type: 'personal' | 'segment'
  content_type: 'text' | 'audio' | 'image' | 'document' | 'video'
  message_body: string | null
  segment_lead_ids: string[] | null
  recipient_phone?: string | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  zv_campaign_id?: string | null
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

function formatDateBR(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)
}

function weekdayBR(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
  }).format(d)
}

function timeHHMM(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

function greetingByTime(d: Date): string {
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

async function renderMessageTemplate(params: {
  supabase: SupabaseClient
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

type ChatContentType = 'text' | 'audio' | 'image' | 'document'

async function downloadMediaAsBase64(
  publicUrl: string,
): Promise<{ base64: string; mimeType: string; fileName: string }> {
  const res = await fetch(publicUrl)
  if (!res.ok) {
    throw new Error(`Falha ao baixar mídia (${res.status}): ${publicUrl.slice(0, 200)}`)
  }
  const mimeType =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const buf = Buffer.from(await res.arrayBuffer())
  const fileName = (() => {
    try {
      const path = new URL(publicUrl).pathname
      return decodeURIComponent(path.split('/').pop() || 'arquivo') || 'arquivo'
    } catch {
      return 'arquivo'
    }
  })()
  return { base64: buf.toString('base64'), mimeType, fileName }
}

function toChatContentType(
  contentType: ScheduledRow['content_type'],
): ChatContentType {
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

const BATCH_LIMIT = 30

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickRandomIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min)
  const b = Math.floor(max)
  if (b < a) return a
  return Math.floor(Math.random() * (b - a + 1)) + a
}

function defaultHumanDelayMs(): number {
  // fallback do comportamento antigo: 5–15s
  return pickRandomIntInclusive(5, 15) * 1000
}

function resolveDispatchDelayMs(row: ScheduledRow): number {
  const minS = typeof row.min_delay_seconds === 'number' ? row.min_delay_seconds : null
  const maxS = typeof row.max_delay_seconds === 'number' ? row.max_delay_seconds : null
  if (minS == null || maxS == null) return defaultHumanDelayMs()
  const safeMin = Number.isFinite(minS) ? Math.max(0, minS) : 0
  const safeMax = Number.isFinite(maxS) ? Math.max(0, maxS) : safeMin
  return pickRandomIntInclusive(safeMin, safeMax) * 1000
}

function pickPersonalRawFromUser(user: {
  phone?: string
  user_metadata?: Record<string, unknown>
}): string | null {
  const meta = user.user_metadata ?? {}
  const fromMeta =
    (typeof meta.whatsapp === 'string' && meta.whatsapp) ||
    (typeof meta.phone === 'string' && meta.phone) ||
    null
  if (user.phone?.trim()) return user.phone.trim()
  if (fromMeta?.trim()) return fromMeta.trim()
  return null
}

async function resolvePersonalPhoneFromProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('phone, whatsapp')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  const o = data as Record<string, unknown>
  const p = typeof o.phone === 'string' ? o.phone.trim() : ''
  const w = typeof o.whatsapp === 'string' ? o.whatsapp.trim() : ''
  return p || w || null
}

async function resolveRecipientPhones(
  supabase: SupabaseClient,
  row: ScheduledRow,
): Promise<{ targets: string[]; error: string | null }> {
  if (row.lead_id) {
    const inline = row.recipient_phone?.trim()
    if (inline) {
      return { targets: [inline], error: null }
    }
    const { data: lead, error } = await supabase
      .from('leads')
      .select('phone')
      .eq('id', row.lead_id)
      .eq('user_id', row.user_id)
      .maybeSingle()
    if (error) {
      return { targets: [], error: error.message }
    }
    const p = (lead as { phone: string | null } | null)?.phone?.trim()
    if (p) {
      return { targets: [p], error: null }
    }
    return { targets: [], error: 'Lead sem telefone para o disparo agendado.' }
  }

  if (row.recipient_type === 'personal') {
    const inline = row.recipient_phone?.trim()
    if (inline) {
      return { targets: [inline], error: null }
    }

    const fromProfile = await resolvePersonalPhoneFromProfile(
      supabase,
      row.user_id,
    )
    if (fromProfile?.trim()) {
      return { targets: [fromProfile.trim()], error: null }
    }

    const { data, error } = await supabase.auth.admin.getUserById(row.user_id)
    if (error || !data?.user) {
      return {
        targets: [],
        error: error?.message ?? 'Usuário não encontrado para lembrete pessoal.',
      }
    }
    const raw = pickPersonalRawFromUser(data.user)
    if (!raw) {
      return {
        targets: [],
        error:
          'Telefone não encontrado (recipient_phone vazio, profiles e auth sem número).',
      }
    }
    return { targets: [raw], error: null }
  }

  const ids = row.segment_lead_ids ?? []
  if (ids.length === 0) {
    return { targets: [], error: 'Segmento sem clientes selecionados.' }
  }

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, phone')
    .eq('user_id', row.user_id)
    .in('id', ids)

  if (error) {
    return { targets: [], error: error.message }
  }

  const targets = (leads ?? [])
    .map((l: { phone: string | null }) => (l.phone ?? '').trim())
    .filter(Boolean)

  if (targets.length === 0) {
    return {
      targets: [],
      error: 'Nenhum telefone válido nos leads selecionados.',
    }
  }

  return { targets, error: null }
}

async function sendOne(
  deps: WorkerDeps,
  row: ScheduledRow,
  recipient: string,
): Promise<{ ok: boolean; error: string | null; messageId: string | null }> {
  const { evolution } = deps
  const uid = row.user_id
  const body = await renderMessageTemplate({
    supabase: deps.supabase,
    userId: uid,
    leadId: row.lead_id,
    text: row.message_body ?? '',
  })
  const caption = body.trim() ? body : undefined
  const mediaUrl = row.media_url?.trim()

  if (mediaUrl) {
    let b64: string
    let mimeType: string
    let fileName: string
    try {
      const d = await downloadMediaAsBase64(mediaUrl)
      b64 = d.base64
      mimeType = d.mimeType
      fileName = d.fileName
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg, messageId: null }
    }

    const ct = row.content_type
    if (ct === 'audio') {
      return sendAudioMessageWithConfig(uid, recipient, b64, evolution)
    }
    if (ct === 'text') {
      return sendMediaMessageWithConfig(
        uid,
        recipient,
        {
          media: b64,
          mediaType: 'document',
          mimeType,
          fileName,
          caption,
        },
        evolution,
      )
    }
    const mediaTypeMap: Record<string, EvolutionMediaType> = {
      image: 'image',
      video: 'video',
      document: 'document',
    }
    const mediaType: EvolutionMediaType = mediaTypeMap[ct] ?? 'document'
    return sendMediaMessageWithConfig(
      uid,
      recipient,
      {
        media: b64,
        mediaType,
        mimeType,
        fileName,
        caption,
        ptt: false,
      },
      evolution,
    )
  }

  if (!body.trim()) {
    return { ok: false, error: 'Mensagem vazia (sem texto e sem mídia).', messageId: null }
  }

  switch (row.content_type) {
    case 'text':
      return sendTextMessageWithConfig(uid, recipient, body, evolution)
    case 'audio':
      return sendAudioMessageWithConfig(uid, recipient, body, evolution)
    case 'image':
      return sendImageMessageWithConfig(uid, recipient, body, '', evolution)
    case 'document':
    case 'video':
      return {
        ok: false,
        error:
          'Documento/vídeo agendado exige a coluna `media_url` (URL pública) para o worker baixar o arquivo.',
        messageId: null,
      }
    default:
      return sendTextMessageWithConfig(uid, recipient, body, evolution)
  }
}

/**
 * Processa a fila de `scheduled_messages` prontas para envio.
 * Não interrompe o lote inteiro se uma mensagem falhar — cada linha é isolada.
 */
export async function checkAndSendScheduledMessages(
  deps: WorkerDeps,
): Promise<WorkerRunSummary> {
  const { supabase } = deps
  const nowUtcIso = new Date().toISOString()
  console.log(
    '[worker] Buscando mensagens pending com scheduled_at <=',
    nowUtcIso,
    '| filtros: .eq("status","pending"), .eq("is_active", true boolean)',
  )

  const { data, error } = await supabase
    .from('scheduled_messages')
    .select(
      'id, user_id, lead_id, media_url, recipient_type, content_type, message_body, segment_lead_ids, recipient_phone, min_delay_seconds, max_delay_seconds, zv_campaign_id',
    )
    .eq('status', 'pending')
    .eq('is_active', true)
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowUtcIso)
    .order('scheduled_at', { ascending: true })
    .limit(BATCH_LIMIT)

  const candidates = data
  console.log(
    '[worker] Resultado da busca:',
    candidates?.length ?? 0,
    'linhas encontradas. Erro do banco:',
    error,
  )

  if (error) {
    console.error('[worker] Falha ao listar agendamentos:', error.message)
    return { processed: 0, skipped: 1 }
  }

  let processed = 0
  let skipped = 0

  for (const raw of candidates ?? []) {
    const row = raw as ScheduledRow

    const { data: claimed, error: claimErr } = await supabase
      .from('scheduled_messages')
      .update({
        status: 'processing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) {
      skipped += 1
      continue
    }

    try {
      const delayMs = resolveDispatchDelayMs(row)
      console.log(`[worker] Delay antes do envio: ${delayMs}ms | msg=${row.id}`)
      await sleep(delayMs)

      const { targets, error: resolveErr } = await resolveRecipientPhones(
        supabase,
        row,
      )
      if (resolveErr || targets.length === 0) {
        await supabase
          .from('scheduled_messages')
          .update({
            status: 'error',
            last_error: resolveErr ?? 'Sem destinatários.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        processed += 1
        continue
      }

      const sendResults: {
        ok: boolean
        error: string | null
        messageId: string | null
      }[] = []

      for (const recipient of targets) {
        try {
          const r = await sendOne(deps, row, recipient)
          sendResults.push(r)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          sendResults.push({ ok: false, error: msg, messageId: null })
        }
      }

      const oks = sendResults.filter((r) => r.ok)
      const fails = sendResults.filter((r) => !r.ok)

      if (oks.length === sendResults.length) {
        const ids = oks
          .map((r) => r.messageId)
          .filter((x): x is string => Boolean(x))
        await supabase
          .from('scheduled_messages')
          .update({
            status: 'sent',
            evolution_message_id: ids.length ? ids.join(',') : null,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)

        if (row.lead_id) {
          const evoId = oks[0]?.messageId ?? (ids[0] ?? null)
          const { error: chatErr } = await supabase.from('chat_messages').insert({
            lead_id: row.lead_id,
            sender_type: 'agencia',
            content_type: toChatContentType(row),
            message_body: messageBodyParaChat(row),
            media_url: row.media_url,
            evolution_message_id: evoId,
          })
          if (chatErr) {
            await supabase
              .from('scheduled_messages')
              .update({
                last_error: `Enviado ao WhatsApp, mas o CRM não registrou a mensagem: ${chatErr.message}`.slice(
                  0,
                  4000,
                ),
                updated_at: new Date().toISOString(),
              })
              .eq('id', row.id)
          }
        }

        // Finalização de campanha + unlock da IA (mesma regra da Edge Function).
        if (row.lead_id && row.zv_campaign_id) {
          const { data: prog } = await supabase
            .from('lead_campaign_progress')
            .select('id, status')
            .eq('user_id', row.user_id)
            .eq('lead_id', row.lead_id)
            .eq('campaign_id', row.zv_campaign_id)
            .in('status', ['active', 'awaiting_last_send'])
            .maybeSingle()

          const { count } = await supabase
            .from('scheduled_messages')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', row.user_id)
            .eq('lead_id', row.lead_id)
            .eq('zv_campaign_id', row.zv_campaign_id)
            .in('status', ['pending', 'processing'])
            .eq('is_active', true)

          if ((count ?? 0) === 0) {
            const isAwaiting =
              prog && typeof (prog as any).status === 'string'
                ? String((prog as any).status) === 'awaiting_last_send'
                : false
            if (!prog || isAwaiting) {
              const { error: compErr } = await supabase
                .from('lead_campaign_completions')
                .insert({
                  user_id: row.user_id,
                  lead_id: row.lead_id,
                  campaign_id: row.zv_campaign_id,
                })
              if (compErr && (compErr as any).code !== '23505') {
                console.warn('[worker] completion insert:', compErr.message)
              }
              if (prog && (prog as any).id) {
                await supabase
                  .from('lead_campaign_progress')
                  .delete()
                  .eq('id', (prog as any).id)
              }
              await supabase
                .from('leads')
                .update({ funnel_locked_until: null })
                .eq('id', row.lead_id)
                .eq('user_id', row.user_id)
            }
          }
        }
      } else if (oks.length > 0) {
        const failText = fails
          .map((f) => f.error ?? 'Erro desconhecido')
          .join(' | ')
        await supabase
          .from('scheduled_messages')
          .update({
            status: 'error',
            evolution_message_id: oks
              .map((r) => r.messageId)
              .filter(Boolean)
              .join(','),
            last_error: `Envio parcial: ${oks.length} ok, ${fails.length} falha(s). ${failText}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
      } else {
        const failText = fails
          .map((f) => f.error ?? 'Erro desconhecido')
          .join(' | ')
        await supabase
          .from('scheduled_messages')
          .update({
            status: 'error',
            evolution_message_id: null,
            last_error: failText.slice(0, 4000),
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'error',
          last_error: `Exceção no worker: ${msg}`.slice(0, 4000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
    }

    processed += 1
  }

  return { processed, skipped }
}
