import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Calendar,
  Clock,
  FileText,
  Image as ImageIcon,
  Megaphone,
  MessageSquare,
  Mic,
  User,
  Users,
  Video,
  X,
} from 'lucide-react'
import { toEvolutionDigits } from '../../lib/phoneBrazil'
import { supabase } from '../../lib/supabase'
import { instanceNameFromUserId } from '../../services/evolution'

type LeadOption = { id: string; name: string; phone: string }

type NewEventModalProps = {
  open: boolean
  onClose: () => void
  /** Data base (meia-noite local) sugerida ao abrir a partir da grade */
  initialDate: Date
  /** Hora inicial sugerida (0–23) ao clicar na grade */
  initialHour: number
  /** Texto do chip “Enviar para …” (pode ser formatado a partir do raw). */
  personalPhoneDisplay: string
  /**
   * Telefone do lembrete pessoal (como na Evolution: dígitos ou E.164).
   * Gravado em `scheduled_messages.recipient_phone` para o worker não depender de auth.
   */
  personalPhoneRaw: string | null
  /** Atualiza o pai quando o usuário cadastra/muda o número pessoal pelo modal. */
  onPersonalPhoneChange?: (raw: string | null) => void
  /** Recarrega a agenda no pai; pode ser async para aguardar o fetch antes de fechar o modal. */
  onSaved: () => void | Promise<void>
}

const CATEGORIAS: { value: string; label: string }[] = [
  { value: 'reuniao', label: 'Reunião' },
  { value: 'ligacao', label: 'Ligação' },
  { value: 'visita', label: 'Visita' },
  { value: 'suporte', label: 'Suporte' },
  { value: 'outro', label: 'Outro' },
]

