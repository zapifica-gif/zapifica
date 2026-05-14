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
import { Bot, GripVertical, Pencil, Phone, Plus, Trash2, Users } from 'lucide-react'
import { toEvolutionDigits } from '../../lib/phoneBrazil'
import { supabase } from '../../lib/supabase'
import { ChatWindow } from './ChatWindow'
import { NewLeadModal } from './NewLeadModal'
import { useImpersonation } from '../../contexts/ImpersonationContext'

/** Slug salvo em `public.leads.status` / `crm_kanban_columns.key_slug`. */
export type KanbanStatusSlug = string

export type KanbanColumnDef = {
  id: string
  user_id: string
  key_slug: string
  title: string
  color_hex: string
  sort_order: number
}

/** Alias legado para compatibilidade com imports antigos. */
export type ColumnId = KanbanStatusSlug

export type LeadTemperature = 'frio' | 'morno' | 'quente'

export type Lead = {
  id: string
  name: string
  phone: string
  temperature: LeadTemperature
  profilePictureUrl: string | null
  isGroup: boolean
  lastActivityIso: string | null
  aiPausedUntilIso: string | null
  aiPausedForZvDispatch: boolean
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
  ai_paused_for_zv_dispatch?: boolean | null
}

function orderedBoardColumns(defs: KanbanColumnDef[]): KanbanColumnDef[] {
  return [...defs].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.key_slug.localeCompare(b.key_slug)
  })
}

function emptyColumnsFromDefs(defs: KanbanColumnDef[]): Record<string, string[]> {
  const o: Record<string, string[]> = {}
  for (const c of orderedBoardColumns(defs)) o[c.key_slug] = []
  return o
}

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
    aiPausedForZvDispatch: row.ai_paused_for_zv_dispatch === true,
  }
}

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

function statusToSlugForBoard(
  status: string | null | undefined,
  defs: KanbanColumnDef[],
): string {
  const s = (status ?? '').trim()
  const normalized = s === 'atendimento' ? 'em_atendimento' : s
  if (defs.some((d) => d.key_slug === normalized)) return normalized
  const novo = defs.find((d) => d.key_slug === 'novo')
  if (novo) return 'novo'
  return defs[0]?.key_slug ?? 'novo'
}

function leadSortTimestampMs(row: LeadRow): number {
  const last = row.last_message_at
    ? Date.parse(row.last_message_at)
    : Number.NaN
  if (!Number.isNaN(last)) return last
  const upd = row.updated_at ? Date.parse(row.updated_at) : 0
  return Number.isNaN(upd) ? 0 : upd
}

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

function resolveLeadColumnDuplicatesDyn(
  columns: Record<string, string[]>,
  defs: KanbanColumnDef[],
): Record<string, string[]> {
  const ordered = orderedBoardColumns(defs).map((d) => d.key_slug)
  const canonical = new Map<string, string>()
  for (const slug of [...ordered].reverse()) {
    for (const id of orderedUniqueStrings(columns[slug] ?? [])) {
      if (!canonical.has(id)) canonical.set(id, slug)
    }
  }
  const next = emptyColumnsFromDefs(defs)
  for (const slug of ordered) {
    next[slug] = orderedUniqueStrings(columns[slug] ?? []).filter(
      (id) => canonical.get(id) === slug,
    )
  }
  return next
}

function groupRowsIntoBoard(
  rows: LeadRow[],
  defs: KanbanColumnDef[],
): { columns: Record<string, string[]>; leadsMap: Record<string, Lead> } {
  const columns = emptyColumnsFromDefs(defs)
  const leadsMap: Record<string, Lead> = {}
  const sortTs: Record<string, number> = {}

  const uniqRows = dedupeLeadRowsPreferNewest(rows)
  for (const row of uniqRows) {
    if (!row.id) continue
    const lead = rowToLead(row)
    const col = statusToSlugForBoard(row.status, defs)
    leadsMap[lead.id] = lead
    sortTs[lead.id] = leadSortTimestampMs(row)
    if (!columns[col]) columns[col] = []
    columns[col].push(lead.id)
  }

  for (const c of orderedBoardColumns(defs)) {
    const slug = c.key_slug
    columns[slug] = orderedUniqueStrings(columns[slug] ?? [])
    columns[slug].sort((idA, idB) => {
      const ta = sortTs[idA] ?? 0
      const tb = sortTs[idB] ?? 0
      if (tb !== ta) return tb - ta
      return idA.localeCompare(idB)
    })
  }

  return {
    columns: resolveLeadColumnDuplicatesDyn(columns, defs),
    leadsMap,
  }
}

