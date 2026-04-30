import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  CalendarClock,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
  Mic,
  Paperclip,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { sendMediaMessage, sendTextMessage, type EvolutionMediaType } from '../../services/evolution'
import type { Lead } from './CrmKanbanBoard'

export type ChatMessageRow = {
  id: string
  lead_id: string
  sender_type: 'agencia' | 'cliente' | 'ia'
  content_type: 'text' | 'audio' | 'image' | 'document'
  message_body: string | null
  media_url: string | null
  evolution_message_id: string | null
  created_at: string
}

type ScheduledChatMessageRow = {
  id: string
  lead_id: string | null
  content_type: 'text' | 'audio' | 'image' | 'document' | 'video'
  message_body: string | null
  media_url: string | null
  scheduled_at: string | null
  status: string | null
  created_at: string
  recurrence?: string | null
}

type ChatWindowProps = {
  open: boolean
  onClose: () => void
  lead: Lead | null
}

function bubbleStyle(sender: ChatMessageRow['sender_type']): string {
  switch (sender) {
    case 'agencia':
      return 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 text-white'
    case 'ia':
      return 'ml-auto max-w-[85%] rounded-2xl rounded-br-md border border-violet-200 bg-violet-50 text-violet-950'
    case 'cliente':
    default:
      return 'mr-auto max-w-[85%] rounded-2xl rounded-bl-md border border-zinc-200/90 bg-white text-zinc-900'
  }
}

function senderLabel(sender: ChatMessageRow['sender_type']): string {
  switch (sender) {
    case 'agencia':
      return 'Agência'
    case 'ia':
      return 'IA'
    case 'cliente':
    default:
      return 'Cliente'
  }
}

function contentLabel(contentType: ChatMessageRow['content_type']): string {
  switch (contentType) {
    case 'audio':
      return 'áudio'
    case 'image':
      return 'imagem'
    case 'document':
      return 'arquivo'
    case 'text':
    default:
      return 'texto'
  }
}

/**
 * Placeholders internos que a Edge Function usa quando a mensagem é mídia,
 * mas que NUNCA devem aparecer como texto puro no balão.
 */
const MEDIA_PLACEHOLDERS = new Set([
  '[imagem]',
  '[áudio]',
  '[audio]',
  '[documento]',
  '[vídeo]',
  '[video]',
  '[mensagem]',
])

function shouldShowText(message: ChatMessageRow): boolean {
  const body = message.message_body?.trim()
  if (!body) return false
  if (MEDIA_PLACEHOLDERS.has(body.toLowerCase())) return false
  return true
}

/**
 * Texto amigável para quando a mídia ainda não terminou de ser processada
 * pelo webhook (ex: a Busca Ativa falhou ou ainda está em curso).
 */
function pendingMediaLabel(contentType: ChatMessageRow['content_type']): string {
  switch (contentType) {
    case 'image':
      return 'Imagem em processamento…'
    case 'audio':
      return 'Áudio em processamento…'
    case 'document':
      return 'Arquivo em processamento…'
    case 'text':
    default:
      return ''
  }
}