const MEDIA_BUCKET = 'chat_media'

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function toTimeInputValue(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Interpreta data/hora no fuso local do navegador (componentes nativos). */
/** Mensagem legível a partir do objeto `error` do PostgREST / exceções. */
function textoErroParaUsuario(err: unknown): string {
  if (err == null) return 'Erro desconhecido (null/undefined).'
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    const parts = [o.message, o.details, o.hint, o.code]
      .map((v) => (typeof v === 'string' ? v : v != null ? String(v) : ''))
      .filter(Boolean)
    if (parts.length) return parts.join(' | ')
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

function parseLocalDateTime(dateStr: string, timeStr: string): Date | null {
  const [y, m, day] = dateStr.split('-').map(Number)
  const parts = timeStr.split(':').map(Number)
  const hh = parts[0]
  const mm = parts[1] ?? 0
  const ss = parts[2] ?? 0
  if (!y || !m || !day || Number.isNaN(hh) || Number.isNaN(mm)) return null
  return new Date(y, m - 1, day, hh, mm, ss, 0)
}

export function NewEventModal({
  open,
  onClose,
  initialDate,
  initialHour,
  personalPhoneDisplay,
  personalPhoneRaw,
  onPersonalPhoneChange,
  onSaved,
}: NewEventModalProps) {
  const [manualPersonalPhone, setManualPersonalPhone] = useState('')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('reuniao')
  const [clientId, setClientId] = useState<string>('')
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('09:00')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('10:00')
  const [syncKanban, setSyncKanban] = useState(false)

  const [dispatchActive, setDispatchActive] = useState(false)
  const [recipientType, setRecipientType] = useState<'personal' | 'segment'>(
    'personal',
  )
  const [contentType, setContentType] = useState<
    'text' | 'audio' | 'image' | 'video' | 'document'
  >(
    'text',
  )
  const [messageBody, setMessageBody] = useState(
    'Olá! Lembrete da Zapifica…',
  )
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [dispatchDate, setDispatchDate] = useState('')
  const [dispatchTime, setDispatchTime] = useState('09:00')

  const [leads, setLeads] = useState<LeadOption[]>([])
  const [segmentIds, setSegmentIds] = useState<Set<string>>(new Set())

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reinicializarCamposDoModal = useCallback(() => {
    const base = new Date(initialDate)
    const start = new Date(base)
    start.setHours(initialHour, 0, 0, 0)
    const end = new Date(start)
    end.setHours(start.getHours() + 1)

    setStartDate(toDateInputValue(start))
    setStartTime(toTimeInputValue(start))
    setEndDate(toDateInputValue(end))
    setEndTime(toTimeInputValue(end))
    setDispatchDate(toDateInputValue(start))
    setDispatchTime(toTimeInputValue(start))
    setTitle('')
    setCategory('reuniao')
    setClientId('')
    setSyncKanban(false)
    setDispatchActive(false)
    setRecipientType('personal')
    setContentType('text')
    setMessageBody('Olá! Lembrete da Zapifica…')
    setMediaFile(null)
    setSegmentIds(new Set())
    setManualPersonalPhone('')
    setError(null)
  }, [initialDate, initialHour])

  useEffect(() => {
    if (!open) return
    reinicializarCamposDoModal()

    void (async () => {
      const { data } = await supabase
        .from('leads')
        .select('id, name, phone')
        .order('name', { ascending: true })
      setLeads((data ?? []) as LeadOption[])
    })()
  }, [open, initialDate, initialHour, reinicializarCamposDoModal])

  if (!open) return null

  function toggleSegment(id: string) {
    setSegmentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllSegment() {
    const withPhone = leads.filter((l) => l.phone?.trim())
    setSegmentIds(new Set(withPhone.map((l) => l.id)))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // Guarda anti-duplo-submit no topo: se já há um submit em voo,
    // descarta o clique atual antes mesmo de validar ou bater no Supabase.
    if (submitting) return
    setSubmitting(true)
    setError(null)

    try {
      const t = title.trim()
      if (!t) {
        setError('Informe o título do evento.')
        return
      }
      const start = parseLocalDateTime(startDate, startTime)
      const end = parseLocalDateTime(endDate, endTime)
      if (!start || !end) {
        setError('Datas e horários inválidos.')
        return
      }
      if (end <= start) {
        setError('O término deve ser depois do início.')
        return
      }

      // Resolve o telefone pessoal: primeiro o já cadastrado; se faltar,
      // usa o que foi digitado no próprio modal (e persiste em profiles).
      const telefonePessoalEvolution =
        toEvolutionDigits(personalPhoneRaw) ??
        toEvolutionDigits(manualPersonalPhone)

      let dispatchAt: Date | null = null
      if (dispatchActive) {
        dispatchAt = parseLocalDateTime(dispatchDate, dispatchTime)
        if (!dispatchAt) {
          setError('Preencha a data e o horário do disparo.')
          return
        }
        if (contentType === 'text' && !messageBody.trim()) {
          setError('Escreva a mensagem do lembrete ou desative o disparo.')
          return
        }
        if (contentType !== 'text' && !mediaFile) {
          setError('Selecione um arquivo para o tipo de mídia escolhido.')
          return
        }
        if (recipientType === 'segment' && segmentIds.size === 0) {
          setError('Selecione ao menos um cliente com telefone no segmento.')
          return
        }
        if (recipientType === 'personal' && !telefonePessoalEvolution) {
          setError(
            'Informe seu número com DDD (ex.: 48 99999-9999). O 55 do Brasil é anexado automaticamente.',
          )
          return
        }
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()
      if (userError || !user) {
        setError('Sessão inválida. Entre novamente.')
        return
      }

      const ownerId = user.id
      const startAtUtc = start.toISOString()
      const endAtUtc = end.toISOString()

      // Se o usuário digitou o número no modal e ainda não havia um salvo,
      // persistimos em `profiles` (upsert por id) para que o próximo evento
      // já ache o telefone sem precisar redigitar.
      if (
        dispatchActive &&
        recipientType === 'personal' &&
        telefonePessoalEvolution &&
        !personalPhoneRaw?.trim() &&
        manualPersonalPhone.trim()
      ) {
        const { error: profErr } = await supabase
          .from('profiles')
          .upsert(
            { id: ownerId, whatsapp: telefonePessoalEvolution },
            { onConflict: 'id' },
          )
        if (profErr) {
          console.warn(
            '[Agenda] não foi possível persistir profiles.whatsapp:',
            profErr.message,
          )
        } else {
          onPersonalPhoneChange?.(telefonePessoalEvolution)
        }
      }

      // UUID gerado no cliente + upsert → fluxo idempotente.
      // Se houver retry, clique duplo ou falha na etapa 2, reenviamos a
      // mesma linha sem colidir com `events_pkey` (23505).
      const eventoId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`

      const eventoRow = {
        id: eventoId,
        user_id: ownerId,
        title: t,
        category,
        client_id: clientId || null,
        start_at: startAtUtc,
        end_at: endAtUtc,
        sync_kanban: syncKanban,
      }

      console.log(
        '[Agenda] Passo 1 — upsert events | id:',
        eventoId,
        '| user_id:',
        ownerId,
      )

      const { data: eventoCriado, error: evErr } = await supabase
        .from('events')
        .upsert(eventoRow, { onConflict: 'id' })
        .select('id, user_id')
        .single()

      if (evErr) {
        const det = textoErroParaUsuario(evErr)
        setError(
          det.includes('relation') || det.includes('does not exist')
            ? 'Tabelas da agenda ainda não criadas. Execute a migração no Supabase.'
            : `Passo 1 (events): ${det}`,
        )
        return
      }

      if (!eventoCriado?.id) {
        setError(
          'Passo 1 (events): upsert pareceu ok, mas nenhuma linha foi retornada no select. Verifique políticas RLS de SELECT em `events`.',
        )
        return
      }

      /**
       * Passo 2: uma linha em `scheduled_messages` ligada ao `event_id`.
       *
       * Usamos upsert com onConflict: 'event_id' para o fluxo ser idempotente
       * também aqui — assim um retry após falha de rede não duplica disparos
       * (requer índice único em event_id; criado na migração).
       */
      const lembreteEvolutionLigado = Boolean(dispatchActive && dispatchAt)
      const scheduledAtUtcIso = lembreteEvolutionLigado
        ? dispatchAt!.toISOString()
        : null

      const recipientPhoneRow =
        lembreteEvolutionLigado && recipientType === 'personal'
          ? telefonePessoalEvolution
          : null

      // Mesma convenção do Zap Voice: a instância da Evolution por usuário é
      // `zapifica_<user_id>`. O 'ZapAgencia' antigo gerava 404 Not Found.
      const instanceName = instanceNameFromUserId(ownerId)

      const mensagemAgendadaRow = lembreteEvolutionLigado
        ? {
            event_id: eventoCriado.id,
            user_id: ownerId,
            is_active: true,
            recipient_type: recipientType,
            content_type: contentType,
            message_body: messageBody.trim() || null,
            media_url: null as string | null,
            scheduled_at: scheduledAtUtcIso,
            status: 'pending' as const,
            segment_lead_ids:
              recipientType === 'segment' ? [...segmentIds] : [],
            recipient_phone: recipientPhoneRow,
            evolution_instance_name: instanceName,
            last_error: null,
            evolution_message_id: null,
          }
        : {
            event_id: eventoCriado.id,
            user_id: ownerId,
            is_active: false,
            recipient_type: 'personal' as const,
            content_type: 'text' as const,
            message_body: null,
            media_url: null as string | null,
            scheduled_at: null,
            status: 'cancelled' as const,
            segment_lead_ids: [] as string[],
            recipient_phone: null,
            evolution_instance_name: null,
            last_error: null,
            evolution_message_id: null,
          }

      if (lembreteEvolutionLigado && mediaFile && contentType !== 'text') {
        const safe = mediaFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${ownerId}/agenda_${eventoCriado.id}_${crypto.randomUUID()}_${safe}`
        const { error: upErr } = await supabase.storage
          .from(MEDIA_BUCKET)
          .upload(path, mediaFile, {
            upsert: true,
            contentType: mediaFile.type || undefined,
          })
        if (upErr) {
          await supabase.from('events').delete().eq('id', eventoCriado.id)
          setError(`Falha no upload da mídia: ${upErr.message}`)
          return
        }
        const { data: pub } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path)
        ;(mensagemAgendadaRow as { media_url: string | null }).media_url = pub.publicUrl
      }

      // BUGFIX 42P10: índice único em event_id é parcial; não usar upsert(onConflict:event_id).
      const { error: delErr } = await supabase
        .from('scheduled_messages')
        .delete()
        .eq('event_id', eventoCriado.id)
        .eq('user_id', ownerId)
      if (delErr) {
        await supabase.from('events').delete().eq('id', eventoCriado.id)
        setError(`Passo 2 (scheduled_messages): ${textoErroParaUsuario(delErr)}`)
        return
      }

      const { error: erroMsg } = await supabase
        .from('scheduled_messages')
        .insert(mensagemAgendadaRow)
        .select('id')

      if (erroMsg) {
        // Rollback best-effort do events antes de devolver o controle.
        // Mesmo que isso falhe, o próximo Salvar gera um novo UUID e não colide.
        await supabase.from('events').delete().eq('id', eventoCriado.id)
        setError(
          `Passo 2 (scheduled_messages): ${textoErroParaUsuario(erroMsg)}`,
        )
        return
      }

      await Promise.resolve(onSaved())
      reinicializarCamposDoModal()
      onClose()
    } catch (err) {
      console.error('[Agenda] erro fatal no salvamento do modal:', err)
      setError(`Erro ao agendar lembrete: ${textoErroParaUsuario(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    if (submitting) return
    onClose()
  }

  const leadsWithPhone = leads.filter((l) => l.phone?.trim())

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-event-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Fechar modal"
        onClick={handleClose}
      />

      <div className="relative max-h-[min(92dvh,920px)] w-full max-w-2xl overflow-y-auto rounded-[32px] border border-zinc-200/90 bg-white p-8 shadow-2xl shadow-zinc-900/15 ring-1 ring-zinc-100">
        <div className="flex items-start justify-between gap-4">
          <h2
            id="new-event-title"
            className="text-xl font-semibold tracking-tight text-zinc-900"
          >
            Novo Evento na Agenda
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="rounded-xl p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {error}
          </div>
        ) : null}

        <form className="mt-6 space-y-6" onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="evt-title"
              className="mb-1.5 block text-sm font-semibold text-zinc-700"
            >
              Título do Evento
            </label>
            <input
              id="evt-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              placeholder="Ex: Reunião de Alinhamento"
              className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="evt-cat"
                className="mb-1.5 block text-sm font-semibold text-zinc-700"
              >
                Categoria
              </label>
              <div className="relative">
                <select
                  id="evt-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full appearance-none rounded-xl border border-zinc-200 bg-zinc-50 px-4 pr-10 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                >
                  {CATEGORIAS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400">
                  ▾
                </span>
              </div>
            </div>
            <div>
              <label
                htmlFor="evt-client"
                className="mb-1.5 block text-sm font-semibold text-zinc-700"
              >
                Cliente vinculado (calendário)
              </label>
              <div className="relative">
                <select
                  id="evt-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full appearance-none rounded-xl border border-zinc-200 bg-zinc-50 px-4 pr-10 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                >
                  <option value="">Nenhum</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400">
                  ▾
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-sm font-semibold text-zinc-700">
                Data de Início
              </p>
              <div className="relative">
                <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                />
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-semibold text-zinc-700">
                Horário
              </p>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                />
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-semibold text-zinc-700">
                Data de Término
              </p>
              <div className="relative">
                <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                />
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-semibold text-zinc-700">
                Horário Fim
              </p>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={submitting}
                  className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                />
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-emerald-200/80 bg-emerald-50/60 ring-1 ring-emerald-100/80">
            <div className="flex items-center gap-2 border-b border-emerald-200/60 px-4 py-3">
              <Megaphone className="h-5 w-5 text-[var(--color-brand-green)]" />
              <span className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                Lembrete via WhatsApp
              </span>
            </div>
            <div className="space-y-4 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={dispatchActive}
                  onChange={(e) => setDispatchActive(e.target.checked)}
                  disabled={submitting}
                  className="mt-1 h-5 w-5 rounded border-emerald-300 text-[var(--color-brand-green)] focus:ring-[var(--color-brand-green)]"
                />
                <span className="text-sm font-semibold leading-snug text-emerald-900">
                  Ativar disparo agendado (Evolution API)
                </span>
              </label>

              {dispatchActive ? (
                <div className="space-y-5 border-t border-emerald-200/50 pt-4">
                  <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-800">
                      Destinatários
                    </p>
                    <div className="grid gap-3 sm:grid-cols-1">
                      <label
                        className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition ${
                          recipientType === 'personal'
                            ? 'border-emerald-300 bg-emerald-50/90 ring-2 ring-[var(--color-brand-green)]/25'
                            : 'border-zinc-200 bg-white hover:border-zinc-300'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="radio"
                            name="recip"
                            checked={recipientType === 'personal'}
                            onChange={() => setRecipientType('personal')}
                            className="mt-1 text-[var(--color-brand-green)] focus:ring-[var(--color-brand-green)]"
                          />
                          <User className="mt-0.5 h-5 w-5 text-zinc-500" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-zinc-900">
                              Meu número (lembrete pessoal)
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                              Usa o número cadastrado no seu perfil. O 55 do
                              Brasil é anexado automaticamente.
                            </p>
                            {personalPhoneRaw?.trim() ? (
                              <p className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium tabular-nums text-zinc-700">
                                Enviar para {personalPhoneDisplay}
                              </p>
                            ) : (
                              <div className="mt-3 space-y-1">
                                <label
                                  htmlFor="evt-personal-phone"
                                  className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500"
                                >
                                  Seu WhatsApp (DDD + número)
                                </label>
                                <input
                                  id="evt-personal-phone"
                                  type="tel"
                                  inputMode="tel"
                                  autoComplete="tel"
                                  value={manualPersonalPhone}
                                  onChange={(e) =>
                                    setManualPersonalPhone(e.target.value)
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  disabled={submitting}
                                  placeholder="(48) 99999-9999"
                                  className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm tabular-nums text-zinc-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 disabled:opacity-60"
                                />
                                <p className="text-[10px] leading-snug text-zinc-500">
                                  Salvamos este número no seu perfil para não
                                  precisar redigitar no próximo evento.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </label>

                      <label
                        className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition ${
                          recipientType === 'segment'
                            ? 'border-emerald-300 bg-emerald-50/90 ring-2 ring-[var(--color-brand-green)]/25'
                            : 'border-zinc-200 bg-white hover:border-zinc-300'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="radio"
                            name="recip"
                            checked={recipientType === 'segment'}
                            onChange={() => setRecipientType('segment')}
                            className="mt-1 text-[var(--color-brand-green)] focus:ring-[var(--color-brand-green)]"
                          />
                          <Users className="mt-0.5 h-5 w-5 text-zinc-500" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-zinc-900">
                              Segmento de clientes
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                              Marque um ou vários clientes, ou use &quot;Selecionar
                              todos&quot; (apenas quem tem telefone válido).
                            </p>
                          </div>
                        </div>
                      </label>
                    </div>

                    {recipientType === 'segment' ? (
                      <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-zinc-600">
                            {segmentIds.size} selecionado(s)
                          </span>
                          <button
                            type="button"
                            onClick={selectAllSegment}
                            disabled={submitting || leadsWithPhone.length === 0}
                            className="text-xs font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-40"
                          >
                            Selecionar todos
                          </button>
                        </div>
                        <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
                          {leadsWithPhone.map((l) => (
                            <li key={l.id}>
                              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white">
                                <input
                                  type="checkbox"
                                  checked={segmentIds.has(l.id)}
                                  onChange={() => toggleSegment(l.id)}
                                  className="rounded border-zinc-300 text-brand-600 focus:ring-brand-600/30"
                                />
                                <span className="truncate text-zinc-800">
                                  {l.name}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        {leadsWithPhone.length === 0 ? (
                          <p className="text-xs text-zinc-500">
                            Nenhum lead com telefone no CRM.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-800">
                      Tipo de conteúdo
                    </p>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                      {(
                        [
                          {
                            id: 'text' as const,
                            label: 'Texto',
                            icon: MessageSquare,
                          },
                          { id: 'audio' as const, label: 'Áudio', icon: Mic },
                          {
                            id: 'image' as const,
                            label: 'Imagem',
                            icon: ImageIcon,
                          },
                          {
                            id: 'video' as const,
                            label: 'Vídeo',
                            icon: Video,
                          },
                          {
                            id: 'document' as const,
                            label: 'Documento',
                            icon: FileText,
                          },
                        ] as const
                      ).map(({ id, label, icon: Icon }) => {
                        const on = contentType === id
                        return (
                          <button
                            key={id}
                            type="button"
                            disabled={submitting}
                            onClick={() => {
                              setContentType(id)
                              if (id === 'text') setMediaFile(null)
                            }}
                            className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-semibold transition ${
                              on
                                ? 'border-[var(--color-brand-green)] bg-emerald-50 text-emerald-900'
                                : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'
                            }`}
                          >
                            <Icon className="h-5 w-5" />
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {contentType !== 'text' ? (
                    <div>
                      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-800">
                        Arquivo de mídia
                      </p>
                      <input
                        type="file"
                        disabled={submitting}
                        accept={
                          contentType === 'audio'
                            ? 'audio/*'
                            : contentType === 'image'
                              ? 'image/*'
                              : contentType === 'video'
                                ? 'video/*'
                                : '*/*'
                        }
                        onChange={(e) => setMediaFile(e.target.files?.[0] ?? null)}
                        className="block w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                      />
                      {mediaFile ? (
                        <p className="mt-2 text-xs text-zinc-600">
                          Selecionado: <span className="font-semibold">{mediaFile.name}</span>
                        </p>
                      ) : (
                        <p className="mt-2 text-xs text-zinc-500">
                          Selecione um arquivo para anexar ao lembrete.
                        </p>
                      )}
                    </div>
                  ) : null}

                  <div>
                    <label
                      htmlFor="evt-msg"
                      className="mb-1.5 block text-sm font-semibold text-zinc-700"
                    >
                      Mensagem
                    </label>
                    <textarea
                      id="evt-msg"
                      rows={4}
                      value={messageBody}
                      onChange={(e) => setMessageBody(e.target.value)}
                      disabled={submitting}
                      placeholder="Olá! Lembrete da Zapifica…"
                      className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                    />
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-800">
                      Momento do disparo
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor="evt-dispatch-date"
                          className="mb-1.5 block text-sm font-semibold text-zinc-700"
                        >
                          Data do disparo
                        </label>
                        <div className="relative">
                          <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                          <input
                            id="evt-dispatch-date"
                            type="date"
                            value={dispatchDate}
                            onChange={(e) => setDispatchDate(e.target.value)}
                            disabled={submitting}
                            className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                          />
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="evt-dispatch-time"
                          className="mb-1.5 block text-sm font-semibold text-zinc-700"
                        >
                          Horário do disparo
                        </label>
                        <div className="relative">
                          <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                          <input
                            id="evt-dispatch-time"
                            type="time"
                            value={dispatchTime}
                            onChange={(e) => setDispatchTime(e.target.value)}
                            disabled={submitting}
                            className="h-12 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-600/15 disabled:opacity-60"
                          />
                        </div>
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                      Data e hora no seu fuso local; o Zapifica grava em UTC no
                      Supabase para bater com o worker (Evolution API).
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-zinc-900">
              Integrações automáticas
            </p>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4">
              <input
                type="checkbox"
                checked={syncKanban}
                onChange={(e) => setSyncKanban(e.target.checked)}
                disabled={submitting}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-600/30"
              />
              <div>
                <span className="text-sm font-semibold text-zinc-800">
                  Sincronizar com Kanban
                </span>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Cria automaticamente um card de produção para este evento.
                </p>
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-xl border border-zinc-200 bg-white px-5 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-[0_8px_24px_rgba(106,0,184,0.35)] transition hover:from-brand-500 hover:to-brand-600 disabled:opacity-60"
            >
              {submitting ? 'Salvando…' : 'Salvar evento'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}