import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Bot, GripVertical, Pencil, Phone, Users } from 'lucide-react'
import { toEvolutionDigits } from '../../lib/phoneBrazil'
import { supabase } from '../../lib/supabase'
import { ChatWindow } from './ChatWindow'
import { NewLeadModal } from './NewLeadModal'
import { useImpersonation } from '../../contexts/ImpersonationContext'

/** Alinhado ao enum/texto do campo `status` em `public.leads`. */
export type ColumnId = 'novo' | 'em_atendimento' | 'negociacao' | 'fechado'

export type LeadTemperature = 'frio' | 'morno' | 'quente'

export type Lead = {
  id: string
  name: string
  phone: string
  temperature: LeadTemperature
  profilePictureUrl: string | null
  isGroup: boolean
  lastActivityIso: string | null
  /** ISO de `ai_paused_until`; se ainda no futuro, IA não responde (atendimento manual). */
  aiPausedUntilIso: string | null
}

type LeadRow = {
  id: string
  name: string
  phone: string
  status: string
  profile_picture_url: string | null
  is_group: boolean
  last_message_at: string | null
  updated_at: string
  ai_paused_until: string | null
}

const COLUMN_ORDER: ColumnId[] = [
  'novo',
  'em_atendimento',
  'negociacao',
  'fechado',
]

const COLUMN_TITLES: Record<ColumnId, string> = {
  novo: 'Novo Lead',
  em_atendimento: 'Em Atendimento',
  negociacao: 'Negociação',
  fechado: 'Fechado',
}

function emptyColumns(): Record<ColumnId, string[]> {
  return {
    novo: [],
    em_atendimento: [],
    negociacao: [],
    fechado: [],
  }
}

function isColumnId(v: string): v is ColumnId {
  return COLUMN_ORDER.includes(v as ColumnId)
}

/**
 * A tabela atual não possui coluna de temperatura; o cartão exibe "Frio" por padrão
 * (evolução futura pode reintroduzir o dado vindo do banco).
 */
function rowToLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name?.trim() || 'Sem nome',
    phone: row.phone ?? '',
    temperature: 'frio',
    profilePictureUrl: row.profile_picture_url ?? null,
    isGroup: Boolean(row.is_group),
    lastActivityIso: row.last_message_at ?? row.updated_at ?? null,
    aiPausedUntilIso: row.ai_paused_until ?? null,
  }
}

/** Indica janela de pausa da IA definida pelo webhook (mensagem fromMe). */
function isLeadAiPaused(aiPausedUntilIso: string | null | undefined): boolean {
  if (!aiPausedUntilIso) return false
  const t = Date.parse(aiPausedUntilIso)
  return !Number.isNaN(t) && Date.now() < t
}

function avatarHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h)
  return Math.abs(h) % 360
}

/** Texto curto tipo “há 2 min”, “há 3 dias” (baseado na última atividade registrada). */
function tempoRelativoCurto(iso: string | null): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const diffMs = Math.max(0, Date.now() - t)
  const sec = Math.floor(diffMs / 1000)
  if (sec < 45) return 'agora'
  const min = Math.floor(sec / 60)
  if (min < 60) return min <= 1 ? 'há 1 min' : `há ${min} min`
  const horas = Math.floor(min / 60)
  if (horas < 24) return horas === 1 ? 'há 1 h' : `há ${horas} h`
  const dias = Math.floor(horas / 24)
  if (dias < 7) return dias === 1 ? 'há 1 dia' : `há ${dias} dias`
  const semanas = Math.floor(dias / 7)
  if (dias < 60) return semanas <= 1 ? 'há 1 semana' : `há ${semanas} semanas`
  const meses = Math.floor(dias / 30)
  if (dias < 365) return meses <= 1 ? 'há 1 mês' : `há ${meses} meses`
  const anos = Math.floor(dias / 365)
  return anos === 1 ? 'há 1 ano' : `há ${anos} anos`
}

