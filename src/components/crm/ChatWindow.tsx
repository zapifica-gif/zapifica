import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FileText, Loader2, MessageSquare, Paperclip, Send, TriangleAlert, X } from 'lucide-react'
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
  const [pendingMedia, setPendingMedia] = useState<
    Record<string, 'sending' | 'failed'>
  >({})
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  async function handlePickFile(file: File) {
    if (!lead) return
    setSendError(null)

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setSendError('Sessão inválida. Entre novamente.')
      return
    }

    const { evolution, contentType } = mapFileToMediaType(file)

    // 1) Upload no bucket público (para já aparecer no CRM instantaneamente)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const msgId = crypto.randomUUID()
    const path = `${user.id}/${lead.id}/${msgId}_${safeName}`

    const { error: upErr } = await supabase.storage
      .from('chat_media')
      .upload(path, file, { upsert: true, contentType: file.type || undefined })
    if (upErr) {
      setSendError(`Falha ao subir arquivo no Storage: ${upErr.message}`)
      return
    }

    const { data: pub } = supabase.storage.from('chat_media').getPublicUrl(path)
    const publicUrl = pub.publicUrl

    // 2) Grava no banco imediatamente (optimistic persist)
    const caption = draft.trim()
    setDraft('')

    // 2.5) Base64 para o disparo na Evolution (algumas versões falham com URL)
    let base64Pure: string
    try {
      base64Pure = await fileToBase64Pure(file)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSendError(`Falha ao converter arquivo para Base64: ${msg}`)
      return
    }

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
                : file.name),
        media_url: publicUrl,
        evolution_message_id: null,
      })
      .select('id')
      .single()

    if (insErr || !inserted?.id) {
      setSendError(`Falha ao salvar mensagem no banco: ${insErr?.message ?? 'sem id'}`)
      return
    }

    const rowId = inserted.id as string
    setPendingMedia((prev) => ({ ...prev, [rowId]: 'sending' }))

    // 3) Dispara envio na Evolution usando BASE64 puro + legenda (caption)
    const evo = await sendMediaMessage(user.id, lead.phone, {
      media: base64Pure,
      mediaType: evolution,
      mimeType: file.type || 'application/octet-stream',
      fileName: file.name || safeName,
      caption,
    })

    if (!evo.ok) {
      setPendingMedia((prev) => ({ ...prev, [rowId]: 'failed' }))
      setSendError(evo.error ?? 'Falha ao enviar mídia pelo WhatsApp.')
      return
    }

    // 4) Marca como enviada (salva o messageId da Evolution)
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
        </footer>
      </aside>
    </>
  )
}