function MessageMedia({ message }: { message: ChatMessageRow }) {
  // Se for um content_type de mídia mas SEM url, mostramos um placeholder
  // gentil em vez de despejar "[imagem]" literal no balão.
  if (!message.media_url) {
    if (message.content_type === 'text') return null
    return (
      <p className="text-xs italic text-zinc-400">
        {pendingMediaLabel(message.content_type)}
      </p>
    )
  }

  if (message.content_type === 'image') {
    return (
      <a
        href={message.media_url}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-xl border border-white/20 bg-zinc-100"
        aria-label="Abrir imagem em nova aba"
      >
        <img
          src={message.media_url}
          alt="Mídia"
          className="block h-auto max-h-80 w-full object-contain"
          loading="lazy"
        />
      </a>
    )
  }

  if (message.content_type === 'audio') {
    return (
      <audio
        controls
        preload="metadata"
        src={message.media_url}
        className="w-64 max-w-full rounded-xl"
      >
        Seu navegador não conseguiu reproduzir este áudio.
      </audio>
    )
  }

  if (message.content_type === 'document') {
    const url = message.media_url
    const isVideo = /\.(mp4|webm|mov|m4v|3gp)(\?|#|$)/i.test(url)
    if (isVideo) {
      return (
        <video
          controls
          preload="metadata"
          src={url}
          className="max-h-80 w-full max-w-full rounded-xl bg-black/90"
        >
          Seu navegador não conseguiu reproduzir este vídeo.
        </video>
      )
    }
    return (
      <a
        href={message.media_url}
        target="_blank"
        rel="noreferrer"
        download
        className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 text-zinc-800 shadow-sm transition hover:border-brand-200 hover:bg-brand-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-600/10 text-brand-700">
          <FileText className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {(() => {
              const body = message.message_body?.trim()
              if (!body || MEDIA_PLACEHOLDERS.has(body.toLowerCase())) {
                return 'Arquivo recebido'
              }
              return body
            })()}
          </span>
          <span className="block text-xs text-zinc-500">Abrir ou baixar arquivo</span>
        </span>
      </a>
    )
  }

  return null
}

export function ChatWindow({ open, onClose, lead }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [aiEnabled, setAiEnabled] = useState<boolean>(true)
  const [loadingAi, setLoadingAi] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [campaignLabel, setCampaignLabel] = useState<string | null>(null)
  const [campaignLoading, setCampaignLoading] = useState(false)
  const [pendingMedia, setPendingMedia] = useState<
    Record<string, 'sending' | 'failed'>
  >({})
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<BlobPart[]>([])
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recordTimerRef = useRef<number | null>(null)

  // ─── Agendador de envio (Agenda Suprema acoplada ao chat) ──────────────────
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleRecurrence, setScheduleRecurrence] = useState<
    'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  >('none')
  const [scheduleAttachment, setScheduleAttachment] = useState<File | null>(null)
  const [submittingSchedule, setSubmittingSchedule] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduleToast, setScheduleToast] = useState<string | null>(null)
  const scheduleAttachmentInputRef = useRef<HTMLInputElement | null>(null)

  const [futureModalOpen, setFutureModalOpen] = useState(false)
  const [futureMessages, setFutureMessages] = useState<ScheduledChatMessageRow[]>([])
  const [loadingFuture, setLoadingFuture] = useState(false)
  const [futureError, setFutureError] = useState<string | null>(null)
  const [deletingFutureId, setDeletingFutureId] = useState<string | null>(null)

  const recordTimeLabel = useMemo(() => {
    const mm = String(Math.floor(recordSeconds / 60)).padStart(2, '0')
    const ss = String(recordSeconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }, [recordSeconds])

  const scrollToEnd = useCallback(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const fetchInitial = useCallback(async (leadId: string) => {
    setLoading(true)
    setMessages([])
    setDraft('')
    setLoadError(null)
    setSendError(null)
    const { data, error } = await supabase
      .from('chat_messages')
      .select(
        'id, lead_id, sender_type, content_type, message_body, media_url, evolution_message_id, created_at',
      )
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true })
      .limit(500)

    if (error) {
      setLoadError('Não foi possível carregar a conversa.')
      setLoading(false)
      return
    }
    setMessages((data ?? []) as ChatMessageRow[])
    setLoading(false)
    setTimeout(scrollToEnd, 50)
  }, [scrollToEnd])

  useEffect(() => {
    if (!open || !lead) return
    const timer = window.setTimeout(() => {
      void fetchInitial(lead.id)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, lead, fetchInitial])

  useEffect(() => {
    if (!open || !lead) return
    setAiError(null)
    setLoadingAi(true)
    void (async () => {
      const { data, error } = await supabase
        .from('leads')
        .select('ai_enabled')
        .eq('id', lead.id)
        .maybeSingle()
      if (error) {
        setAiError('Não foi possível carregar o estado da IA.')
        setLoadingAi(false)
        return
      }
      const enabled = (data as { ai_enabled?: boolean | null } | null)?.ai_enabled
      setAiEnabled(enabled !== false)
      setLoadingAi(false)
    })()
  }, [open, lead?.id])

  // Identificação da campanha de origem (mais recente):
  // 1) se existe progresso ativo para este lead, usa essa campanha
  // 2) senão, pega a última conclusão (lead_campaign_completions)
  useEffect(() => {
    if (!open || !lead) return
    let cancelled = false
    setCampaignLoading(true)
    setCampaignLabel(null)
    void (async () => {
      try {
        const { data: prog, error: pErr } = await supabase
          .from('lead_campaign_progress')
          .select('campaign_id, updated_at')
          .eq('lead_id', lead.id)
          .in('status', ['active', 'awaiting_last_send'])
          .order('updated_at', { ascending: false })
          .limit(1)
        if (cancelled) return
        if (!pErr && prog && prog[0]?.campaign_id) {
          const cid = (prog[0] as any).campaign_id as string
          const { data: camp } = await supabase
            .from('zv_campaigns')
            .select('name')
            .eq('id', cid)
            .maybeSingle()
          if (cancelled) return
          const nm = (camp as any)?.name ? String((camp as any).name) : null
          setCampaignLabel(nm ? `Campanha: ${nm}` : 'Campanha: (não encontrada)')
          setCampaignLoading(false)
          return
        }

        const { data: comps, error: cErr } = await supabase
          .from('lead_campaign_completions')
          .select('campaign_id, completed_at')
          .eq('lead_id', lead.id)
          .order('completed_at', { ascending: false })
          .limit(1)
        if (cancelled) return
        if (cErr || !comps || !comps[0]?.campaign_id) {
          setCampaignLabel(null)
          setCampaignLoading(false)
          return
        }
        const cid = (comps[0] as any).campaign_id as string
        const { data: camp } = await supabase
          .from('zv_campaigns')
          .select('name')
          .eq('id', cid)
          .maybeSingle()
        if (cancelled) return
        const nm = (camp as any)?.name ? String((camp as any).name) : null
        setCampaignLabel(nm ? `Campanha: ${nm} (concluída)` : 'Campanha: (fluxo excluído)')
        setCampaignLoading(false)
      } catch {
        if (!cancelled) {
          setCampaignLabel(null)
          setCampaignLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, lead?.id])

  async function toggleAiEnabled() {
    if (!lead) return
    setAiError(null)
    const next = !aiEnabled
    setAiEnabled(next)
    setLoadingAi(true)
    const { error } = await supabase.from('leads').update({ ai_enabled: next }).eq('id', lead.id)
    setLoadingAi(false)
    if (error) {
      setAiEnabled(!next)
      setAiError(`Falha ao atualizar IA: ${error.message}`)
    }
  }

  useEffect(() => {
    if (!open || !lead) return

    const channel = supabase
      .channel(`chat_messages:${lead.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `lead_id=eq.${lead.id}`,
        },
        (payload) => {
          const row = payload.new as ChatMessageRow
          setMessages((prev) => {
            if (prev.some((m) => m.id === row.id)) return prev
            return [...prev, row]
          })
          setTimeout(scrollToEnd, 80)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [open, lead, scrollToEnd])

  useEffect(() => {
    if (messages.length) scrollToEnd()
  }, [messages.length, scrollToEnd, open])

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) {
        window.clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop()
        } catch {
          // ignore
        }
      }
      if (recorderStreamRef.current) {
        recorderStreamRef.current.getTracks().forEach((t) => t.stop())
        recorderStreamRef.current = null
      }
    }
  }, [])

  async function handleSend(e: FormEvent) {
    e.preventDefault()
    if (!lead) return
    const text = draft.trim()
    if (!text) return
    setSendError(null)
    setSending(true)
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setSendError('Sessão inválida. Entre novamente.')
      setSending(false)
      return
    }
    const evo = await sendTextMessage(user.id, lead.phone, text)
    if (!evo.ok) {
      setSendError(evo.error ?? 'Falha ao enviar pelo WhatsApp.')
      setSending(false)
      return
    }
    const { error } = await supabase.from('chat_messages').insert({
      lead_id: lead.id,
      sender_type: 'agencia',
      content_type: 'text',
      message_body: text,
      evolution_message_id: evo.messageId,
    })
    if (error) {
      setSendError(error.message)
      setSending(false)
      return
    }
    setDraft('')
    setSending(false)
  }

  function mapFileToMediaType(file: File): {
    evolution: EvolutionMediaType
    contentType: ChatMessageRow['content_type']
  } {
    const type = file.type || ''
    if (type.startsWith('image/')) return { evolution: 'image', contentType: 'image' }
    if (type.startsWith('audio/')) return { evolution: 'audio', contentType: 'audio' }
    if (type.startsWith('video/')) return { evolution: 'video', contentType: 'document' }
    return { evolution: 'document', contentType: 'document' }
  }

  async function fileToBase64Pure(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.readAsDataURL(file)
    })
    const marker = ';base64,'
    const idx = dataUrl.toLowerCase().indexOf(marker)
    if (idx >= 0) return dataUrl.slice(idx + marker.length)
    // fallback: se vier sem prefixo, assume que já é base64
    return dataUrl
  }

  async function sendFileAsMedia(params: {
    file: File
    caption: string
    forceType?: EvolutionMediaType
    forceContentType?: ChatMessageRow['content_type']
    ptt?: boolean
  }) {
    if (!lead) return
    setSendError(null)

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setSendError('Sessão inválida. Entre novamente.')
      return
    }

    const { evolution, contentType } = params.forceType
      ? {
          evolution: params.forceType,
          contentType: params.forceContentType ?? 'document',
        }
      : mapFileToMediaType(params.file)

    // 1) Upload no bucket público (para já aparecer no CRM instantaneamente)
    const safeName = params.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const msgId = crypto.randomUUID()
    const path = `${user.id}/${lead.id}/${msgId}_${safeName}`

    const { error: upErr } = await supabase.storage
      .from('chat_media')
      .upload(path, params.file, {
        upsert: true,
        contentType: params.file.type || undefined,
      })
    if (upErr) {
      setSendError(`Falha ao subir arquivo no Storage: ${upErr.message}`)
      return
    }

    const { data: pub } = supabase.storage.from('chat_media').getPublicUrl(path)
    const publicUrl = pub.publicUrl

    // 2) Base64 para o disparo na Evolution
    let base64Pure: string
    try {
      base64Pure = await fileToBase64Pure(params.file)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSendError(`Falha ao converter arquivo para Base64: ${msg}`)
      return
    }

    // 3) Grava no banco imediatamente (optimistic persist)
    const caption = params.caption.trim()
    const { data: inserted, error: insErr } = await supabase
      .from('chat_messages')
      .insert({
        lead_id: lead.id,
        sender_type: 'agencia',
        content_type: contentType,
        message_body:
          caption ||
          (contentType === 'image'
            ? '[imagem]'
            : contentType === 'audio'
              ? '[áudio]'
              : evolution === 'video'
                ? '[vídeo]'
                : params.file.name),
        media_url: publicUrl,
        evolution_message_id: null,
      })
      .select('id')
      .single()

    if (insErr || !inserted?.id) {
      setSendError(
        `Falha ao salvar mensagem no banco: ${insErr?.message ?? 'sem id'}`,
      )
      return
    }

    const rowId = inserted.id as string
    setPendingMedia((prev) => ({ ...prev, [rowId]: 'sending' }))

    // 4) Envia na Evolution (Base64 + legenda)
    const evo = await sendMediaMessage(user.id, lead.phone, {
      media: base64Pure,
      mediaType: evolution,
      mimeType: params.file.type || 'application/octet-stream',
      fileName: params.file.name || safeName,
      caption,
      ptt: params.ptt,
    })

    if (!evo.ok) {
      setPendingMedia((prev) => ({ ...prev, [rowId]: 'failed' }))
      setSendError(evo.error ?? 'Falha ao enviar mídia pelo WhatsApp.')
      return
    }

    await supabase
      .from('chat_messages')
      .update({ evolution_message_id: evo.messageId })
      .eq('id', rowId)

    setPendingMedia((prev) => {
      const next = { ...prev }
      delete next[rowId]
      return next
    })
  }

  async function handlePickFile(file: File) {
    const caption = draft.trim()
    setDraft('')
    await sendFileAsMedia({ file, caption })
  }

  async function startRecording() {
    if (recording) return
    setSendError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recorderStreamRef.current = stream
      recorderChunksRef.current = []

      const mimeCandidates = [
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus',
        'audio/webm',
      ]
      const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder

      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          recorderChunksRef.current.push(evt.data)
        }
      }

      recorder.onstop = () => {
        // stream é encerrado por cancel/confirm
      }

      setRecordSeconds(0)
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1)
      }, 1000)

      recorder.start()
      setRecording(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSendError(`Não foi possível acessar o microfone: ${msg}`)
      setRecording(false)
    }
  }

  function cancelRecording() {
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    setRecording(false)
    setRecordSeconds(0)

    const rec = recorderRef.current
    recorderRef.current = null
    try {
      if (rec && rec.state !== 'inactive') rec.stop()
    } catch {
      // ignore
    }
    recorderChunksRef.current = []

    if (recorderStreamRef.current) {
      recorderStreamRef.current.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
    }
  }

  async function confirmRecording() {
    if (!recording) return
    const rec = recorderRef.current
    if (!rec) return

    // Para garantir que o último chunk entrou.
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      rec.addEventListener('stop', done, { once: true })
      try {
        rec.stop()
      } catch {
        resolve()
      }
    })

    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    setRecording(false)

    if (recorderStreamRef.current) {
      recorderStreamRef.current.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
    }

    const blob = new Blob(recorderChunksRef.current, { type: rec.mimeType || 'audio/webm' })
    recorderChunksRef.current = []
    recorderRef.current = null

    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    const voiceFile = new File([blob], `voz_${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' })

    await sendFileAsMedia({
      file: voiceFile,
      caption: '',
      forceType: 'audio',
      forceContentType: 'audio',
      ptt: true,
    })
  }

  // ─── Helpers do Agendador ────────────────────────────────────────────────
  function abrirModalAgendamento() {
    setScheduleError(null)
    // pré-preenche com "amanhã, mesma hora", arredondado para minutos cheios
    const agora = new Date()
    const amanha = new Date(agora.getTime() + 24 * 60 * 60 * 1000)
    const yyyy = amanha.getFullYear()
    const mm = String(amanha.getMonth() + 1).padStart(2, '0')
    const dd = String(amanha.getDate()).padStart(2, '0')
    const hh = String(amanha.getHours()).padStart(2, '0')
    const mi = String(amanha.getMinutes()).padStart(2, '0')
    setScheduleDate(`${yyyy}-${mm}-${dd}`)
    setScheduleTime(`${hh}:${mi}`)
    setScheduleAttachment(null)
    setScheduleRecurrence('none')
    setScheduleModalOpen(true)
  }

  function fecharModalAgendamento() {
    setScheduleModalOpen(false)
    setScheduleError(null)
    setScheduleAttachment(null)
    setScheduleRecurrence('none')
  }

  function classificarAnexo(file: File): ScheduledChatMessageRow['content_type'] {
    const t = file.type || ''
    if (t.startsWith('image/')) return 'image'
    if (t.startsWith('audio/')) return 'audio'
    if (t.startsWith('video/')) return 'video'
    return 'document'
  }

  /**
   * Monta o instante a partir de data + hora no **fuso do navegador** e devolve
   * string ISO em UTC. Evita a ambiguidade de `new Date("YYYY-MM-DDTHH:mm:ss")`, que
   * em alguns motores vira interpretação UTC e atrasa 3h no Brasil.
   */
  function dataHoraLocalParaUtcIso(dataYmd: string, timeHm: string): string | null {
    const dPart = dataYmd.trim().split('-').map((x) => Number(x))
    const tPart = timeHm.trim().split(':').map((x) => Number(x))
    if (dPart.length !== 3 || tPart.length < 2) return null
    const y = dPart[0]!
    const mo = dPart[1]!
    const d = dPart[2]!
    const h = tPart[0]!
    const mi = tPart[1]!
    if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null
    const local = new Date(y, mo - 1, d, h, mi, 0, 0)
    if (Number.isNaN(local.getTime())) return null
    return local.toISOString()
  }

  async function programarEnvio() {
    if (!lead) return
    setScheduleError(null)

    const dataStr = scheduleDate.trim()
    const horaStr = scheduleTime.trim()
    if (!dataStr || !horaStr) {
      setScheduleError('Informe a data e a hora do envio.')
      return
    }

    const scheduledAtUtc = dataHoraLocalParaUtcIso(dataStr, horaStr)
    if (!scheduledAtUtc) {
      setScheduleError('Data ou hora inválidas.')
      return
    }
    if (new Date(scheduledAtUtc).getTime() <= Date.now()) {
      setScheduleError('Escolha uma data/hora no futuro.')
      return
    }

    const texto = draft.trim()
    if (!texto && !scheduleAttachment) {
      setScheduleError('Escreva uma mensagem ou anexe um arquivo para agendar.')
      return
    }

    setSubmittingSchedule(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setScheduleError('Sessão inválida. Entre novamente.')
        return
      }

      let mediaUrl: string | null = null
      let contentType: ScheduledChatMessageRow['content_type'] = 'text'

      if (scheduleAttachment) {
        contentType = classificarAnexo(scheduleAttachment)
        const safeName = scheduleAttachment.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${user.id}/${lead.id}/agenda_${crypto.randomUUID()}_${safeName}`
        const { error: upErr } = await supabase.storage
          .from('chat_media')
          .upload(path, scheduleAttachment, {
            upsert: true,
            contentType: scheduleAttachment.type || undefined,
          })
        if (upErr) {
          setScheduleError(`Falha ao subir anexo: ${upErr.message}`)
          return
        }
        const { data: pub } = supabase.storage.from('chat_media').getPublicUrl(path)
        mediaUrl = pub.publicUrl
      }

      console.log(
        '[Agenda Suprema/Chat] Salvando agendamento em UTC (scheduled_at):',
        scheduledAtUtc,
        '| local escolhido ≈',
        new Date(scheduledAtUtc).toString(),
      )

      const { error: insErr } = await supabase
        .from('scheduled_messages')
        .insert({
          user_id: user.id,
          lead_id: lead.id,
          is_active: true,
          recipient_type: 'personal',
          content_type: contentType,
          message_body: texto || null,
          media_url: mediaUrl,
          scheduled_at: scheduledAtUtc,
          status: 'pending',
          recipient_phone: lead.phone || null,
          recurrence: scheduleRecurrence,
        })
        .select('id')

      if (insErr) {
        setScheduleError(`Não foi possível agendar: ${insErr.message}`)
        return
      }

      setDraft('')
      setScheduleAttachment(null)
      setScheduleModalOpen(false)
      setScheduleToast('Mensagem agendada!')
      window.setTimeout(() => setScheduleToast(null), 2800)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setScheduleError(`Erro inesperado ao agendar: ${msg}`)
    } finally {
      setSubmittingSchedule(false)
    }
  }

  // ─── Histórico "Conversas Futuras" ───────────────────────────────────────
  const fetchFutureMessages = useCallback(async (leadId: string) => {
    setLoadingFuture(true)
    setFutureError(null)
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select(
        'id, lead_id, content_type, message_body, media_url, scheduled_at, status, recurrence, created_at',
      )
      .eq('lead_id', leadId)
      .order('scheduled_at', { ascending: true })
      .limit(200)
    if (error) {
      setFutureError('Não foi possível carregar as conversas futuras.')
      setLoadingFuture(false)
      return
    }
    setFutureMessages((data ?? []) as ScheduledChatMessageRow[])
    setLoadingFuture(false)
  }, [])

  function abrirConversasFuturas() {
    if (!lead) return
    setFutureModalOpen(true)
    void fetchFutureMessages(lead.id)
  }

  async function excluirAgendamento(id: string) {
    setDeletingFutureId(id)
    const { error } = await supabase.from('scheduled_messages').delete().eq('id', id)
    setDeletingFutureId(null)
    if (error) {
      setFutureError(`Falha ao excluir: ${error.message}`)
      return
    }
    setFutureMessages((prev) => prev.filter((m) => m.id !== id))
  }

  if (!open) return null

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[60] cursor-default bg-zinc-950/40 backdrop-blur-[2px] transition"
        aria-label="Fechar painel de chat"
        onClick={onClose}
      />
      <aside
        className="fixed right-0 top-0 z-[70] flex h-full w-full max-w-md flex-col border-l border-zinc-200/90 bg-zinc-50 shadow-2xl"
        role="complementary"
        aria-labelledby="inbox-title"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-zinc-200/90 bg-white px-4 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600/10 text-brand-700">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="inbox-title"
              className="truncate text-sm font-semibold text-zinc-900"
            >
              {lead?.name ?? 'Conversa'}
            </h2>
            <p className="mt-0.5 truncate text-xs text-zinc-500 tabular-nums">
              {lead?.phone ?? '—'}
            </p>
            {campaignLoading ? (
              <p className="mt-1 text-[11px] text-zinc-400">Carregando campanha…</p>
            ) : campaignLabel ? (
              <button
                type="button"
                onClick={() => {
                  window.alert(campaignLabel)
                }}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-700 transition hover:bg-zinc-50"
                title="Ver campanha de origem"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                {campaignLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={abrirConversasFuturas}
              disabled={!lead}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700 transition hover:border-brand-300 hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Ver mensagens agendadas para este lead"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Conversas Futuras
            </button>

            <button
              type="button"
              onClick={() => void toggleAiEnabled()}
              disabled={!lead || loadingAi}
              className={`mt-2 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                aiEnabled
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : 'border border-zinc-200 bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
              }`}
              title={aiEnabled ? 'Clique para o humano assumir' : 'Clique para ligar a IA'}
            >
              {loadingAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {aiEnabled ? '🤖 IA Ligada' : '👤 Humano'}
            </button>
            {aiError ? (
              <p className="mt-1 text-[11px] font-medium text-rose-600">{aiError}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        >
          {loading ? (
            <p className="text-center text-sm text-zinc-500">Carregando mensagens…</p>
          ) : null}
          {loadError ? (
            <p className="text-center text-sm text-rose-600">{loadError}</p>
          ) : null}
          {!loading && !loadError && messages.length === 0 ? (
            <p className="text-center text-sm text-zinc-500">
              Nenhuma mensagem ainda. Escreva abaixo para enviar (WhatsApp) ou
              aguarde o cliente responder — as mensagens recebidas aparecem
              quando a Evolution estiver a enviar webhooks.
            </p>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex w-full ${m.sender_type === 'cliente' ? 'justify-start' : 'justify-end'}`}
            >
              <div className="max-w-full">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                    {senderLabel(m.sender_type)} · {contentLabel(m.content_type)}
                  </p>
                  {pendingMedia[m.id] ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        pendingMedia[m.id] === 'sending'
                          ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200'
                          : 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
                      }`}
                      title={
                        pendingMedia[m.id] === 'sending'
                          ? 'Enviando mídia pelo WhatsApp…'
                          : 'Falha ao enviar mídia. Tente novamente.'
                      }
                    >
                      {pendingMedia[m.id] === 'sending' ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      ) : (
                        <TriangleAlert className="h-3 w-3" aria-hidden />
                      )}
                      {pendingMedia[m.id] === 'sending' ? 'Enviando…' : 'Falhou'}
                    </span>
                  ) : null}
                </div>
                <div
                  className={`space-y-2 whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${bubbleStyle(m.sender_type)}`}
                >
                  <MessageMedia message={m} />
                  {shouldShowText(m) ? <p>{m.message_body}</p> : null}
                </div>
                <p className="mt-1 text-right text-[10px] text-zinc-400">
                  {new Date(m.created_at).toLocaleString(undefined, {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>

        <footer className="shrink-0 border-t border-zinc-200/90 bg-white p-3">
          {sendError ? (
            <p className="mb-2 text-xs text-rose-600" role="alert">
              {sendError}
            </p>
          ) : null}
          {recording ? (
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-sm font-semibold text-rose-900">
                    Gravando…
                  </span>
                </div>
                <span className="font-mono text-sm text-rose-900">
                  {recordTimeLabel}
                </span>
              </div>
              <button
                type="button"
                onClick={cancelRecording}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:bg-zinc-50"
                aria-label="Cancelar gravação"
                title="Cancelar"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void confirmRecording()}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 text-white shadow-md transition hover:from-brand-500 hover:to-brand-600"
                aria-label="Enviar áudio"
                title="Enviar"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSend} className="flex items-end gap-2">
            <label htmlFor="inbox-compose" className="sr-only">
              Nova mensagem
            </label>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null
                e.currentTarget.value = ''
                if (!f) return
                void handlePickFile(f)
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!lead || sending}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Anexar arquivo"
              title="Anexar arquivo"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void startRecording()}
              disabled={!lead || sending}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Gravar áudio"
              title="Gravar áudio"
            >
              <Mic className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={abrirModalAgendamento}
              disabled={!lead || sending}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Agendar envio"
              title="Agendar envio"
            >
              <Clock className="h-4 w-4" />
            </button>
            <textarea
              id="inbox-compose"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
              disabled={!lead || sending}
              rows={2}
              placeholder="Digite e envie ao WhatsApp…"
              className="min-h-[44px] w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!lead || sending || !draft.trim()}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 text-white shadow-md transition hover:from-brand-500 hover:to-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Enviar"
            >
              <Send className="h-4 w-4" />
            </button>
            </form>
          )}
        </footer>
      </aside>

      {scheduleToast ? (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[90] inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 shadow-lg"
        >
          <CalendarClock className="h-4 w-4" />
          {scheduleToast}
        </div>
      ) : null}

      {scheduleModalOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 backdrop-blur-[2px] px-4">
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agendar-titulo"
          >
            <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600/10 text-brand-700">
                <CalendarClock className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <h3 id="agendar-titulo" className="text-sm font-semibold text-zinc-900">
                  Agendar envio para {lead?.name ?? 'este contato'}
                </h3>
                <p className="text-xs text-zinc-500">
                  A mensagem fica na fila e o robô dispara no horário escolhido. Opcionalmente pode
                  repetir (sem afetar fluxos de campanha Zap Voice).
                </p>
              </div>
              <button
                type="button"
                onClick={fecharModalAgendamento}
                className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                aria-label="Fechar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-zinc-700">
                    Data do envio
                  </span>
                  <input
                    type="date"
                    value={scheduleDate}
                    onChange={(e) => setScheduleDate(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-zinc-700">
                    Hora do envio
                  </span>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-zinc-700">Recorrência</span>
                <select
                  value={scheduleRecurrence}
                  onChange={(e) =>
                    setScheduleRecurrence(
                      e.target.value as 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly',
                    )
                  }
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
                >
                  <option value="none">Não repetir</option>
                  <option value="daily">Diário</option>
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensal</option>
                  <option value="yearly">Anual</option>
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Depois de cada envio bem-sucedido, a mesma mensagem volta para a fila na próxima
                  data (só agendamentos deste chat, não etapas de campanha).
                </p>
              </label>

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <p className="mb-1 text-xs font-semibold text-zinc-700">Conteúdo</p>
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-800">
                  {draft.trim() ? draft.trim() : (
                    <span className="italic text-zinc-400">
                      (Sem texto — anexe um arquivo ou digite no chat antes de agendar)
                    </span>
                  )}
                </p>
              </div>

              <div>
                <input
                  ref={scheduleAttachmentInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0] ?? null
                    e.currentTarget.value = ''
                    setScheduleAttachment(f)
                  }}
                />
                {scheduleAttachment ? (
                  <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-brand-800">
                        {scheduleAttachment.name}
                      </p>
                      <p className="text-[11px] text-brand-700/80">
                        {(scheduleAttachment.size / 1024).toFixed(1)} KB · {scheduleAttachment.type || 'arquivo'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setScheduleAttachment(null)}
                      className="rounded-lg p-1.5 text-brand-700 hover:bg-brand-100"
                      aria-label="Remover anexo"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => scheduleAttachmentInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Anexar arquivo (opcional)
                  </button>
                )}
              </div>

              {scheduleError ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {scheduleError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
              <button
                type="button"
                onClick={fecharModalAgendamento}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void programarEnvio()}
                disabled={submittingSchedule}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:from-brand-500 hover:to-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submittingSchedule ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CalendarClock className="h-4 w-4" />
                )}
                Programar Envio
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {futureModalOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 backdrop-blur-[2px] px-4">
          <div
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="futuras-titulo"
            style={{ maxHeight: '85vh' }}
          >
            <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600/10 text-brand-700">
                <CalendarClock className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <h3 id="futuras-titulo" className="text-sm font-semibold text-zinc-900">
                  Conversas futuras
                </h3>
                <p className="text-xs text-zinc-500">
                  Mensagens agendadas para {lead?.name ?? 'este lead'}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFutureModalOpen(false)}
                className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                aria-label="Fechar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {loadingFuture ? (
                <p className="text-center text-sm text-zinc-500">Carregando agendamentos…</p>
              ) : null}
              {futureError ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {futureError}
                </p>
              ) : null}
              {!loadingFuture && !futureError && futureMessages.length === 0 ? (
                <p className="text-center text-sm text-zinc-500">
                  Nenhuma mensagem agendada para este lead ainda.
                </p>
              ) : null}

              <ul className="space-y-2">
                {futureMessages.map((m) => {
                  const quando = m.scheduled_at
                    ? new Date(m.scheduled_at).toLocaleString(undefined, {
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'
                  const resumo = m.message_body?.trim()
                    ? m.message_body.trim()
                    : m.media_url
                      ? `Anexo (${m.content_type})`
                      : `(${m.content_type})`
                  const statusLabel =
                    m.status === 'sent'
                      ? 'Enviado'
                      : m.status === 'error' || m.status === 'failed'
                        ? 'Erro'
                        : m.status === 'cancelled'
                          ? 'Cancelado'
                          : m.status === 'processing'
                            ? 'Processando'
                            : 'Pendente'
                  const statusClass =
                    m.status === 'sent'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                      : m.status === 'error' || m.status === 'failed'
                        ? 'bg-rose-50 text-rose-700 ring-rose-200'
                        : m.status === 'cancelled'
                          ? 'bg-zinc-100 text-zinc-600 ring-zinc-200'
                          : m.status === 'processing'
                            ? 'bg-amber-50 text-amber-700 ring-amber-200'
                            : 'bg-brand-50 text-brand-700 ring-brand-200'
                  const recRaw = (m.recurrence ?? 'none').trim().toLowerCase()
                  const recurrenceLabel =
                    recRaw === 'daily'
                      ? 'Diário'
                      : recRaw === 'weekly'
                        ? 'Semanal'
                        : recRaw === 'monthly'
                          ? 'Mensal'
                          : recRaw === 'yearly'
                            ? 'Anual'
                            : null
                  return (
                    <li
                      key={m.id}
                      className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-zinc-800 tabular-nums">
                            {quando}
                          </span>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${statusClass}`}
                          >
                            {statusLabel}
                          </span>
                          {recurrenceLabel ? (
                            <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800 ring-1 ring-violet-200">
                              Recorrente · {recurrenceLabel}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-zinc-700">
                          {resumo}
                        </p>
                        {m.media_url ? (
                          <a
                            href={m.media_url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:underline"
                          >
                            <Paperclip className="h-3 w-3" />
                            Ver anexo
                          </a>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void excluirAgendamento(m.id)}
                        disabled={deletingFutureId === m.id}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        title="Excluir agendamento"
                        aria-label="Excluir agendamento"
                      >
                        {deletingFutureId === m.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setFutureModalOpen(false)}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