function LeadKanbanAvatar({ lead }: { lead: Lead }) {
  const [imgBroken, setImgBroken] = useState(false)
  const alt = `${lead.name} — avatar`
  const initial =
    ((lead.name || '?').trim().charAt(0) || '?').toUpperCase()
  const hue = avatarHue(lead.name || lead.id)

  if (lead.profilePictureUrl && !imgBroken) {
    return (
      <img
        src={lead.profilePictureUrl}
        alt={alt}
        className="h-10 w-10 shrink-0 rounded-full bg-zinc-100 object-cover shadow-inner ring-1 ring-zinc-200/90"
        onError={() => setImgBroken(true)}
      />
    )
  }

  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-inner ring-1 ring-black/10"
      style={{ backgroundColor: `hsl(${hue} 54% 46%)` }}
      aria-hidden
    >
      {initial}
    </div>
  )
}

/** Converte `status` do PostgREST para a coluna do board (inclui legado `atendimento`). */
function statusToColumnId(status: string | null | undefined): ColumnId {
  const s = (status ?? '').trim()
  if (s === 'atendimento') return 'em_atendimento'
  if (isColumnId(s)) return s
  return 'novo'
}

/** Alinha à ordenação da RPC: last_message_at recente primeiro, depois updated_at. */
function leadSortTimestampMs(row: LeadRow): number {
  const last = row.last_message_at
    ? Date.parse(row.last_message_at)
    : Number.NaN
  if (!Number.isNaN(last)) return last
  const upd = row.updated_at ? Date.parse(row.updated_at) : 0
  return Number.isNaN(upd) ? 0 : upd
}

/** Uma linha por `id` na RPC (mantém o snapshot mais recente). */
function dedupeLeadRowsPreferNewest(rows: LeadRow[]): LeadRow[] {
  const map = new Map<string, LeadRow>()
  for (const row of rows) {
    if (!row.id) continue
    const prev = map.get(row.id)
    if (!prev || leadSortTimestampMs(row) >= leadSortTimestampMs(prev)) {
      map.set(row.id, row)
    }
  }
  return [...map.values()]
}