function findContainerDynamic(
  items: Record<string, string[]>,
  defs: KanbanColumnDef[],
  id: UniqueIdentifier,
): string | undefined {
  const s = String(id)
  if (defs.some((c) => c.id === s)) {
    return defs.find((c) => c.id === s)?.key_slug
  }
  for (const c of defs) {
    if (items[c.key_slug]?.includes(s)) return c.key_slug
  }
  return undefined
}

function cloneColumnsDynamic(
  base: Record<string, string[]>,
  defs: KanbanColumnDef[],
): Record<string, string[]> {
  const next: Record<string, string[]> = {}
  for (const c of orderedBoardColumns(defs)) {
    next[c.key_slug] = [...(base[c.key_slug] ?? [])]
  }
  return next
}

function finalizeKanbanDragDynamic(
  base: Record<string, string[]>,
  defs: KanbanColumnDef[],
  leadId: string,
  overId: string,
): { columns: Record<string, string[]>; endSlug: string } | null {
  const overCol = defs.find((c) => c.id === overId)
  const targetSlug =
    overCol?.key_slug ?? findContainerDynamic(base, defs, overId)
  if (!targetSlug) return null

  const sourceSlug = findContainerDynamic(base, defs, leadId)
  if (!sourceSlug) return null

  const next = cloneColumnsDynamic(base, defs)

  if (sourceSlug === targetSlug) {
    const items = [...next[targetSlug]]
    const oldIndex = items.indexOf(leadId)
    if (oldIndex < 0) return null

    let newIndex: number
    if (overCol) {
      newIndex = items.length > 0 ? Math.max(items.length - 1, 0) : 0
    } else {
      newIndex = items.indexOf(overId)
      if (newIndex < 0) newIndex = Math.max(items.length - 1, 0)
    }

    if (oldIndex !== newIndex) {
      next[targetSlug] = arrayMove(items, oldIndex, newIndex)
    }
    return { columns: next, endSlug: targetSlug }
  }

  for (const c of defs) {
    const slug = c.key_slug
    next[slug] = next[slug].filter((id) => id !== leadId)
  }

  const destItems = [...next[targetSlug]]
  let insertIndex: number
  if (overCol) {
    insertIndex = destItems.length
  } else {
    insertIndex = destItems.indexOf(overId)
    if (insertIndex < 0) insertIndex = destItems.length
  }
  destItems.splice(insertIndex, 0, leadId)
  next[targetSlug] = destItems
  return { columns: next, endSlug: targetSlug }
}

const kanbanCollisionDetection: CollisionDetection = (args) => {
  const inside = pointerWithin(args)
  if (inside.length) return inside
  return closestCorners(args)
}

