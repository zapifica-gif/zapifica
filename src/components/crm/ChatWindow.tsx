import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FileText, MessageSquare, Send, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { sendTextMessage } from '../../services/evolution'
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

function shouldShowText(message: ChatMessageRow): boolean {
  const body = message.message_body?.trim()
  if (!body) return false
  if (!message.media_url) return true
  return !['[imagem]', '[áudio]', '[documento]', '[vídeo]'].includes(body)
}

function MessageMedia({ message }: { message: ChatMessageRow }) {
  if (!message.media_url) return null

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
          alt={message.message_body?.trim() || 'Imagem recebida no WhatsApp'}
          className="max-h-80 w-full object-cover"
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
            {message.message_body?.trim() || 'Arquivo recebido'}
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
  const listRef = useRef<HTMLDivElement | null>(null)

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
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                  {senderLabel(m.sender_type)} ·{' '}
                  {contentLabel(m.content_type)}
                </p>
                <div
                  className={`space-y-2 whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${bubbleStyle(m.sender_type)}`}
                >
                  <MessageMedia message={m} />
                  {shouldShowText(m) ? <p>{m.message_body}</p> : null}
                  {!m.media_url && !shouldShowText(m) ? <p>—</p> : null}
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