/** Lista de ids sem repetição, preservando a ordem da primeira aparição. */
function orderedUniqueStrings(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Garante um único lugar no board por lead (defensivo para flicker / corrida de refetch + DnD).
 * Prioridade: coluna mais avançada no funil.
 */
function resolveLeadColumnDuplicates(
  columns: Record<ColumnId, string[]>,
): Record<ColumnId, string[]> {
  const canonical = new Map<string, ColumnId>()
  for (const col of [...COLUMN_ORDER].reverse()) {
    for (const id of orderedUniqueStrings(columns[col])) {
      if (!canonical.has(id)) canonical.set(id, col)
    }
  }
  const next = emptyColumns()
  for (const col of COLUMN_ORDER) {
    next[col] = orderedUniqueStrings(columns[col]).filter(
      (id) => canonical.get(id) === col,
    )
  }
  return next
}

function groupRowsIntoBoard(rows: LeadRow[]): {
  columns: Record<ColumnId, string[]>
  leadsMap: Record<string, Lead>
} {
  const columns = emptyColumns()
  const leadsMap: Record<string, Lead> = {}
  const sortTs: Record<string, number> = {}

  const uniqRows = dedupeLeadRowsPreferNewest(rows)
  for (const row of uniqRows) {
    if (!row.id) continue
    const lead = rowToLead(row)
    const col = statusToColumnId(row.status)
    leadsMap[lead.id] = lead
    sortTs[lead.id] = leadSortTimestampMs(row)
    columns[col].push(lead.id)
  }

  for (const col of COLUMN_ORDER) {
    columns[col] = orderedUniqueStrings(columns[col])
    columns[col].sort((idA, idB) => {
      const ta = sortTs[idA] ?? 0
      const tb = sortTs[idB] ?? 0
      if (tb !== ta) return tb - ta
      return idA.localeCompare(idB)
    })
  }

  const sanitized = resolveLeadColumnDuplicates(columns)

  return { columns: sanitized, leadsMap }
}

function findContainer(
  items: Record<ColumnId, string[]>,
  id: UniqueIdentifier,
): ColumnId | undefined {
  const s = String(id)
  if (COLUMN_ORDER.includes(s as ColumnId)) {
    return s as ColumnId
  }
  for (const col of COLUMN_ORDER) {
    if (items[col].includes(s)) return col
  }
  return undefined
}

/** Cópia rasa das listas de IDs por coluna (para aplicar resultado final no drop). */
function cloneColumns(base: Record<ColumnId, string[]>): Record<ColumnId, string[]> {
  return {
    novo: [...base.novo],
    em_atendimento: [...base.em_atendimento],
    negociacao: [...base.negociacao],
    fechado: [...base.fechado],
  }
}

/**
 * Calcula estado final após um drop usando o snapshot do início do arraste (`over`
 * deve ser id da coluna ou id de um card). Funciona mesmo se `onDragOver` não
 * tiver rodado ou tiver ficado stale.
 */
function finalizeKanbanDrag(
  base: Record<ColumnId, string[]>,
  leadId: string,
  overId: string,
): { columns: Record<ColumnId, string[]>; endColumn: ColumnId } | null {
  let targetColumn: ColumnId | undefined = isColumnId(overId)
    ? overId
    : findContainer(base, overId)
  if (!targetColumn) return null

  const sourceColumn = findContainer(base, leadId)
  if (!sourceColumn) return null

  const next = cloneColumns(base)

  if (sourceColumn === targetColumn) {
    const items = [...next[targetColumn]]
    const oldIndex = items.indexOf(leadId)
    if (oldIndex < 0) return null

    let newIndex: number
    if (isColumnId(overId)) {
      newIndex = items.length > 0 ? Math.max(items.length - 1, 0) : 0
    } else {
      newIndex = items.indexOf(overId)
      if (newIndex < 0) newIndex = Math.max(items.length - 1, 0)
    }

    if (oldIndex !== newIndex) {
      next[targetColumn] = arrayMove(items, oldIndex, newIndex)
    }
    return { columns: next, endColumn: targetColumn }
  }

  for (const col of COLUMN_ORDER) {
    next[col] = next[col].filter((id) => id !== leadId)
  }

  const destItems = [...next[targetColumn]]
  let insertIndex: number
  if (isColumnId(overId)) {
    insertIndex = destItems.length
  } else {
    insertIndex = destItems.indexOf(overId)
    if (insertIndex < 0) insertIndex = destItems.length
  }
  destItems.splice(insertIndex, 0, leadId)
  next[targetColumn] = destItems
  return { columns: next, endColumn: targetColumn }
}

const kanbanCollisionDetection: CollisionDetection = (args) => {
  const inside = pointerWithin(args)
  if (inside.length) return inside
  return closestCorners(args)
}

function revertLeadToColumn(
  prev: Record<ColumnId, string[]>,
  leadId: string,
  fromCol: ColumnId,
  toCol: ColumnId,
): Record<ColumnId, string[]> {
  const from = [...prev[fromCol]]
  const to = [...prev[toCol]]
  const idx = from.indexOf(leadId)
  if (idx === -1) return prev
  from.splice(idx, 1)
  to.push(leadId)
  return { ...prev, [fromCol]: from, [toCol]: to }
}

const tempStyles: Record<
  LeadTemperature,
  { label: string; className: string }
> = {
  frio: {
    label: 'Frio',
    className:
      'bg-sky-100 text-sky-800 ring-1 ring-sky-200/80 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-800',
  },
  morno: {
    label: 'Morno',
    className:
      'bg-amber-100 text-amber-900 ring-1 ring-amber-200/80 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800',
  },
  quente: {
    label: 'Quente',
    className:
      'bg-rose-100 text-rose-800 ring-1 ring-rose-200/80 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900',
  },
}

function LeadCardFace({
  lead,
  className = '',
}: {
  lead: Lead
  className?: string
}) {
  const temp = tempStyles[lead.temperature]
  const tempo = tempoRelativoCurto(lead.lastActivityIso)
  return (
    <article
      className={`rounded-xl border border-zinc-200/90 bg-white p-4 shadow-sm ring-1 ring-zinc-100/80 transition hover:border-zinc-300 hover:shadow-md ${className}`}
    >
      <div className="flex gap-3 min-w-0">
        <LeadKanbanAvatar lead={lead} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold tracking-tight text-zinc-900">
              {lead.name}
            </h3>
            {lead.isGroup ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800 ring-1 ring-indigo-100"
                title="Conversa em grupo WhatsApp"
              >
                <Users className="h-3 w-3" aria-hidden />
                Grupo
              </span>
            ) : null}
            {isLeadAiPaused(lead.aiPausedUntilIso) ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800 ring-1 ring-violet-200/90 dark:bg-violet-950/35 dark:text-violet-200 dark:ring-violet-800"
                title="IA pausada: você respondeu pelo WhatsApp. Retoma sozinha após ~60 min."
              >
                <Bot className="h-3 w-3" aria-hidden />
                Manual · Zzz
              </span>
            ) : null}
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${temp.className}`}
            >
              {temp.label}
            </span>
          </div>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
            <Phone className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
            <span className="truncate tabular-nums text-zinc-600">{lead.phone}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              WhatsApp
            </span>
          </p>
          {tempo ? (
            <p className="mt-2 text-[11px] font-medium tracking-tight text-zinc-400">
              Última mensagem · {tempo}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-zinc-300">Sem registro de atividade recente</p>
          )}
        </div>
      </div>
    </article>
  )
}

function SortableLeadCard({
  lead,
  onOpenChat,
}: {
  lead: Lead
  onOpenChat: (lead: Lead) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex touch-none gap-0.5 ${isDragging ? 'z-10 opacity-50' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="mt-1 flex h-8 w-7 shrink-0 items-center justify-center self-start rounded-lg border border-transparent text-zinc-400 transition hover:border-zinc-200 hover:bg-zinc-50 hover:text-zinc-600"
        aria-label="Arrastar cartão"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="button"
          tabIndex={0}
          className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          onClick={() => onOpenChat(lead)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpenChat(lead)
            }
          }}
        >
          <LeadCardFace lead={lead} className="!rounded-l-md" />
        </div>
      </div>
    </div>
  )
}

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.5' } },
  }),
}

type DragStartInfo = { leadId: string; column: ColumnId }

export function CrmKanbanBoard() {
  const { state: imp } = useImpersonation()
  const [columns, setColumns] = useState<Record<ColumnId, string[]>>(emptyColumns)
  const [leadsMap, setLeadsMap] = useState<Record<string, Lead>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [chatLead, setChatLead] = useState<Lead | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [columnTitles, setColumnTitles] = useState<Record<ColumnId, string>>(
    () => ({ ...COLUMN_TITLES }),
  )

  const columnsRef = useRef(columns)
  const dragStartRef = useRef<DragStartInfo | null>(null)
  const columnsSnapshotRef = useRef<Record<ColumnId, string[]> | null>(null)
  /** Respostas antigas da RPC são ignoradas quando um refetch mais novo já iniciou ou o componente desmontou. */
  const fetchGenerationRef = useRef(0)
  /** Agrupa rajadas INSERT/UPDATE (leads + chat_messages) em um único refetch estável ao board. */
  const realtimeBoardDebounceRef = useRef<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const activeLead = activeId ? leadsMap[String(activeId)] : null

  useEffect(() => {
    columnsRef.current = columns
  }, [columns])

  const fetchLeads = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background === true
      const gen = ++fetchGenerationRef.current
      const isCurrent = () => gen === fetchGenerationRef.current

      if (!background) {
        setLoading(true)
      }
      if (!background) {
        setLoadError(null)
      }

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()

      if (userError || !user) {
        if (isCurrent() && !background) {
          setLoadError('Sessão inválida. Entre novamente para carregar o CRM.')
          setLoading(false)
        }
        return
      }
      const effectiveUserId = imp.targetUserId ?? user.id

      const { data, error } = await supabase.rpc('crm_leads_with_conversation', {
        p_user_id: effectiveUserId,
      })

      if (error) {
        if (isCurrent() && !background) {
          setLoadError('Não foi possível carregar os leads. Tente de novo.')
          setLoading(false)
        }
        return
      }

      if (!isCurrent()) return

      const rows = (data ?? []) as LeadRow[]
      const { columns: nextCols, leadsMap: nextLeads } = groupRowsIntoBoard(rows)
      columnsRef.current = nextCols
      setColumns(nextCols)
      setLeadsMap(nextLeads)
      if (!background) {
        setLoading(false)
      }
    },
    [imp.targetUserId],
  )

  const scheduleRealtimeBoardRefresh = useCallback(() => {
    if (realtimeBoardDebounceRef.current != null) {
      window.clearTimeout(realtimeBoardDebounceRef.current)
    }
    realtimeBoardDebounceRef.current = window.setTimeout(() => {
      realtimeBoardDebounceRef.current = null
      void fetchLeads({ background: true })
    }, 300)
  }, [fetchLeads])

  const loadColumnTitles = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return
    const effectiveUserId = imp.targetUserId ?? user.id

    const { data, error } = await supabase
      .from('crm_column_settings')
      .select('status_key, title')
      .eq('user_id', effectiveUserId)

    if (error) return

    setColumnTitles(() => {
      const next = { ...COLUMN_TITLES }
      for (const row of data ?? []) {
        const sk =
          typeof row.status_key === 'string' ? row.status_key.trim() : ''
        const rawTitle =
          typeof row.title === 'string' ? row.title.trim() : ''
        if (sk && rawTitle && isColumnId(sk)) next[sk] = rawTitle
      }
      return next
    })
  }, [imp.targetUserId])

  const saveColumnTitle = useCallback(
    async (statusKey: ColumnId, nextTitle: string) => {
      const trimmed = nextTitle.trim().slice(0, 120)
      if (!trimmed) return

      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setPersistError('Sessão inválida. Entre novamente para salvar o título da coluna.')
        setTimeout(() => setPersistError(null), 5000)
        return
      }

      const effectiveUserId = imp.targetUserId ?? user.id
      const { error } = await supabase.from('crm_column_settings').upsert(
        {
          user_id: effectiveUserId,
          status_key: statusKey,
          title: trimmed,
          sort_order: COLUMN_ORDER.indexOf(statusKey),
        },
        { onConflict: 'user_id,status_key' },
      )

      if (error) {
        setPersistError('Não foi possível salvar o título da coluna.')
        setTimeout(() => setPersistError(null), 5000)
        return
      }

      setColumnTitles((prev) => ({ ...prev, [statusKey]: trimmed }))
    },
    [imp.targetUserId],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLeads()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchLeads])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadColumnTitles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadColumnTitles])

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false

    const subscribe = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const effectiveUserId = imp.targetUserId ?? user.id

      channel = supabase
        .channel(`crm-realtime-${effectiveUserId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'leads',
            filter: `user_id=eq.${effectiveUserId}`,
          },
          () => {
            scheduleRealtimeBoardRefresh()
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
          },
          () => {
            scheduleRealtimeBoardRefresh()
          },
        )
        .subscribe()
    }

    void subscribe()

    return () => {
      cancelled = true
      if (realtimeBoardDebounceRef.current != null) {
        window.clearTimeout(realtimeBoardDebounceRef.current)
        realtimeBoardDebounceRef.current = null
      }
      if (channel) {
        void supabase.removeChannel(channel)
      }
      fetchGenerationRef.current += 1
    }
  }, [scheduleRealtimeBoardRefresh, imp.targetUserId])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)

      const snapshot = columnsSnapshotRef.current
      const dragStart = dragStartRef.current
      dragStartRef.current = null
      columnsSnapshotRef.current = null

      if (!snapshot) return

      if (!over) {
        columnsRef.current = snapshot
        setColumns(snapshot)
        return
      }

      const overId = String(over.id)
      const result = finalizeKanbanDrag(snapshot, String(active.id), overId)

      if (!result) {
        columnsRef.current = snapshot
        setColumns(snapshot)
        return
      }

      columnsRef.current = result.columns
      setColumns(result.columns)

      if (!dragStart || dragStart.column === result.endColumn) return

      const endCol = result.endColumn
      const leadIdMoved = dragStart.leadId
      const originCol = dragStart.column

      void (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!user) {
          setPersistError('Sessão inválida. Entre novamente para salvar a coluna.')
          setColumns((prev) => {
            const next = revertLeadToColumn(prev, leadIdMoved, endCol, originCol)
            columnsRef.current = next
            return next
          })
          setTimeout(() => setPersistError(null), 5000)
          return
        }

        const effectiveUserId = imp.targetUserId ?? user.id
        const { error } = await supabase
          .from('leads')
          .update({
            status: endCol,
            updated_at: new Date().toISOString(),
          })
          .eq('id', leadIdMoved)
          .eq('user_id', effectiveUserId)

        if (error) {
          setPersistError('Não foi possível salvar a coluna. Desfazendo movimento.')
          setColumns((prev) => {
            const next = revertLeadToColumn(prev, leadIdMoved, endCol, originCol)
            columnsRef.current = next
            return next
          })
          setTimeout(() => setPersistError(null), 5000)
        }
      })()
    },
    [imp.targetUserId],
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id)
    columnsSnapshotRef.current = structuredClone(columnsRef.current)
    const col = findContainer(columnsRef.current, event.active.id)
    if (col) {
      dragStartRef.current = { leadId: String(event.active.id), column: col }
    }
  }, [])

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    dragStartRef.current = null
    if (columnsSnapshotRef.current) {
      const snap = columnsSnapshotRef.current
      columnsRef.current = snap
      setColumns(snap)
    }
    columnsSnapshotRef.current = null
  }, [])

  const handleSaveNewLead = useCallback(async (nome: string, telefone: string) => {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return { error: 'Sessão inválida. Entre novamente.' }
    }

    const phoneDigits = toEvolutionDigits(telefone)
    if (!phoneDigits) {
      return {
        error:
          'Informe um número válido com DDD. O 55 (Brasil) é adicionado automaticamente se você digitar só DDD + número.',
      }
    }

    const effectiveUserId = imp.targetUserId ?? user.id
    const { data, error } = await supabase
      .from('leads')
      .insert({
        name: nome,
        phone: phoneDigits,
        status: 'novo',
        user_id: effectiveUserId,
        crm_show_without_chat: true,
      })
      .select(
        'id, name, phone, status, profile_picture_url, is_group, last_message_at, updated_at, ai_paused_until',
      )
      .single()

    if (error || !data) {
      return { error: error?.message ?? 'Erro ao criar lead.' }
    }

    const row = data as LeadRow
    const lead = rowToLead(row)

    setLeadsMap((prev) => ({ ...prev, [lead.id]: lead }))
    setColumns((prev) => {
      const next = {
        ...prev,
        novo: [...prev.novo, lead.id],
      }
      columnsRef.current = next
      return next
    })

    return { error: null }
  }, [imp.targetUserId])

  if (loading) {
    return (
      <div className="flex min-h-[min(50vh,400px)] flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-200/80 bg-zinc-50/80">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        <p className="text-sm font-medium text-zinc-500">Carregando leads…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex min-h-[min(50vh,400px)] flex-col items-center justify-center gap-4 rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm text-zinc-600">{loadError}</p>
        <button
          type="button"
          onClick={() => void fetchLeads()}
          className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800"
        >
          Tentar novamente
        </button>
      </div>
    )
  }

  return (
    <>
      {persistError ? (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          {persistError}
        </div>
      ) : null}

      <p className="mb-3 text-xs text-zinc-500">
        Exibimos só leads com conversa no WhatsApp (ou criados por &quot;+ Novo Lead&quot; aqui). Importações
        em massa ficam na Base de Contatos até alguém enviar ou receber mensagem.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={kanbanCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="-mx-1 flex min-h-[min(70vh,640px)] gap-4 overflow-x-auto overflow-y-hidden pb-2 pt-1">
          {COLUMN_ORDER.map((colId) => {
            const ids = columns[colId]
            return (
              <KanbanColumn
                key={colId}
                id={colId}
                title={columnTitles[colId]}
                onSaveTitle={(t) => void saveColumnTitle(colId, t)}
                headerAction={
                  colId === 'novo' ? (
                    <button
                      type="button"
                      onClick={() => setModalOpen(true)}
                      className="inline-flex shrink-0 items-center rounded-lg border border-zinc-200/90 bg-white px-2.5 py-1 text-xs font-semibold tabular-nums text-zinc-600 shadow-sm transition hover:border-brand-200 hover:text-brand-700"
                    >
                      + Novo Lead
                    </button>
                  ) : null
                }
              >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-3">
                    {ids.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-zinc-300/80 py-6 text-center text-xs text-zinc-400">
                        Nenhum lead aqui
                      </p>
                    ) : null}
                    {ids.map((id) => {
                      const lead = leadsMap[id]
                      if (!lead) return null
                      return (
                        <SortableLeadCard
                          key={id}
                          lead={lead}
                          onOpenChat={(l) => setChatLead(l)}
                        />
                      )
                    })}
                  </div>
                </SortableContext>
              </KanbanColumn>
            )
          })}
        </div>

        <DragOverlay dropAnimation={dropAnimation}>
          {activeLead ? (
            <div className="w-[min(100vw-2rem,280px)] cursor-grabbing shadow-2xl">
              <LeadCardFace lead={activeLead} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <NewLeadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveNewLead}
      />

      <ChatWindow
        open={chatLead != null}
        onClose={() => setChatLead(null)}
        lead={chatLead}
      />
    </>
  )
}