function revertLeadToColumnDyn(
  prev: Record<string, string[]>,
  defs: KanbanColumnDef[],
  leadId: string,
  fromSlug: string,
  toSlug: string,
): Record<string, string[]> {
  const next = cloneColumnsDynamic(prev, defs)
  const from = [...next[fromSlug]]
  const to = [...next[toSlug]]
  const idx = from.indexOf(leadId)
  if (idx === -1) return prev
  from.splice(idx, 1)
  to.push(leadId)
  next[fromSlug] = from
  next[toSlug] = to
  return next
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
            {lead.aiPausedForZvDispatch ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-900 ring-1 ring-orange-200/80 dark:bg-orange-950/30 dark:text-orange-200 dark:ring-orange-900/60"
                title="IA pausada: Zap Voice está enviando o funil para este lead (evita briga de robôs)."
              >
                <span aria-hidden>🤖🔇</span>
                IA · Funil
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

type DragStartInfo = { leadId: string; column: string }

function randomColumnSlug(): string {
  const u = crypto.randomUUID().replace(/-/g, '')
  return `col_${u.slice(0, 12)}`
}

export function CrmKanbanBoard() {
  const { state: imp } = useImpersonation()
  const [boardCols, setBoardCols] = useState<KanbanColumnDef[]>([])
  const [columns, setColumns] = useState<Record<string, string[]>>({})
  const [leadsMap, setLeadsMap] = useState<Record<string, Lead>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [chatLead, setChatLead] = useState<Lead | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [newColOpen, setNewColOpen] = useState(false)
  const [newColTitle, setNewColTitle] = useState('')
  const [newColColor, setNewColColor] = useState('#6a00b8')

  const columnsRef = useRef(columns)
  const boardColsRef = useRef<KanbanColumnDef[]>([])
  const dragStartRef = useRef<DragStartInfo | null>(null)
  const columnsSnapshotRef = useRef<Record<string, string[]> | null>(null)
  const boardColsSnapshotRef = useRef<KanbanColumnDef[] | null>(null)
  const boardTenantUserIdRef = useRef<string | null>(null)
  const fetchGenerationRef = useRef(0)
  const realtimeBoardDebounceRef = useRef<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const activeLead = activeId ? leadsMap[String(activeId)] : null

  useEffect(() => {
    columnsRef.current = columns
  }, [columns])

  useEffect(() => {
    boardColsRef.current = boardCols
  }, [boardCols])

  const fetchKanbanColumnDefs = useCallback(async (effectiveUserId: string) => {
    await supabase.rpc('crm_seed_default_kanban_columns', {
      p_user_id: effectiveUserId,
    })
    const { data, error } = await supabase
      .from('crm_kanban_columns')
      .select('id, user_id, key_slug, title, color_hex, sort_order')
      .eq('user_id', effectiveUserId)
      .order('sort_order', { ascending: true })
    if (error || !data?.length) return [] as KanbanColumnDef[]
    return data as KanbanColumnDef[]
  }, [])

  const fetchLeads = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background === true
      const gen = ++fetchGenerationRef.current
      const isCurrent = () => gen === fetchGenerationRef.current

      if (!background) {
        setLoading(true)
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
        boardTenantUserIdRef.current = null
        return
      }
      const effectiveUserId = imp.targetUserId ?? user.id
      boardTenantUserIdRef.current = effectiveUserId

      const defs = await fetchKanbanColumnDefs(effectiveUserId)
      if (!isCurrent()) return

      if (!defs.length) {
        if (isCurrent() && !background) {
          setLoadError('Não foi possível carregar as colunas do funil.')
          setLoading(false)
        }
        return
      }

      boardColsRef.current = defs
      if (!background) {
        setBoardCols(defs)
      } else {
        setBoardCols((prev) => {
          const same =
            prev.length === defs.length &&
            prev.every((p, i) => p.id === defs[i]?.id && p.title === defs[i]?.title)
          return same ? prev : defs
        })
      }

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
      const useDefs = boardColsRef.current.length ? boardColsRef.current : defs
      const { columns: nextCols, leadsMap: nextLeads } = groupRowsIntoBoard(
        rows,
        useDefs,
      )
      columnsRef.current = nextCols
      setColumns(nextCols)
      setLeadsMap(nextLeads)
      if (!background) {
        setLoading(false)
      }
    },
    [imp.targetUserId, fetchKanbanColumnDefs],
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

  const saveColumnTitle = useCallback(
    async (columnId: string, nextTitle: string) => {
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

      const { error } = await supabase
        .from('crm_kanban_columns')
        .update({ title: trimmed, updated_at: new Date().toISOString() })
        .eq('id', columnId)

      if (error) {
        setPersistError('Não foi possível salvar o título da coluna.')
        setTimeout(() => setPersistError(null), 5000)
        return
      }

      setBoardCols((prev) =>
        prev.map((c) => (c.id === columnId ? { ...c, title: trimmed } : c)),
      )
    },
    [],
  )

  const saveColumnColor = useCallback(async (columnId: string, hex: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    const { error } = await supabase
      .from('crm_kanban_columns')
      .update({ color_hex: hex, updated_at: new Date().toISOString() })
      .eq('id', columnId)

    if (error) {
      setPersistError('Não foi possível salvar a cor da coluna.')
      setTimeout(() => setPersistError(null), 5000)
      return
    }

    setBoardCols((prev) =>
      prev.map((c) => (c.id === columnId ? { ...c, color_hex: hex } : c)),
    )
  }, [])

  const addColumn = useCallback(async () => {
    const title = newColTitle.trim().slice(0, 120)
    if (!title) return

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    const effectiveUserId = imp.targetUserId ?? user.id
    const defs = boardColsRef.current
    const nextOrder =
      defs.reduce((m, c) => Math.max(m, c.sort_order), -1) + 1
    const key_slug = randomColumnSlug()

    const { data, error } = await supabase
      .from('crm_kanban_columns')
      .insert({
        user_id: effectiveUserId,
        key_slug,
        title,
        color_hex: newColColor,
        sort_order: nextOrder,
      })
      .select('id, user_id, key_slug, title, color_hex, sort_order')
      .single()

    if (error || !data) {
      setPersistError('Não foi possível criar a coluna.')
      setTimeout(() => setPersistError(null), 5000)
      return
    }

    const row = data as KanbanColumnDef
    setBoardCols((prev) => {
      const next = [...prev, row].sort((a, b) => a.sort_order - b.sort_order)
      boardColsRef.current = next
      return next
    })
    setColumns((prev) => {
      const next = { ...prev, [row.key_slug]: [] }
      columnsRef.current = next
      return next
    })
    setNewColOpen(false)
    setNewColTitle('')
    setNewColColor('#6a00b8')
  }, [imp.targetUserId, newColColor, newColTitle])

  const deleteColumn = useCallback(
    async (col: KanbanColumnDef) => {
      const defs = boardColsRef.current
      if (defs.length <= 1) {
        window.alert('É preciso manter pelo menos uma coluna no funil.')
        return
      }
      if (
        !window.confirm(
          `Excluir a coluna "${col.title}"? Os leads nela serão movidos para outra etapa.`,
        )
      ) {
        return
      }

      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      const effectiveUserId = imp.targetUserId ?? user.id
      const fallback =
        defs.find((d) => d.key_slug === 'novo' && d.id !== col.id) ??
        defs.find((d) => d.id !== col.id)
      if (!fallback) return

      const idsInCol = columnsRef.current[col.key_slug] ?? []
      if (idsInCol.length) {
        const { error: upErr } = await supabase
          .from('leads')
          .update({
            status: fallback.key_slug,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', effectiveUserId)
          .in('id', idsInCol)

        if (upErr) {
          setPersistError('Não foi possível mover os leads antes de excluir a coluna.')
          setTimeout(() => setPersistError(null), 5000)
          return
        }
      }

      const { error: delErr } = await supabase
        .from('crm_kanban_columns')
        .delete()
        .eq('id', col.id)

      if (delErr) {
        setPersistError('Não foi possível excluir a coluna.')
        setTimeout(() => setPersistError(null), 5000)
        return
      }

      void fetchLeads({ background: false })
    },
    [fetchLeads, imp.targetUserId],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLeads()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchLeads])

  useEffect(() => {
    if (loading) return
    try {
      const raw = sessionStorage.getItem('zapifica_crm_open_lead')
      if (!raw) return
      sessionStorage.removeItem('zapifica_crm_open_lead')
      const id = raw.trim()
      const lead = leadsMap[id]
      if (lead) setChatLead(lead)
    } catch {
      /* ignore */
    }
  }, [loading, leadsMap])

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
            event: '*',
            schema: 'public',
            table: 'crm_kanban_columns',
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
      const defsSnap = boardColsSnapshotRef.current
      const dragStart = dragStartRef.current
      dragStartRef.current = null
      columnsSnapshotRef.current = null
      boardColsSnapshotRef.current = null

      if (!snapshot || !defsSnap?.length) return

      if (!over) {
        columnsRef.current = snapshot
        setColumns(snapshot)
        return
      }

      const overId = String(over.id)
      const result = finalizeKanbanDragDynamic(
        snapshot,
        defsSnap,
        String(active.id),
        overId,
      )

      if (!result) {
        columnsRef.current = snapshot
        setColumns(snapshot)
        return
      }

      columnsRef.current = result.columns
      setColumns(result.columns)

      if (!dragStart || dragStart.column === result.endSlug) return

      const endSlug = result.endSlug
      const leadIdMoved = dragStart.leadId
      const originCol = dragStart.column

      void (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!user) {
          setPersistError('Sessão inválida. Entre novamente para salvar a coluna.')
          setColumns((prev) => {
            const next = revertLeadToColumnDyn(
              prev,
              defsSnap,
              leadIdMoved,
              endSlug,
              originCol,
            )
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
            status: endSlug,
            updated_at: new Date().toISOString(),
          })
          .eq('id', leadIdMoved)
          .eq('user_id', effectiveUserId)

        if (error) {
          setPersistError('Não foi possível salvar a coluna. Desfazendo movimento.')
          setColumns((prev) => {
            const next = revertLeadToColumnDyn(
              prev,
              defsSnap,
              leadIdMoved,
              endSlug,
              originCol,
            )
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
    boardColsSnapshotRef.current = [...boardColsRef.current]
    const col = findContainerDynamic(
      columnsRef.current,
      boardColsRef.current,
      event.active.id,
    )
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
    boardColsSnapshotRef.current = null
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
    const novoSlug =
      boardColsRef.current.find((d) => d.key_slug === 'novo')?.key_slug ??
      boardColsRef.current[0]?.key_slug ??
      'novo'

    const { data, error } = await supabase
      .from('leads')
      .insert({
        name: nome,
        phone: phoneDigits,
        status: novoSlug,
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
        [novoSlug]: [...(prev[novoSlug] ?? []), lead.id],
      }
      columnsRef.current = next
      return next
    })

    return { error: null }
  }, [imp.targetUserId])

  const sortedCols = orderedBoardColumns(boardCols)

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
          className="btn-primary-magnetic-sm"
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
          {sortedCols.map((col) => {
            const ids = columns[col.key_slug] ?? []
            return (
              <KanbanColumn
                key={col.id}
                droppableId={col.id}
                title={col.title}
                colorHex={col.color_hex}
                onSaveTitle={(t) => void saveColumnTitle(col.id, t)}
                onSaveColor={(hex) => void saveColumnColor(col.id, hex)}
                onDelete={() => void deleteColumn(col)}
                headerAction={
                  col.key_slug === 'novo' ? (
                    <button
                      type="button"
                      onClick={() => setModalOpen(true)}
                      className="btn-primary-magnetic-sm shrink-0"
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

          <div className="flex w-[min(100vw-2rem,200px)] shrink-0 flex-col items-stretch justify-start pt-2">
            <button
              type="button"
              onClick={() => {
                setNewColTitle('')
                setNewColColor('#6a00b8')
                setNewColOpen(true)
              }}
              className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-300 bg-white/80 px-3 py-4 text-sm font-semibold text-zinc-600 shadow-sm transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-800"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Nova coluna
            </button>
          </div>
        </div>

        <DragOverlay dropAnimation={dropAnimation}>
          {activeLead ? (
            <div className="w-[min(100vw-2rem,280px)] cursor-grabbing shadow-2xl">
              <LeadCardFace lead={activeLead} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {newColOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-zinc-950/45 px-4 backdrop-blur-[2px]">
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nova-coluna-titulo"
          >
            <h3 id="nova-coluna-titulo" className="text-base font-semibold text-zinc-900">
              Nova coluna no funil
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Defina o nome e a cor do cabeçalho. O sistema cria um identificador interno estável para
              arrastar leads.
            </p>
            <label className="mt-4 block text-xs font-semibold text-zinc-600" htmlFor="nova-col-nome">
              Nome da etapa
            </label>
            <input
              id="nova-col-nome"
              value={newColTitle}
              onChange={(e) => setNewColTitle(e.target.value)}
              className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
              placeholder="Ex.: Aguardando cliente"
              maxLength={120}
            />
            <label className="mt-3 block text-xs font-semibold text-zinc-600" htmlFor="nova-col-cor">
              Cor do cabeçalho
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                id="nova-col-cor"
                type="color"
                value={newColColor}
                onChange={(e) => setNewColColor(e.target.value)}
                className="h-10 w-14 cursor-pointer rounded-lg border border-zinc-200 bg-white p-1"
              />
              <span className="text-xs text-zinc-500">{newColColor}</span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={() => setNewColOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary-magnetic-sm"
                onClick={() => void addColumn()}
              >
                Criar coluna
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <NewLeadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveNewLead}
      />

      <ChatWindow
        open={chatLead != null}
        onClose={() => setChatLead(null)}
        lead={chatLead}
        boardTenantUserIdRef={boardTenantUserIdRef}
      />
    </>
  )
}

function KanbanColumn({
  droppableId,
  title,
  colorHex,
  onSaveTitle,
  onSaveColor,
  onDelete,
  headerAction,
  children,
}: {
  droppableId: string
  title: string
  colorHex: string
  onSaveTitle?: (next: string) => void
  onSaveColor?: (hex: string) => void
  onDelete?: () => void
  headerAction?: ReactNode
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId })
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)

  useEffect(() => {
    if (!editingTitle) setDraftTitle(title)
  }, [title, editingTitle])

  return (
    <section
      ref={setNodeRef}
      className={`flex w-[min(100vw-2rem,280px)] shrink-0 flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-zinc-100/90 shadow-inner ring-1 ring-zinc-200/40 transition-colors ${
        isOver ? 'bg-brand-50/35 ring-brand-400/40' : ''
      }`}
      aria-labelledby={`col-title-${droppableId}`}
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b border-black/10 px-3 py-2.5 text-white shadow-sm"
        style={{ backgroundColor: colorHex || '#6a00b8' }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {editingTitle ? (
            <input
              id={`col-title-${droppableId}`}
              autoFocus
              value={draftTitle}
              maxLength={120}
              aria-label={`Editar nome da coluna ${title}`}
              className="w-full min-w-0 rounded-lg border border-white/30 bg-white/95 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-zinc-800 shadow-sm outline-none focus:ring-2 focus:ring-white/80"
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
                id={`col-title-${droppableId}`}
                className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-white drop-shadow-sm"
              >
                {title}
              </h2>
              {onSaveTitle ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-white/80 transition hover:bg-white/15 hover:text-white"
                  aria-label="Renomear coluna"
                  onClick={() => {
                    setDraftTitle(title)
                    setEditingTitle(true)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {onSaveColor ? (
                <label className="inline-flex cursor-pointer items-center rounded-md p-1 text-white/90 hover:bg-white/15">
                  <input
                    type="color"
                    value={colorHex}
                    className="sr-only"
                    onChange={(e) => onSaveColor(e.target.value)}
                    aria-label="Cor do cabeçalho da coluna"
                  />
                  <span className="text-[10px] font-bold uppercase">Cor</span>
                </label>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-white/80 transition hover:bg-rose-500/40 hover:text-white"
                  aria-label="Excluir coluna"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </>
          )}
        </div>
        {headerAction ? (
          <div className="shrink-0 [&_button]:border-white/40 [&_button]:bg-white/15 [&_button]:text-white [&_button]:hover:bg-white/25">
            {headerAction}
          </div>
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
