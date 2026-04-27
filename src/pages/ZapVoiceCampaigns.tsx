import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEventHandler,
} from 'react'
import {
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  FileText,
  Image as ImageIcon,
  History,
  LayoutGrid,
  ListTodo,
  Loader2,
  Megaphone,
  MessageSquare,
  Mic,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Video,
  Zap,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { ContactsBasePanel } from '../components/zapvoice/ContactsBasePanel'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

/** Alinhado ao enum `public.zv_funnel_media_type` (Supabase). */
export type FunnelMediaType = 'text' | 'image' | 'video' | 'audio' | 'document'

type Campaign = {
  id: string
  user_id: string
  name: string
  description: string | null
  /** Tags de público (OR): o disparo considera qualquer lead com uma delas. */
  audience_tags: string[] | null
  /** Início do funil agendado (futuro); mensagens somam atrasos a partir daqui. */
  scheduled_start_at: string | null
  /** Frases exatas (Meta Ads / respostas rápidas) — motor de roteamento virá a usar. */
  inbound_triggers: string[] | null
  status: CampaignStatus
  min_delay_seconds: number
  max_delay_seconds: number
  created_at: string
  updated_at: string
}

type FunnelStep = {
  id: string
  campaign_id: string
  step_order: number
  message: string
  media_type: FunnelMediaType
  media_url: string | null
  delay_seconds: number
  expected_trigger: string | null
  advance_type?: 'auto' | 'exact' | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  created_at: string
  updated_at: string
}

type AudienceTagOption = { tag: string; count: number }

type TagMultiPickerProps = {
  options: AudienceTagOption[]
  value: string[]
  onChange: (next: string[]) => void
  customHint?: string
}

function TagMultiPicker({ options, value, onChange, customHint }: TagMultiPickerProps) {
  const [custom, setCustom] = useState('')
  const toggle = (tag: string) => {
    if (value.includes(tag)) onChange(value.filter((t) => t !== tag))
    else onChange([...value, tag])
  }
  const addCustom = () => {
    const t = custom.trim()
    if (!t || value.includes(t)) return
    onChange([...value, t])
    setCustom('')
  }
  return (
    <div className="space-y-2">
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2">
        {options.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Nenhuma tag ainda — importe na aba Base de Contatos ou use o Extrator.
          </p>
        ) : (
          options.map((o) => (
            <label
              key={o.tag}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-zinc-800 hover:bg-zinc-50"
            >
              <input
                type="checkbox"
                className="rounded border-zinc-300"
                checked={value.includes(o.tag)}
                onChange={() => toggle(o.tag)}
              />
              <span className="min-w-0 flex-1 truncate">{o.tag}</span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">{o.count}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCustom()
            }
          }}
          placeholder="Outra tag (Enter para adicionar)"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-brand-300"
        />
        <button
          type="button"
          onClick={addCustom}
          className="shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100"
        >
          Adicionar
        </button>
      </div>
      {customHint ? <p className="text-[11px] text-zinc-500">{customHint}</p> : null}
    </div>
  )
}

type PhraseChipsInputProps = {
  value: string[]
  onChange: (next: string[]) => void
  help: string
  placeholder?: string
}

function PhraseChipsInput({ value, onChange, help, placeholder }: PhraseChipsInputProps) {
  const [draft, setDraft] = useState('')
  const add = (phrase: string) => {
    const t = phrase.trim()
    if (!t || value.includes(t)) return
    onChange([...value, t])
    setDraft('')
  }
  const remove = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }
  return (
    <div className="space-y-2">
      <div className="flex min-h-[2.5rem] flex-wrap gap-1.5 rounded-lg border border-zinc-200 bg-white p-2">
        {value.length === 0 ? (
          <span className="self-center pl-0.5 text-xs text-zinc-400">Nenhuma frase ainda</span>
        ) : null}
        {value.map((phrase, i) => (
          <span
            key={`${phrase}-${i}`}
            className="group inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-800"
          >
            <span className="min-w-0 max-w-[240px] truncate" title={phrase}>
              {phrase}
            </span>
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800"
              aria-label="Remover"
            >
              <span className="text-[10px] font-bold">×</span>
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            }
          }}
          placeholder={placeholder ?? 'Digite a frase e pressione Enter'}
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-brand-300"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          className="shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100"
        >
          Incluir
        </button>
      </div>
      <p className="text-[11px] text-zinc-500">{help}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const statusVisual: Record<
  CampaignStatus,
  { label: string; pill: string; dot: string }
> = {
  draft: {
    label: 'Rascunho',
    pill: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
    dot: 'bg-zinc-400',
  },
  active: {
    label: 'Ativa',
    pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  paused: {
    label: 'Pausada',
    pill: 'bg-amber-50 text-amber-900 ring-amber-200',
    dot: 'bg-amber-500',
  },
  completed: {
    label: 'Concluída',
    pill: 'bg-brand-50 text-brand-800 ring-brand-200',
    dot: 'bg-brand-600',
  },
}

function formatDateBr(iso: string) {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function normalizeInboundTriggers(raw: string[] | null | undefined): string[] {
  if (!raw || !Array.isArray(raw)) return []
  return [...new Set(raw.map((t) => t.trim()).filter(Boolean))]
}

/** Valor de `<input type="datetime-local" />` no fuso do navegador. */
function isoToDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

function datetimeLocalToIso(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Variáveis dinâmicas suportadas no editor de mensagem (preview-only). */
const MESSAGE_VARIABLES = [
  { key: '{nome}', helper: 'Primeiro nome do contato' },
  { key: '{empresa}', helper: 'Nome da empresa do lead' },
  { key: '{cidade}', helper: 'Cidade da extração' },
] as const

const INSERT_CHUNK = 120

function firstNameFromFullName(full: string): string {
  const t = full.trim()
  if (!t) return 'Cliente'
  return t.split(/\s+/)[0] ?? t
}

function cityFromExtractionLocation(loc: string | null | undefined): string {
  if (!loc) return ''
  return loc.split(',')[0]?.trim() ?? ''
}

function phoneDigitsForQueue(raw: string | null | undefined): string | null {
  if (!raw) return null
  const d = raw.replace(/\D/g, '')
  if (d.length < 10) return null
  if (d.startsWith('55') && d.length >= 12) return d
  if (d.length === 10 || d.length === 11) return `55${d}`
  if (d.length >= 12) return d
  return null
}

type TemplateVars = { nome: string; empresa: string; cidade: string }

function applyMessageTemplate(template: string, vars: TemplateVars): string {
  return template
    .replaceAll('{nome}', vars.nome)
    .replaceAll('{empresa}', vars.empresa)
    .replaceAll('{cidade}', vars.cidade)
}

// ---------------------------------------------------------------------------
// Página principal
// ---------------------------------------------------------------------------

type MainTab = 'campanhas' | 'contatos' | 'historico'

function normalizeTags(raw: string[] | null | undefined): string[] {
  if (!raw || !Array.isArray(raw)) return []
  return [...new Set(raw.map((t) => t.trim()).filter(Boolean))]
}

export function ZapVoiceCampaignsPage() {
  const [mainTab, setMainTab] = useState<MainTab>('campanhas')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [audienceOptions, setAudienceOptions] = useState<AudienceTagOption[]>([])

  const [steps, setSteps] = useState<FunnelStep[]>([])
  const [stepsLoading, setStepsLoading] = useState(false)
  const [savingStepId, setSavingStepId] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)

  // form de "Nova Campanha"
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAudienceTags, setNewAudienceTags] = useState<string[]>([])
  const [newDescription, setNewDescription] = useState('')
  const [newScheduledStartLocal, setNewScheduledStartLocal] = useState('')
  const [newInboundTriggers, setNewInboundTriggers] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [historyStats, setHistoryStats] = useState<
    Record<string, { firstAt: string | null; leadCount: number }>
  >({})

  const selected = useMemo(
    () => campaigns.find((c) => c.id === selectedId) ?? null,
    [campaigns, selectedId],
  )

  const [audienceReachCount, setAudienceReachCount] = useState<number | null>(null)

  const tagsForSelected = useMemo(
    () => normalizeTags(selected?.audience_tags),
    [selected],
  )

  const activeCampaigns = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          c.status === 'draft' || c.status === 'active' || c.status === 'paused',
      ),
    [campaigns],
  )
  const completedCampaigns = useMemo(
    () => campaigns.filter((c) => c.status === 'completed'),
    [campaigns],
  )

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------

  const loadAudienceOptions = useCallback(async (uid: string) => {
    const { data, error: e } = await supabase
      .from('leads')
      .select('tag')
      .eq('user_id', uid)
      .not('tag', 'is', null)
    if (e) {
      console.error('[ZapVoiceCampaigns] leads tags:', e)
      return
    }
    const tally = new Map<string, number>()
    for (const row of (data ?? []) as { tag: string | null }[]) {
      const t = (row.tag ?? '').trim()
      if (!t) continue
      tally.set(t, (tally.get(t) ?? 0) + 1)
    }
    const options = [...tally.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
    setAudienceOptions(options)
  }, [])

  const loadHistoryStats = useCallback(
    async (campaignIds: string[], uid: string) => {
      if (campaignIds.length === 0) {
        setHistoryStats({})
        return
      }
      const { data, error: e } = await supabase
        .from('scheduled_messages')
        .select('zv_campaign_id, scheduled_at, lead_id')
        .eq('user_id', uid)
        .in('zv_campaign_id', campaignIds)
      if (e) {
        console.error('[ZapVoiceCampaigns] history stats:', e)
        return
      }
      type Row = {
        zv_campaign_id: string | null
        scheduled_at: string
        lead_id: string | null
      }
      const acc = new Map<
        string,
        { firstAt: string; leadCount: number; leads: Set<string> }
      >()
      for (const row of (data ?? []) as Row[]) {
        const cid = row.zv_campaign_id
        if (!cid) continue
        let b = acc.get(cid)
        if (!b) {
          b = { firstAt: row.scheduled_at, leadCount: 0, leads: new Set() }
          acc.set(cid, b)
        }
        if (row.scheduled_at < b.firstAt) b.firstAt = row.scheduled_at
        if (row.lead_id) b.leads.add(row.lead_id)
      }
      const next: Record<string, { firstAt: string | null; leadCount: number }> = {}
      for (const id of campaignIds) {
        const b = acc.get(id)
        next[id] = b
          ? { firstAt: b.firstAt, leadCount: b.leads.size }
          : { firstAt: null, leadCount: 0 }
      }
      setHistoryStats(next)
    },
    [],
  )

  const loadCampaigns = useCallback(async () => {
    setLoading(true)
    setError(null)
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setError('Sessão inválida. Entre novamente.')
      setLoading(false)
      return
    }
    setUserId(user.id)

    const list = await supabase
      .from('zv_campaigns')
      .select(
        'id, user_id, name, description, audience_tags, scheduled_start_at, inbound_triggers, status, min_delay_seconds, max_delay_seconds, created_at, updated_at',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (list.error) {
      setError(`Falha ao listar campanhas: ${list.error.message}`)
      setLoading(false)
      return
    }

    const rows = (list.data ?? []).map((r) => {
      const c = r as {
        audience_tags?: string[] | null
        inbound_triggers?: string[] | null
        scheduled_start_at?: string | null
      }
      return {
        ...(r as Campaign),
        audience_tags: normalizeTags(c.audience_tags),
        inbound_triggers: normalizeInboundTriggers(c.inbound_triggers),
        scheduled_start_at: c.scheduled_start_at ?? null,
      } as Campaign
    })
    setCampaigns(rows)
    setSelectedId((prev) => {
      const actives = rows.filter(
        (r) =>
          r.status === 'draft' || r.status === 'active' || r.status === 'paused',
      )
      if (actives.length === 0) {
        if (prev && rows.some((r) => r.id === prev)) return prev
        return rows[0]?.id ?? null
      }
      if (prev && actives.some((r) => r.id === prev)) return prev
      return actives[0].id
    })

    await loadAudienceOptions(user.id)
    setLoading(false)
  }, [loadAudienceOptions])

  const loadSteps = useCallback(async (campaignId: string) => {
    setStepsLoading(true)
    const { data, error: e } = await supabase
      .from('zv_funnels')
      .select(
        'id, campaign_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds, created_at, updated_at',
      )
      .eq('campaign_id', campaignId)
      .order('step_order', { ascending: true })
    if (e) {
      setError(`Falha ao carregar etapas: ${e.message}`)
      setStepsLoading(false)
      return
    }
    setSteps((data ?? []) as FunnelStep[])
    setStepsLoading(false)
  }, [])

  useEffect(() => {
    void loadCampaigns()
  }, [loadCampaigns])

  useEffect(() => {
    const h = window.location.hash
    if (h === '#contatos') setMainTab('contatos')
    else if (h === '#historico') setMainTab('historico')
  }, [])

  const completedIdsKey = useMemo(
    () => [...completedCampaigns].map((c) => c.id).sort().join(','),
    [completedCampaigns],
  )

  useEffect(() => {
    if (mainTab !== 'historico' || !userId) return
    const ids = completedCampaigns.map((c) => c.id)
    void loadHistoryStats(ids, userId)
  }, [mainTab, userId, completedIdsKey, loadHistoryStats, completedCampaigns])

  useEffect(() => {
    if (loading) return
    if (mainTab !== 'campanhas') return
    const ids = new Set(activeCampaigns.map((c) => c.id))
    if (selectedId && !ids.has(selectedId)) {
      setSelectedId(activeCampaigns[0]?.id ?? null)
    } else if (!selectedId && activeCampaigns[0]) {
      setSelectedId(activeCampaigns[0].id)
    }
  }, [loading, mainTab, activeCampaigns, selectedId])

  const tagsKey = tagsForSelected.join('\u0000')

  useEffect(() => {
    if (!userId || tagsForSelected.length === 0) {
      setAudienceReachCount(0)
      return
    }
    let cancelled = false
    void (async () => {
      const { count, error: e } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('tag', tagsForSelected)
      if (cancelled) return
      if (e) {
        setAudienceReachCount(0)
        return
      }
      setAudienceReachCount(count ?? 0)
    })()
    return () => {
      cancelled = true
    }
  }, [userId, selected?.id, tagsKey])

  useEffect(() => {
    if (mainTab !== 'campanhas' || !selectedId) {
      setSteps([])
      return
    }
    void loadSteps(selectedId)
  }, [selectedId, loadSteps, mainTab])

  // -------------------------------------------------------------------------
  // Mutations: campanha
  // -------------------------------------------------------------------------

  const createCampaign = useCallback(async () => {
    if (!userId) return
    if (!newName.trim()) {
      setError('Dê um nome para a campanha.')
      return
    }
    setCreating(true)
    setError(null)
    setSuccess(null)
    try {
      const startIso = datetimeLocalToIso(newScheduledStartLocal)
      const insert = await supabase
        .from('zv_campaigns')
        .insert({
          user_id: userId,
          name: newName.trim(),
          description: newDescription.trim() || null,
          audience_tags: normalizeTags(newAudienceTags),
          scheduled_start_at: startIso,
          inbound_triggers: normalizeInboundTriggers(newInboundTriggers),
          status: 'draft' as CampaignStatus,
          min_delay_seconds: 2,
          max_delay_seconds: 15,
        })
        .select(
          'id, user_id, name, description, audience_tags, scheduled_start_at, inbound_triggers, status, min_delay_seconds, max_delay_seconds, created_at, updated_at',
        )
        .single()
      if (insert.error || !insert.data) {
        throw new Error(insert.error?.message ?? 'Falha ao criar campanha.')
      }
      const ins = insert.data as {
        audience_tags?: string[] | null
        inbound_triggers?: string[] | null
        scheduled_start_at?: string | null
      }
      const created = {
        ...(insert.data as object),
        audience_tags: normalizeTags(ins.audience_tags),
        inbound_triggers: normalizeInboundTriggers(ins.inbound_triggers),
        scheduled_start_at: ins.scheduled_start_at ?? null,
      } as Campaign

      // Cria automaticamente uma Etapa 1 vazia para o usuário já editar.
      await supabase.from('zv_funnels').insert({
        campaign_id: created.id,
        step_order: 1,
        message: 'Olá {nome}, tudo bem? Aqui é da equipe Zapifica…',
        media_type: 'text',
        media_url: null,
        delay_seconds: 0,
        expected_trigger: null,
        advance_type: 'auto',
      })

      setCampaigns((prev) => [created, ...prev])
      setSelectedId(created.id)
      setNewOpen(false)
      setNewName('')
      setNewAudienceTags([])
      setNewDescription('')
      setNewScheduledStartLocal('')
      setNewInboundTriggers([])
      setSuccess('Campanha criada. Agora monte o roteiro de mensagens.')
      window.setTimeout(() => setSuccess(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao criar campanha.')
    } finally {
      setCreating(false)
    }
  }, [newName, newDescription, newAudienceTags, newScheduledStartLocal, newInboundTriggers, userId])

  const updateCampaign = useCallback(
    async (id: string, patch: Partial<Campaign>) => {
      const { error: e } = await supabase
        .from('zv_campaigns')
        .update(patch)
        .eq('id', id)
      if (e) {
        setError(`Falha ao atualizar campanha: ${e.message}`)
        return
      }
      setCampaigns((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      )
    },
    [],
  )

  /** Remove agendamentos pendentes desta campanha (re-ativação sem duplicar). */
  const clearPendingForCampaign = useCallback(
    async (campaignId: string, uid: string) => {
      const { error: e } = await supabase
        .from('scheduled_messages')
        .delete()
        .eq('user_id', uid)
        .eq('zv_campaign_id', campaignId)
        .eq('status', 'pending')
      if (e) {
        throw new Error(
          `Não foi possível limpar a fila pendente: ${e.message}`,
        )
      }
    },
    [],
  )

  const unlockLeadsForCampaign = useCallback(
    async (campaignId: string, uid: string) => {
      const { data, error: e } = await supabase
        .from('scheduled_messages')
        .select('lead_id')
        .eq('user_id', uid)
        .eq('zv_campaign_id', campaignId)
        .not('lead_id', 'is', null)
      if (e) {
        console.warn('[ZapVoiceCampaigns] unlock leads list:', e.message)
        return
      }
      const ids = Array.from(
        new Set(
          (data ?? [])
            .map((r) => (r as { lead_id: string | null }).lead_id)
            .filter((x): x is string => Boolean(x)),
        ),
      )
      if (ids.length === 0) return
      const { error: e2 } = await supabase
        .from('leads')
        .update({ funnel_locked_until: null })
        .eq('user_id', uid)
        .in('id', ids)
      if (e2) {
        console.warn('[ZapVoiceCampaigns] unlock leads update:', e2.message)
      }
    },
    [],
  )

  const activateCampaign = useCallback(
    async (c: Campaign, funnelSteps: FunnelStep[]) => {
      if (!userId) {
        setError('Sessão inválida.')
        return
      }
      setError(null)
      setSuccess(null)
      setActivating(true)
      try {
        const pickRandomIntInclusive = (min: number, max: number) => {
          const a = Math.ceil(min)
          const b = Math.floor(max)
          if (b < a) return a
          return Math.floor(Math.random() * (b - a + 1)) + a
        }

        const tags = normalizeTags(c.audience_tags)
        if (tags.length === 0) {
          throw new Error(
            'Selecione ao menos um público (tags) nesta campanha antes de ativar.',
          )
        }

        const ordered = [...funnelSteps].sort(
          (a, b) => a.step_order - b.step_order,
        )
        if (ordered.length === 0) {
          throw new Error('Adicione ao menos uma etapa no funil.')
        }

        for (const s of ordered) {
          if (s.media_type !== 'text' && !s.media_url?.trim()) {
            throw new Error(
              `Etapa ${s.step_order}: mídia sem URL. Edite a etapa ou mude o tipo para texto.`,
            )
          }
          if (s.media_type === 'text' && !s.message.trim()) {
            throw new Error(
              `Etapa ${s.step_order}: a mensagem de texto está vazia.`,
            )
          }
        }

        await clearPendingForCampaign(c.id, userId)

        const { data: leadRows, error: leadErr } = await supabase
          .from('leads')
          .select('id, name, phone, tag, extraction_id')
          .eq('user_id', userId)
          .in('tag', tags)

        if (leadErr) {
          throw new Error(leadErr.message)
        }

        type LeadQ = {
          id: string
          name: string
          phone: string | null
          tag: string | null
          extraction_id: string | null
        }
        const rawLeads = (leadRows ?? []) as LeadQ[]
        const byId = new Map<string, LeadQ>()
        for (const l of rawLeads) {
          if (!byId.has(l.id)) byId.set(l.id, l)
        }
        const withPhone = [...byId.values()].filter((l) => phoneDigitsForQueue(l.phone))

        if (withPhone.length === 0) {
          throw new Error(
            'Não há leads com telefone válido para o público selecionado. Confira o CRM ou a extração.',
          )
        }

        const exIds = [
          ...new Set(
            withPhone.map((l) => l.extraction_id).filter(Boolean),
          ),
        ] as string[]
        const locByEx = new Map<string, string>()
        if (exIds.length > 0) {
          const { data: extData, error: extErr } = await supabase
            .from('lead_extractions')
            .select('id, location')
            .in('id', exIds)
            .eq('user_id', userId)
          if (extErr) {
            throw new Error(extErr.message)
          }
          for (const row of (extData ?? []) as { id: string; location: string | null }[]) {
            if (row.location) locByEx.set(row.id, row.location)
          }
        }

        const now = Date.now()
        let startMs: number
        if (c.scheduled_start_at) {
          const planned = new Date(c.scheduled_start_at).getTime()
          if (!Number.isNaN(planned) && planned > now) {
            startMs = planned
          } else {
            startMs = now
          }
        } else {
          startMs = now
        }
        const rows: Record<string, unknown>[] = []

        // Anti-ban (isca): espaça os leads com delay cumulativo aleatório.
        // Ex.: lead1 now+5s, lead2 now+15s, lead3 now+28s...
        let cumulativeMs = 0
        const minS = Math.max(0, Number(c.min_delay_seconds) || 0)
        const maxS = Math.max(minS, Number(c.max_delay_seconds) || 0)

        for (const lead of withPhone) {
          const loc = lead.extraction_id
            ? locByEx.get(lead.extraction_id) ?? null
            : null
          const vars: TemplateVars = {
            nome: firstNameFromFullName(lead.name),
            empresa: lead.name.trim() || 'sua empresa',
            cidade: cityFromExtractionLocation(loc),
          }

          // ISCA ATIVA: ao adicionar lead na campanha (ativar), agenda APENAS a etapa 1 automaticamente.
          const step1 = ordered[0]!
          cumulativeMs += pickRandomIntInclusive(minS, maxS) * 1000
          const scheduledAt = new Date(startMs + cumulativeMs).toISOString()
          const rawMsg = step1.message ?? ''
          const messageBody = applyMessageTemplate(rawMsg, vars)
          const ct = step1.media_type
          const mUrl = ct === 'text' ? null : step1.media_url?.trim() ?? null

          rows.push({
            user_id: userId,
            lead_id: lead.id,
            zv_campaign_id: c.id,
            zv_funnel_step_id: step1.id,
            is_active: true,
            recipient_type: 'personal',
            content_type: ct,
            message_body: messageBody || null,
            media_url: mUrl,
            scheduled_at: scheduledAt,
            status: 'pending',
            recipient_phone: lead.phone,
            // Snapshot anti-ban (campanha). Etapas temporizadas podem sobrescrever no backend.
            min_delay_seconds: c.min_delay_seconds,
            max_delay_seconds: c.max_delay_seconds,
          })

          // Cria/atualiza progresso (modo conversacional).
          await supabase
            .from('lead_campaign_progress')
            .upsert(
              {
                user_id: userId,
                lead_id: lead.id,
                campaign_id: c.id,
                next_step_order: 2,
                total_steps: ordered.length,
                status: ordered.length === 1 ? 'awaiting_last_send' : 'active',
              },
              { onConflict: 'user_id,lead_id,campaign_id' },
            )

          // trava IA por uma janela grande; worker libera ao concluir.
          const lockUntilIso = new Date(startMs + 6 * 60 * 60 * 1000).toISOString()
          await supabase
            .from('leads')
            .update({ funnel_locked_until: lockUntilIso })
            .eq('id', lead.id)
            .eq('user_id', userId)
        }

        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const batch = rows.slice(i, i + INSERT_CHUNK)
          const { error: insErr } = await supabase
            .from('scheduled_messages')
            .insert(batch)
          if (insErr) {
            throw new Error(`Fila: ${insErr.message}`)
          }
        }

        const { error: upErr } = await supabase
          .from('zv_campaigns')
          .update({ status: 'active' as CampaignStatus })
          .eq('id', c.id)
        if (upErr) {
          throw new Error(upErr.message)
        }

        setCampaigns((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, status: 'active' as const } : x)),
        )
        const total = rows.length
        const nLeads = withPhone.length
        const inicioFila =
          startMs > now
            ? ` A fila começa em ${formatDateBr(new Date(startMs).toISOString())}.`
            : ''
        setSuccess(
          `Campanha ativa: ${total} disparo(s) de isca (Etapa 1) agendado(s) para ${nLeads} lead${
            nLeads === 1 ? '' : 's'
          }. As próximas etapas dependem do Tipo de avanço (Resposta / Gatilho exato / Temporizado).${inicioFila}`,
        )
        window.setTimeout(() => setSuccess(null), 8000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setActivating(false)
      }
    },
    [userId, clearPendingForCampaign],
  )

  const pauseCampaign = useCallback(
    async (c: Campaign) => {
      if (!userId) return
      setActivating(true)
      setError(null)
      try {
        await unlockLeadsForCampaign(c.id, userId)
        await clearPendingForCampaign(c.id, userId)
        const { error: e } = await supabase
          .from('zv_campaigns')
          .update({ status: 'paused' as CampaignStatus })
          .eq('id', c.id)
        if (e) {
          setError(e.message)
          return
        }
        setCampaigns((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, status: 'paused' as const } : x)),
        )
        setSuccess(
          'Campanha pausada. Agendamentos pendentes desta campanha foram cancelados.',
        )
        window.setTimeout(() => setSuccess(null), 6000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setActivating(false)
      }
    },
    [userId, clearPendingForCampaign, unlockLeadsForCampaign],
  )

  const completeCampaign = useCallback(
    async (c: Campaign) => {
      if (!userId) return
      setActivating(true)
      setError(null)
      try {
        await unlockLeadsForCampaign(c.id, userId)
        await clearPendingForCampaign(c.id, userId)
        const { error: e } = await supabase
          .from('zv_campaigns')
          .update({ status: 'completed' as CampaignStatus })
          .eq('id', c.id)
        if (e) {
          setError(e.message)
          return
        }
        setCampaigns((prev) =>
          prev.map((x) =>
            x.id === c.id ? { ...x, status: 'completed' as const } : x,
          ),
        )
        setSuccess(
          'Campanha concluída. Agendamentos pendentes desta campanha foram cancelados.',
        )
        window.setTimeout(() => setSuccess(null), 6000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setActivating(false)
      }
    },
    [userId, clearPendingForCampaign, unlockLeadsForCampaign],
  )

  const deleteCampaign = useCallback(
    async (id: string) => {
      if (!confirm('Excluir esta campanha e todas as suas etapas? Essa ação não tem volta.')) {
        return
      }
      const { error: e } = await supabase.from('zv_campaigns').delete().eq('id', id)
      if (e) {
        setError(`Falha ao excluir: ${e.message}`)
        return
      }
      setCampaigns((prev) => {
        const next = prev.filter((c) => c.id !== id)
        setSelectedId((sel) => {
          if (sel !== id) return sel
          return next[0]?.id ?? null
        })
        return next
      })
    },
    [],
  )

  // -------------------------------------------------------------------------
  // Mutations: etapas (funil)
  // -------------------------------------------------------------------------

  const addStep = useCallback(async () => {
    if (!selected) return
    const nextOrder = (steps[steps.length - 1]?.step_order ?? 0) + 1
    const { data, error: e } = await supabase
      .from('zv_funnels')
      .insert({
        campaign_id: selected.id,
        step_order: nextOrder,
        message: '',
        media_type: 'text',
        media_url: null,
        delay_seconds: 0,
        expected_trigger: null,
        advance_type: 'auto',
        min_delay_seconds: null,
        max_delay_seconds: null,
      })
      .select(
        'id, campaign_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds, created_at, updated_at',
      )
      .single()
    if (e || !data) {
      setError(`Falha ao adicionar etapa: ${e?.message ?? 'desconhecido'}`)
      return
    }
    setSteps((prev) => [...prev, data as FunnelStep])
  }, [selected, steps])

  const saveStep = useCallback(
    async (
      stepId: string,
      patch: Partial<
        Pick<
          FunnelStep,
          'message' | 'media_type' | 'media_url' | 'delay_seconds' | 'expected_trigger' | 'advance_type'
        >
      >,
    ) => {
      setSavingStepId(stepId)
      const { error: e } = await supabase
        .from('zv_funnels')
        .update(patch)
        .eq('id', stepId)
      setSavingStepId(null)
      if (e) {
        setError(`Falha ao salvar etapa: ${e.message}`)
        return
      }
      setSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
      )
    },
    [],
  )

  const deleteStep = useCallback(async (stepId: string) => {
    const { error: e } = await supabase.from('zv_funnels').delete().eq('id', stepId)
    if (e) {
      setError(`Falha ao excluir etapa: ${e.message}`)
      return
    }
    setSteps((prev) => prev.filter((s) => s.id !== stepId))
  }, [])

  const moveStep = useCallback(
    async (stepId: string, direction: -1 | 1) => {
      const idx = steps.findIndex((s) => s.id === stepId)
      if (idx === -1) return
      const swap = idx + direction
      if (swap < 0 || swap >= steps.length) return
      const a = steps[idx]
      const b = steps[swap]

      // Truque para evitar conflito do unique(campaign_id, step_order):
      // primeiro joga `a` para um valor temporário, depois ajusta os dois.
      const tempOrder = -1 - idx
      await supabase
        .from('zv_funnels')
        .update({ step_order: tempOrder })
        .eq('id', a.id)
      await supabase
        .from('zv_funnels')
        .update({ step_order: a.step_order })
        .eq('id', b.id)
      await supabase
        .from('zv_funnels')
        .update({ step_order: b.step_order })
        .eq('id', a.id)

      setSteps((prev) => {
        const next = prev.slice()
        const aIdx = next.findIndex((s) => s.id === a.id)
        const bIdx = next.findIndex((s) => s.id === b.id)
        if (aIdx === -1 || bIdx === -1) return next
        const aOrder = next[aIdx].step_order
        next[aIdx] = { ...next[aIdx], step_order: next[bIdx].step_order }
        next[bIdx] = { ...next[bIdx], step_order: aOrder }
        return next.sort((x, y) => x.step_order - y.step_order)
      })
    },
    [steps],
  )

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Toasts */}
      <div className="space-y-3">
        {success ? (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 shadow-sm ring-1 ring-emerald-100"
          >
            {success}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900 shadow-sm ring-1 ring-rose-100"
          >
            {error}
          </div>
        ) : null}
      </div>

      {/* Cabeçalho */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            Campanhas Zap Voice
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600">
            {mainTab === 'campanhas'
              ? 'Funis, agendamento de início, gatilhos do Meta (respostas rápidas) e tráfego pago — tudo no mesmo fluxo.'
              : mainTab === 'contatos'
                ? 'Unifique e limpe a base: importe CSV, Google Contacts e acompanhe origens como no Google Contacts.'
                : 'Visualize campanhas concluídas: data do primeiro disparo e quantos leads receberam mensagens agendadas.'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-zinc-200/90">
        <button
          type="button"
          onClick={() => {
            setMainTab('campanhas')
            window.location.hash = ''
          }}
          className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
            mainTab === 'campanhas'
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <ListTodo className="h-4 w-4" aria-hidden />
          Campanhas ativas
        </button>
        <button
          type="button"
          onClick={() => {
            setMainTab('contatos')
            window.location.hash = '#contatos'
          }}
          className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
            mainTab === 'contatos'
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <LayoutGrid className="h-4 w-4" aria-hidden />
          Base de contatos
        </button>
        <button
          type="button"
          onClick={() => {
            setMainTab('historico')
            window.location.hash = '#historico'
          }}
          className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
            mainTab === 'historico'
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <History className="h-4 w-4" aria-hidden />
          Histórico de campanhas
        </button>
      </div>

      {mainTab === 'contatos' && userId ? (
        <ContactsBasePanel
          userId={userId}
          onContactsChanged={() => {
            if (userId) void loadAudienceOptions(userId)
          }}
          onError={setError}
          onSuccess={setSuccess}
        />
      ) : null}

      {/* Painel duplo: funis (rascunho, ativa, pausada) */}
      {mainTab === 'campanhas' ? (
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* COLUNA ESQUERDA: lista de campanhas */}
        <aside className="rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-sm ring-1 ring-zinc-100/80">
          <div className="flex items-center justify-between gap-2 px-1 pb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Rascunho, ativa e pausada
            </p>
            <span className="text-xs tabular-nums text-zinc-400">
              {activeCampaigns.length}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setNewOpen((v) => !v)}
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 via-brand-700 to-brand-700 px-4 py-3 text-sm font-bold text-white shadow-[0_10px_32px_rgba(106,0,184,0.35)] transition hover:from-brand-500 hover:to-brand-600"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Nova Campanha de Disparo
          </button>

          {newOpen ? (
            <div className="mt-4 space-y-3 rounded-xl border border-brand-200/70 bg-brand-50/30 p-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Nome
                </label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Black Friday Petshops SC"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Público (uma ou mais tags)
                </label>
                <TagMultiPicker
                  options={audienceOptions}
                  value={newAudienceTags}
                  onChange={setNewAudienceTags}
                  customHint="O disparo inclui qualquer lead cuja tag estiver marcada (lógica OU). Tags vêm do Extrator, CSV ou Google."
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Descrição (opcional)
                </label>
                <input
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Curta, objetiva — só pra você lembrar."
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Agendar início para
                </label>
                <input
                  type="datetime-local"
                  value={newScheduledStartLocal}
                  onChange={(e) => setNewScheduledStartLocal(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Opcional. Se vazio, ao ativar a campanha a fila começa na hora. Se
                  preenchida no futuro, os atrasos do funil somam a partir deste
                  instante.
                </p>
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-zinc-700">
                  Gatilhos de entrada (Meta Ads)
                </p>
                <PhraseChipsInput
                  value={newInboundTriggers}
                  onChange={setNewInboundTriggers}
                  help="Se um lead enviar uma destas mensagens exatas (vindas do seu anúncio), ele entrará automaticamente neste funil. (A automação de roteamento no WhatsApp entra em uma próxima etapa de backend.)"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void createCampaign()}
                  disabled={creating}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Criar
                </button>
                <button
                  type="button"
                  onClick={() => setNewOpen(false)}
                  className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}

          {/* Lista */}
          <div className="mt-5 space-y-2">
            {loading ? (
              <p className="px-1 text-sm text-zinc-500">Carregando…</p>
            ) : activeCampaigns.length === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-6 text-center text-xs text-zinc-500">
                {campaigns.length === 0
                  ? 'Você ainda não tem campanhas. Crie a primeira no botão acima.'
                  : 'Não há campanhas em rascunho, ativas ou pausadas. As concluídas ficam em Histórico.'}
              </p>
            ) : (
              activeCampaigns.map((c) => {
                const visual = statusVisual[c.status]
                const active = c.id === selectedId
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={`group flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition ${
                      active
                        ? 'border-brand-300 bg-gradient-to-br from-brand-50 to-white shadow-sm ring-1 ring-brand-100'
                        : 'border-zinc-200 bg-white hover:border-brand-200 hover:bg-brand-50/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`line-clamp-1 text-sm font-semibold ${
                          active ? 'text-brand-800' : 'text-zinc-800'
                        }`}
                      >
                        {c.name}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${visual.pill}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${visual.dot}`} />
                        {visual.label}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-500">
                      <span className="line-clamp-2">
                        {c.audience_tags && c.audience_tags.length > 0
                          ? c.audience_tags.join(' · ')
                          : 'Sem tag'}
                      </span>
                      <span className="tabular-nums">{formatDateBr(c.created_at)}</span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        {/* COLUNA DIREITA: editor de funil */}
        <section className="space-y-5">
          {!selected ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 shadow-sm">
              Selecione uma campanha à esquerda — ou crie a primeira para
              começar a montar o funil.
            </div>
          ) : (
            <>
              {/* Header da campanha */}
              <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm ring-1 ring-zinc-100/80">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-700 ring-1 ring-brand-100">
                        <Megaphone className="h-3 w-3" aria-hidden />
                        Campanha
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${statusVisual[selected.status].pill}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${statusVisual[selected.status].dot}`}
                        />
                        {statusVisual[selected.status].label}
                      </span>
                    </div>
                    <input
                      value={selected.name}
                      onChange={(e) => {
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, name: e.target.value } : c,
                          ),
                        )
                      }}
                      onBlur={(e) =>
                        void updateCampaign(selected.id, { name: e.target.value })
                      }
                      className="w-full bg-transparent text-2xl font-semibold tracking-tight text-zinc-900 outline-none placeholder:text-zinc-400 focus:rounded-lg focus:bg-zinc-50 focus:px-2"
                    />
                    <input
                      value={selected.description ?? ''}
                      onChange={(e) => {
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id
                              ? { ...c, description: e.target.value }
                              : c,
                          ),
                        )
                      }}
                      onBlur={(e) =>
                        void updateCampaign(selected.id, {
                          description: e.target.value || null,
                        })
                      }
                      placeholder="Adicione uma descrição interna…"
                      className="mt-1 w-full bg-transparent text-sm text-zinc-500 outline-none placeholder:text-zinc-400 focus:rounded-lg focus:bg-zinc-50 focus:px-2"
                    />
                  </div>

                  {/* Ações: play/pause/concluir/excluir */}
                  <div className="flex flex-wrap items-center gap-2">
                    {selected.status !== 'active' ? (
                      <button
                        type="button"
                        onClick={() => void activateCampaign(selected, steps)}
                        disabled={activating}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {activating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Play className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Ativar
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void pauseCampaign(selected)}
                        disabled={activating}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {activating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Pause className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Pausar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void completeCampaign(selected)}
                      disabled={activating}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      Concluir
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteCampaign(selected.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Excluir
                    </button>
                  </div>
                </div>

                {/* Linha de configurações + público */}
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 sm:col-span-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Users className="h-3 w-3" aria-hidden />
                      Público (tags em OR)
                    </p>
                    <div className="mt-1.5">
                      <TagMultiPicker
                        options={audienceOptions}
                        value={tagsForSelected}
                        onChange={(next) => {
                          setCampaigns((prev) =>
                            prev.map((c) =>
                              c.id === selected.id ? { ...c, audience_tags: next } : c,
                            ),
                          )
                          void updateCampaign(selected.id, { audience_tags: next })
                        }}
                        customHint="Leads com qualquer uma das tags entram no disparo (duplicados por telefone são unificados)."
                      />
                    </div>
                    <p className="mt-2 text-[11px] font-medium text-zinc-700">
                      <span className="tabular-nums text-brand-700">
                        {audienceReachCount ?? '—'}
                      </span>{' '}
                      lead{(audienceReachCount ?? 0) === 1 ? '' : 's'} com essas tags
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Clock className="h-3 w-3" aria-hidden />
                      Delay aleatório (anti-ban)
                    </p>
                    <div className="mt-1.5 grid grid-cols-[1fr_1fr] gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-zinc-600">Mín</span>
                        <input
                          type="number"
                          min={0}
                          value={selected.min_delay_seconds}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0)
                            setCampaigns((prev) =>
                              prev.map((c) =>
                                c.id === selected.id
                                  ? {
                                      ...c,
                                      min_delay_seconds: v,
                                      max_delay_seconds: Math.max(v, c.max_delay_seconds),
                                    }
                                  : c,
                              ),
                            )
                          }}
                          onBlur={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0)
                            void updateCampaign(selected.id, {
                              min_delay_seconds: v,
                              max_delay_seconds: Math.max(v, selected.max_delay_seconds),
                            })
                          }}
                          className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-zinc-600">Máx</span>
                        <input
                          type="number"
                          min={0}
                          value={selected.max_delay_seconds}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0)
                            setCampaigns((prev) =>
                              prev.map((c) =>
                                c.id === selected.id
                                  ? { ...c, max_delay_seconds: Math.max(v, c.min_delay_seconds) }
                                  : c,
                              ),
                            )
                          }}
                          onBlur={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0)
                            void updateCampaign(selected.id, {
                              max_delay_seconds: Math.max(v, selected.min_delay_seconds),
                            })
                          }}
                          className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                        />
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Antes de cada mensagem, o sistema sorteia um valor entre Mín e Máx (segundos).
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Zap className="h-3 w-3" aria-hidden />
                      Etapas
                    </p>
                    <p className="mt-1.5 text-2xl font-semibold tabular-nums text-zinc-900">
                      {steps.length}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {steps.length === 0
                        ? 'Adicione a primeira mensagem do funil.'
                        : 'Arraste para reordenar.'}
                    </p>
                  </div>
                </div>

                <div className="mt-5 space-y-4 border-t border-zinc-100 pt-5">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700">
                      Agendar início para
                    </label>
                    <input
                      type="datetime-local"
                      value={isoToDatetimeLocalValue(selected.scheduled_start_at)}
                      onChange={(e) => {
                        const v = e.target.value
                        const iso = v ? datetimeLocalToIso(v) : null
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, scheduled_start_at: iso } : c,
                          ),
                        )
                      }}
                      onBlur={(e) =>
                        void updateCampaign(selected.id, {
                          scheduled_start_at: datetimeLocalToIso(e.target.value),
                        })
                      }
                      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Deixe vazio para, ao ativar, começar a fila na hora. Com data/hora
                      no futuro, os atrasos de cada etapa somam a partir desse ponto.
                    </p>
                  </div>
                  <div>
                    <h4 className="mb-1 text-xs font-semibold text-zinc-800">
                      Gatilhos de entrada (Meta Ads)
                    </h4>
                    <PhraseChipsInput
                      value={normalizeInboundTriggers(selected.inbound_triggers)}
                      onChange={(next) => {
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, inbound_triggers: next } : c,
                          ),
                        )
                        void updateCampaign(selected.id, { inbound_triggers: next })
                      }}
                      help="Se um lead enviar uma destas mensagens exatas (vindas do seu anúncio), ele entrará automaticamente neste funil."
                    />
                  </div>
                </div>
              </div>

              {/* Editor de etapas */}
              <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm ring-1 ring-zinc-100/80">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-zinc-900">
                      Funil de mensagens
                    </h3>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      Cada etapa é uma mensagem WhatsApp na ordem do roteiro.
                      Use variáveis como{' '}
                      {MESSAGE_VARIABLES.map((v, i) => (
                        <span key={v.key}>
                          <code className="rounded bg-zinc-100 px-1 font-mono text-[10px] text-brand-700">
                            {v.key}
                          </code>
                          {i < MESSAGE_VARIABLES.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                      .
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void addStep()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800 transition hover:bg-brand-100"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Adicionar etapa
                  </button>
                </div>

                {stepsLoading ? (
                  <p className="text-sm text-zinc-500">Carregando etapas…</p>
                ) : steps.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-10 text-center text-sm text-zinc-500">
                    <CircleSlash className="mx-auto mb-2 h-5 w-5 text-zinc-400" aria-hidden />
                    Funil vazio. Clique em "Adicionar etapa" para começar.
                  </div>
                ) : (
                  <ol className="space-y-4">
                    {steps.map((step, idx) => (
                      <li key={step.id}>
                        <StepCard
                          step={step}
                          userId={userId}
                          index={idx + 1}
                          isLast={idx === steps.length - 1}
                          isFirst={idx === 0}
                          saving={savingStepId === step.id}
                          onSave={(patch) => void saveStep(step.id, patch)}
                          onDelete={() => void deleteStep(step.id)}
                          onMoveUp={() => void moveStep(step.id, -1)}
                          onMoveDown={() => void moveStep(step.id, 1)}
                        />
                        {idx < steps.length - 1 ? (
                          <div className="my-1 flex items-center justify-center">
                            <ArrowDown className="h-4 w-4 text-zinc-300" aria-hidden />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </section>
      </div>
      ) : null}

      {mainTab === 'historico' ? (
        <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-sm ring-1 ring-zinc-100/80">
          {completedCampaigns.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-zinc-500">
              Ainda não há campanhas concluídas. Quando marcar uma campanha como
              concluída, ela aparece aqui com a data do primeiro disparo e a base
              alcançada.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50/90 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    <th className="px-4 py-3">Campanha</th>
                    <th className="px-4 py-3">Público (tags)</th>
                    <th className="px-4 py-3">1º disparo (agendado)</th>
                    <th className="px-4 py-3">Leads</th>
                    <th className="px-4 py-3">Concluída em</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {completedCampaigns.map((c) => {
                    const st = historyStats[c.id]
                    return (
                      <tr key={c.id} className="bg-white hover:bg-zinc-50/50">
                        <td className="px-4 py-3 font-medium text-zinc-900">{c.name}</td>
                        <td className="max-w-[220px] px-4 py-3 text-zinc-600">
                          {c.audience_tags && c.audience_tags.length > 0
                            ? c.audience_tags.join(' · ')
                            : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-600 tabular-nums">
                          {st?.firstAt ? formatDateBr(st.firstAt) : '—'}
                        </td>
                        <td className="px-4 py-3 text-zinc-800 tabular-nums">
                          {st ? st.leadCount : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-500 tabular-nums">
                          {formatDateBr(c.updated_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card de etapa (componente local)
// ---------------------------------------------------------------------------

const MEDIA_TYPE_OPTIONS: {
  value: FunnelMediaType
  label: string
  icon: typeof MessageSquare
}[] = [
  { value: 'text', label: 'Texto', icon: MessageSquare },
  { value: 'image', label: 'Foto', icon: ImageIcon },
  { value: 'video', label: 'Vídeo', icon: Video },
  { value: 'audio', label: 'Áudio', icon: Mic },
  { value: 'document', label: 'Arquivo', icon: FileText },
]

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'arquivo'
}

type StepCardProps = {
  step: FunnelStep
  userId: string | null
  index: number
  isFirst: boolean
  isLast: boolean
  saving: boolean
  onSave: (
    patch: Partial<
      Pick<
        FunnelStep,
        'message' | 'media_type' | 'media_url' | 'delay_seconds' | 'expected_trigger' | 'advance_type'
      >
    >,
  ) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function StepCard({
  step,
  userId,
  index,
  isFirst,
  isLast,
  saving,
  onSave,
  onDelete,
  onMoveUp,
  onMoveDown,
}: StepCardProps) {
  const [message, setMessage] = useState(step.message)
  const [mediaType, setMediaType] = useState<FunnelMediaType>(step.media_type)
  const [mediaUrl, setMediaUrl] = useState(step.media_url ?? '')
  const [delaySeconds, setDelaySeconds] = useState(step.delay_seconds)
  const [trigger, setTrigger] = useState(step.expected_trigger ?? '')
  const [advanceType, setAdvanceType] = useState<'auto' | 'exact' | 'timer'>(
    (step.advance_type ?? 'auto') as 'auto' | 'exact' | 'timer',
  )
  const [stepMinDelay, setStepMinDelay] = useState<number>(
    typeof step.min_delay_seconds === 'number' ? step.min_delay_seconds : 2,
  )
  const [stepMaxDelay, setStepMaxDelay] = useState<number>(
    typeof step.max_delay_seconds === 'number' ? step.max_delay_seconds : 15,
  )
  const [uploading, setUploading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    setMessage(step.message)
    setMediaType(step.media_type)
    setMediaUrl(step.media_url ?? '')
    setDelaySeconds(step.delay_seconds)
    setTrigger(step.expected_trigger ?? '')
    setAdvanceType((step.advance_type ?? 'auto') as 'auto' | 'exact' | 'timer')
    setStepMinDelay(typeof step.min_delay_seconds === 'number' ? step.min_delay_seconds : 2)
    setStepMaxDelay(typeof step.max_delay_seconds === 'number' ? step.max_delay_seconds : 15)
  }, [
    step.id,
    step.message,
    step.media_type,
    step.media_url,
    step.delay_seconds,
    step.expected_trigger,
    step.advance_type,
    step.min_delay_seconds,
    step.max_delay_seconds,
  ])

  const mediaNeedsUrl = mediaType !== 'text'
  const dirty =
    message !== step.message ||
    mediaType !== step.media_type ||
    (mediaUrl || '').trim() !== (step.media_url ?? '').trim() ||
    delaySeconds !== step.delay_seconds ||
    (trigger || '') !== (step.expected_trigger ?? '') ||
    (advanceType || 'auto') !== ((step.advance_type ?? 'auto') as 'auto' | 'exact' | 'timer') ||
    (advanceType === 'timer' &&
      (stepMinDelay !== (typeof step.min_delay_seconds === 'number' ? step.min_delay_seconds : 2) ||
        stepMaxDelay !== (typeof step.max_delay_seconds === 'number' ? step.max_delay_seconds : 15)))

  const handlePickMediaType = (next: FunnelMediaType) => {
    setLocalError(null)
    setMediaType(next)
    if (next === 'text') {
      setMediaUrl('')
    }
  }

  const handleUpload: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !userId) {
      if (!userId) setLocalError('Faça login para enviar arquivos.')
      return
    }
    setLocalError(null)
    setUploading(true)
    const path = `${userId}/${Date.now()}_${sanitizeFileName(file.name)}`
    const { error: upErr } = await supabase.storage
      .from('campaign_media')
      .upload(path, file, { upsert: true, cacheControl: '3600' })
    if (upErr) {
      setLocalError(`Upload: ${upErr.message}`)
      setUploading(false)
      return
    }
    const { data: pub } = supabase.storage.from('campaign_media').getPublicUrl(path)
    setMediaUrl(pub.publicUrl)
    setUploading(false)
  }

  const handleSaveClick = () => {
    setLocalError(null)
    if (mediaNeedsUrl && !mediaUrl.trim()) {
      setLocalError('Informe a URL da mídia ou faça upload (tipos de imagem, vídeo, áudio e arquivo exigem link público).')
      return
    }
    if (advanceType === 'exact' && index !== 1 && !trigger.trim()) {
      setLocalError('Para “gatilho exato”, preencha o Gatilho esperado.')
      return
    }
    if (advanceType === 'timer' && index !== 1) {
      if (!Number.isFinite(stepMinDelay) || !Number.isFinite(stepMaxDelay)) {
        setLocalError('Delay mínimo/máximo inválido.')
        return
      }
      if (stepMinDelay < 0 || stepMaxDelay < 0 || stepMaxDelay < stepMinDelay) {
        setLocalError('Delay mínimo/máximo precisa ser >= 0 e Máx >= Mín.')
        return
      }
    }
    if (index === 1) {
      // Passo 1 sempre depende do gatilho da campanha; não usa advance_type/expected_trigger do step.
      setAdvanceType('auto')
      setTrigger('')
    }
    onSave({
      message,
      media_type: mediaType,
      media_url: mediaType === 'text' ? null : mediaUrl.trim() || null,
      delay_seconds: delaySeconds,
      expected_trigger: index === 1 ? null : trigger.trim() || null,
      advance_type: index === 1 ? 'auto' : advanceType,
      min_delay_seconds: index === 1 ? null : advanceType === 'timer' ? stepMinDelay : null,
      max_delay_seconds: index === 1 ? null : advanceType === 'timer' ? stepMaxDelay : null,
    })
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-white via-white to-brand-50/30 shadow-sm ring-1 ring-zinc-100">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-brand-700 text-[11px] font-bold text-white shadow-sm">
            {index}
          </span>
          <span className="text-sm font-semibold text-zinc-800">
            {index === 1 ? 'Mensagem inicial' : `Etapa ${index}`}
          </span>
          {saving ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-brand-700">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> salvando…
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            title="Subir"
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            title="Descer"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-rose-500 transition hover:bg-rose-50"
            title="Excluir etapa"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Tipo de mensagem
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MEDIA_TYPE_OPTIONS.map(({ value, label, icon: Icon }) => {
                const on = mediaType === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handlePickMediaType(value)}
                    title={label}
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border text-zinc-600 transition ${
                      on
                        ? 'border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-200'
                        : 'border-zinc-200 bg-white hover:border-zinc-300'
                    }`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    <span className="sr-only">{label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {mediaNeedsUrl ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Mídia (URL pública)
              </p>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                Cole um link acessível sem login ou envie do seu computador (bucket
                `campaign_media`).
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  value={mediaUrl}
                  onChange={(e) => {
                    setLocalError(null)
                    setMediaUrl(e.target.value)
                  }}
                  placeholder="https://…"
                  className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50/50 px-2.5 py-2 text-xs text-zinc-900 shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
                <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50">
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Enviar arquivo
                  <input
                    type="file"
                    className="sr-only"
                    accept={
                      mediaType === 'image'
                        ? 'image/*'
                        : mediaType === 'video'
                          ? 'video/*'
                          : mediaType === 'audio'
                            ? 'audio/*'
                            : mediaType === 'document'
                              ? '.pdf,.doc,.docx,.xls,.xlsx,.zip'
                              : '*/*'
                    }
                    onChange={handleUpload}
                    disabled={uploading || !userId}
                  />
                </label>
              </div>
              {mediaUrl.trim() && (mediaType === 'image' || mediaType === 'video') ? (
                <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
                  {mediaType === 'image' ? (
                    <img
                      src={mediaUrl}
                      alt="Prévia da mídia"
                      className="max-h-40 w-full object-contain"
                      onError={() => setLocalError('Não foi possível carregar a prévia (verifique a URL).')}
                    />
                  ) : (
                    <video
                      src={mediaUrl}
                      className="max-h-40 w-full object-contain"
                      controls
                      muted
                      playsInline
                    />
                  )}
                </div>
              ) : null}
              {mediaUrl.trim() && (mediaType === 'audio' || mediaType === 'document') ? (
                <p className="mt-2 truncate text-[10px] text-zinc-600" title={mediaUrl}>
                  {mediaType === 'audio' ? 'Áudio' : 'Documento'}: {mediaUrl.slice(0, 80)}
                  {mediaUrl.length > 80 ? '…' : ''}
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <MessageSquare className="h-3 w-3" aria-hidden />
              {mediaType === 'text' ? 'Mensagem' : 'Legenda (opcional)'}
            </label>
            <textarea
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                mediaType === 'text'
                  ? 'Olá {nome}, tudo bem? Aqui é da equipe…'
                  : 'Texto que acompanha a mídia (caption)…'
              }
              className="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-zinc-900 shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {MESSAGE_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setMessage((prev) => `${prev}${v.key}`)}
                  title={v.helper}
                  className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand-700 transition hover:border-brand-300 hover:bg-brand-50"
                >
                  {v.key}
                </button>
              ))}
            </div>
          </div>
          {localError ? (
            <p className="text-xs font-medium text-rose-600" role="alert">
              {localError}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <Clock className="h-3 w-3" aria-hidden />
              Delay até disparar
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={delaySeconds}
                onChange={(e) =>
                  setDelaySeconds(Math.max(0, Number(e.target.value) || 0))
                }
                className="w-24 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <span className="text-xs text-zinc-500">segundos</span>
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">
              {index === 1
                ? '0 = manda assim que iniciar a campanha.'
                : 'Tempo desde a etapa anterior.'}
            </p>
          </div>

          {index === 1 ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Tipo de avanço
              </p>
              <p className="mt-1 text-[11px] text-zinc-600">
                A 1ª etapa sempre exige a palavra-chave exata do gatilho da campanha.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Tipo de avanço
              </p>
              <div className="mt-2 grid gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="radio"
                    name={`advance-${step.id}`}
                    checked={advanceType === 'auto'}
                    onChange={() => setAdvanceType('auto')}
                  />
                  <span>
                    Avanço automático (qualquer resposta)
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="radio"
                    name={`advance-${step.id}`}
                    checked={advanceType === 'exact'}
                    onChange={() => setAdvanceType('exact')}
                  />
                  <span>
                    Avanço por gatilho exato
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="radio"
                    name={`advance-${step.id}`}
                    checked={advanceType === 'timer'}
                    onChange={() => setAdvanceType('timer')}
                  />
                  <span>
                    Temporizado (sem aguardar resposta)
                  </span>
                </label>
              </div>
              {advanceType === 'timer' ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Delay Mín (s)
                    </p>
                    <input
                      type="number"
                      min={0}
                      value={stepMinDelay}
                      onChange={(e) => {
                        const v = Math.max(0, Number(e.target.value) || 0)
                        setStepMinDelay(v)
                        setStepMaxDelay((prev) => Math.max(prev, v))
                      }}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Delay Máx (s)
                    </p>
                    <input
                      type="number"
                      min={0}
                      value={stepMaxDelay}
                      onChange={(e) => setStepMaxDelay(Math.max(0, Number(e.target.value) || 0))}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                  </div>
                  <p className="col-span-2 mt-1 text-[11px] text-zinc-600">
                    Essa etapa será enfileirada automaticamente assim que a etapa anterior for enviada.
                  </p>
                </div>
              ) : advanceType === 'exact' ? (
                <p className="mt-2 text-[11px] text-zinc-600">
                  Preencha o campo <b>Gatilho esperado</b> abaixo. O lead precisa digitar exatamente essa palavra/frase.
                </p>
              ) : (
                <p className="mt-2 text-[11px] text-zinc-600">
                  O lead avança assim que responder qualquer coisa (texto/legenda/transcrição).
                </p>
              )}
            </div>
          )}

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <Sparkles className="h-3 w-3" aria-hidden />
              Gatilho esperado
            </label>
            <input
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              placeholder="Quero, Saber mais"
              className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p className="mt-1 text-[10px] text-zinc-500">
              {index === 1
                ? 'Não se aplica na 1ª etapa (o gatilho fica na campanha).'
                : advanceType === 'exact'
                  ? 'Obrigatório quando o Tipo de avanço é “gatilho exato”.'
                  : advanceType === 'timer'
                    ? 'Não se aplica no modo temporizado.'
                    : 'Opcional (não é usado no avanço automático).'}
            </p>
          </div>

          <button
            type="button"
            disabled={!dirty || saving}
            onClick={handleSaveClick}
            className={`mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold uppercase tracking-wide shadow-sm transition ${
              dirty
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
            }`}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : dirty ? (
              <Save className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            )}
            {dirty ? 'Salvar etapa' : 'Salvo'}
          </button>
        </div>
      </div>
    </div>
  )
}