function KanbanColumn({
  id,
  title,
  onSaveTitle,
  headerAction,
  children,
}: {
  id: ColumnId
  title: string
  onSaveTitle?: (next: string) => void
  headerAction?: ReactNode
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)

  useEffect(() => {
    if (!editingTitle) setDraftTitle(title)
  }, [title, editingTitle])

  return (
    <section
      ref={setNodeRef}
      className={`flex w-[min(100vw-2rem,280px)] shrink-0 flex-col rounded-2xl border border-zinc-200/80 bg-zinc-100/90 shadow-inner ring-1 ring-zinc-200/40 transition-colors ${
        isOver ? 'bg-brand-50/35 ring-brand-400/40' : ''
      }`}
      aria-labelledby={`col-title-${id}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200/80 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {editingTitle ? (
            <input
              id={`col-title-${id}`}
              autoFocus
              value={draftTitle}
              maxLength={120}
              aria-label={`Editar nome da coluna ${title}`}
              className="w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wider text-zinc-700 shadow-sm outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
                if (e.key === 'Escape') {
                  setDraftTitle(title)
                  setEditingTitle(false)
                }
              }}
              onBlur={() => {
                setEditingTitle(false)
                const t = draftTitle.trim()
                if (!t) {
                  setDraftTitle(title)
                  return
                }
                if (t !== title) onSaveTitle?.(t)
              }}
            />
          ) : (
            <>
              <h2
                id={`col-title-${id}`}
                className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-zinc-500"
              >
                {title}
              </h2>
              {onSaveTitle ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-zinc-400 opacity-70 transition hover:bg-zinc-200/80 hover:text-zinc-600 hover:opacity-100"
                  aria-label="Renomear coluna"
                  onClick={() => {
                    setDraftTitle(title)
                    setEditingTitle(true)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </>
          )}
        </div>
        {headerAction ? (
          <div className="shrink-0">{headerAction}</div>
        ) : null}
      </header>
      <div
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
        style={{ minHeight: '120px' }}
      >
        {children}
      </div>
    </section>
  )
}
