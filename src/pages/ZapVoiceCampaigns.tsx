import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  Copy,
  Megaphone,
  MessageSquare,
  Mic,
  Pencil,
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
import { ZapVoiceReportsTab } from './zapvoice/ZapVoiceReportsTab'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

/** Alinhado ao enum `public.zv_funnel_media_type` (Supabase). */
export type FunnelMediaType = 'text' | 'image' | 'video' | 'audio' | 'document'

export type ZvTriggerCondition = 'equals' | 'contains' | 'starts_with' | 'not_contains'

type ZvFlow = {
  id: string
  user_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

type Campaign = {
  id: string
  user_id: string
  name: string
  description: string | null
  /** Tags de público (OR): o disparo considera qualquer lead com uma delas. */
  audience_tags: string[] | null
  /** Tipo de público: tags | audience | individual */
  audience_type?: 'tags' | 'audience' | 'individual'
  /** Público salvo (zv_audiences.id) quando audience_type=audience */
  audience_id?: string | null
  /** Leads individuais (uuid[]) quando audience_type=individual */
  audience_lead_ids?: string[] | null
  /** Início do funil agendado (futuro); a isca e o fluxo somam atrasos a partir daqui. */
  scheduled_start_at: string | null
  /** Texto da isca (primeiro disparo ativo). */
  isca_message: string
  /** Variações de isca (ex.: 5 opções) para revezar por lead */
  isca_messages?: string[] | null
  /** Regra de comparação com a palavra-chave. */
  trigger_condition: ZvTriggerCondition
  /** Palavra-chave (gatilho). */
  trigger_keyword: string | null
  /** Fluxo de automação (etapas em zv_funnels). */
  flow_id: string | null
  status: CampaignStatus
  min_delay_seconds: number
  max_delay_seconds: number
  created_at: string
  updated_at: string
}

type FunnelStep = {
  id: string
  flow_id: string
  step_order: number
  message: string
  media_type: FunnelMediaType
  media_url: string | null
  delay_seconds: number
  expected_trigger: string | null
  advance_type?: 'auto' | 'exact' | 'timer' | null
  min_delay_seconds?: number | null
  max_delay_seconds?: number | null
  created_at: string
  updated_at: string
}

type AudienceTagOption = { tag: string; count: number }

type ZvAudience = {
  id: string
  name: string
  lead_ids: string[]
}

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

/**
 * Variáveis dinâmicas: isca (agendamento) substitui {nome}/{empresa}/{cidade} ao ativar;
 * demais chaves e envio pós-isca vêm de `user_settings` + data/hora no worker/Edge.
 */
const MESSAGE_VARIABLES: readonly { key: string; helper: string }[] = [
  { key: '{nome}', helper: 'Primeiro nome do lead (também na isca agendada)' },
  { key: '{cidade}', helper: 'Cidade (extração do lead; isca agendada)' },
  { key: '{empresa}', helper: 'Legado: nome exibido ao agendar a isca' },
  { key: '{empresa_nome}', helper: 'Nome da empresa (Configurações → dados da empresa)' },
  { key: '{empresa_endereço}', helper: 'Endereço (Configurações)' },
  { key: '{saudacao_tempo}', helper: 'Bom dia / Boa tarde / Boa noite (fuso de São Paulo)' },
  { key: '{vendedor_nome}', helper: 'Primeiro nome do vendedor (Configurações)' },
  { key: '{telefone_contato}', helper: 'Telefone de contato (Configurações)' },
  { key: '{hoje_data}', helper: 'Data de hoje, dd/mm/aaaa (no envio)' },
  { key: '{dia_semana}', helper: 'Dia da semana por extenso (no envio)' },
  { key: '{hora_atual}', helper: 'Hora atual HH:mm (no envio)' },
  { key: '{cliente_primeiro_nome}', helper: 'Primeiro nome (substituição no envio)' },
  { key: '{cliente_nome}', helper: 'Nome completo (substituição no envio)' },
] as const

function MessageVariableChips(props: {
  variables: readonly { key: string; helper: string }[]
  onInsert: (key: string) => void
  className?: string
}) {
  const { variables, onInsert, className } = props
  return (
    <div
      className={`rounded-xl border border-zinc-100 bg-gradient-to-br from-zinc-50/80 to-brand-50/20 p-2.5 ${className ?? ''}`}
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Variáveis (clique para inserir no fim do texto)
      </p>
      <div className="flex flex-wrap gap-1.5">
        {variables.map((v) => (
          <button
            type="button"
            key={v.key}
            onClick={() => onInsert(v.key)}
            title={v.helper}
            className="inline-flex max-w-full items-center truncate rounded-full border border-brand-200/90 bg-white px-2.5 py-1 text-[10px] font-mono font-semibold text-brand-800 shadow-sm transition hover:border-brand-400 hover:bg-brand-50/90"
          >
            {v.key}
          </button>
        ))}
      </div>
    </div>
  )
}

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
  const [flows, setFlows] = useState<ZvFlow[]>([])
  const [voiceSubTab, setVoiceSubTab] = useState<'campanhas' | 'fluxos' | 'relatorios'>(
    'campanhas',
  )
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  const [audienceOptions, setAudienceOptions] = useState<AudienceTagOption[]>([])
  const [savedAudiences, setSavedAudiences] = useState<ZvAudience[]>([])
  const [leadPickerOpen, setLeadPickerOpen] = useState(false)
  const [leadPickerBusy, setLeadPickerBusy] = useState(false)
  const [leadPickerQuery, setLeadPickerQuery] = useState('')
  const [leadPickerRows, setLeadPickerRows] = useState<Array<{ id: string; name: string; phone: string | null; tag: string | null }>>([])

  const [steps, setSteps] = useState<FunnelStep[]>([])
  const [stepsLoading, setStepsLoading] = useState(false)
  const [savingStepId, setSavingStepId] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  /** Evita duplo clique / StrictMode duplicar isca antes do React atualizar `activating`. */
  const activateInFlightRef = useRef(false)

  // form de "Nova Campanha"
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAudienceTags, setNewAudienceTags] = useState<string[]>([])
  const [newDescription, setNewDescription] = useState('')
  const [newScheduledStartLocal, setNewScheduledStartLocal] = useState('')
  const [newIscaMessage, setNewIscaMessage] = useState(
    'Olá {nome}, tudo bem? Aqui é da equipe Zapifica…',
  )
  const [newIscas, setNewIscas] = useState<string[]>([
    'Olá {nome}, tudo bem? Aqui é da equipe Zapifica…',
    'Oi {nome}! Tudo certo? Só confirmando uma coisa rapidinho…',
    'Olá! Esse WhatsApp é o contato certo pra falar com você?',
    'Oi! Posso te fazer uma pergunta rápida? 🙂',
    'Olá {nome}! Vi seu contato e queria confirmar uma informação.',
  ])
  const [newTriggerCondition, setNewTriggerCondition] = useState<ZvTriggerCondition>('equals')
  const [newTriggerKeyword, setNewTriggerKeyword] = useState('')
  /** Fluxo existente (`zv_flows`) vinculado à nova campanha — nunca criar fluxo ao criar campanha. */
  const [newCampaignFlowId, setNewCampaignFlowId] = useState('')
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

  const selectedFlow = useMemo(
    () => flows.find((f) => f.id === selectedFlowId) ?? null,
    [flows, selectedFlowId],
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

  const loadSavedAudiences = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('zv_audiences')
      .select('id, name, lead_ids')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) {
      console.error('[ZapVoiceCampaigns] zv_audiences:', error.message)
      setSavedAudiences([])
      return
    }
    setSavedAudiences((data ?? []) as ZvAudience[])
  }, [])

  const ensureLeadPickerRows = useCallback(async (uid: string) => {
    if (leadPickerRows.length > 0) return
    setLeadPickerBusy(true)
    try {
      const { data, error } = await supabase
        .from('leads')
        .select('id, name, phone, tag')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(1200)
      if (error) {
        console.warn('[ZapVoiceCampaigns] lead picker leads:', error.message)
        setLeadPickerRows([])
        return
      }
      setLeadPickerRows((data ?? []) as any)
    } finally {
      setLeadPickerBusy(false)
    }
  }, [leadPickerRows.length])

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

  const loadFlows = useCallback(async (uid: string) => {
    const { data, error: e } = await supabase
      .from('zv_flows')
      .select('id, user_id, name, description, created_at, updated_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
    if (e) {
      console.error('[ZapVoiceCampaigns] flows:', e.message)
      return
    }
    setFlows((data ?? []) as ZvFlow[])
  }, [])

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
        'id, user_id, name, description, audience_tags, audience_type, audience_id, audience_lead_ids, scheduled_start_at, isca_message, isca_messages, trigger_condition, trigger_keyword, flow_id, status, min_delay_seconds, max_delay_seconds, created_at, updated_at',
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
        audience_type?: string | null
        audience_id?: string | null
        audience_lead_ids?: string[] | null
        trigger_keyword?: string | null
        scheduled_start_at?: string | null
        isca_message?: string | null
        isca_messages?: string[] | null
        trigger_condition?: ZvTriggerCondition | null
        flow_id?: string | null
      }
      const kw = (c.trigger_keyword ?? '').trim()
      return {
        ...(r as Campaign),
        audience_tags: normalizeTags(c.audience_tags),
        audience_type: (c.audience_type ?? 'tags') as any,
        audience_id: c.audience_id ?? null,
        audience_lead_ids: (c.audience_lead_ids ?? []) as string[],
        trigger_keyword: kw || null,
        isca_message: (c.isca_message ?? '').trim() || '',
        isca_messages: (c.isca_messages ?? null) as string[] | null,
        trigger_condition: (c.trigger_condition ?? 'equals') as ZvTriggerCondition,
        flow_id: (c.flow_id ?? null) as string | null,
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
    await loadSavedAudiences(user.id)
    await loadFlows(user.id)
    setLoading(false)
  }, [loadAudienceOptions, loadSavedAudiences, loadFlows])

  const loadSteps = useCallback(async (flowId: string) => {
    setStepsLoading(true)
    const { data, error: e } = await supabase
      .from('zv_funnels')
      .select(
        'id, flow_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds, created_at, updated_at',
      )
      .eq('flow_id', flowId)
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
    if (mainTab !== 'campanhas' || voiceSubTab !== 'fluxos' || !selectedFlowId) {
      if (mainTab !== 'campanhas' || voiceSubTab !== 'fluxos') setSteps([])
      return
    }
    void loadSteps(selectedFlowId)
  }, [mainTab, voiceSubTab, selectedFlowId, loadSteps])

  useEffect(() => {
    if (voiceSubTab !== 'fluxos' || flows.length === 0) return
    if (selectedFlowId && flows.some((f) => f.id === selectedFlowId)) return
    setSelectedFlowId(flows[0]!.id)
  }, [voiceSubTab, flows, selectedFlowId])

  /** Ao abrir "Nova Campanha", garante fluxo válido quando `flows` carrega depois. */
  useEffect(() => {
    if (!newOpen || flows.length === 0) return
    setNewCampaignFlowId((cur) =>
      cur && flows.some((f) => f.id === cur) ? cur : flows[0]!.id,
    )
  }, [newOpen, flows])

  // -------------------------------------------------------------------------
  // Mutations: campanha
  // -------------------------------------------------------------------------

  const createCampaign = useCallback(async () => {
    if (!userId) return
    if (!newName.trim()) {
      setError('Dê um nome para a campanha.')
      return
    }
    if (!newCampaignFlowId || !flows.some((f) => f.id === newCampaignFlowId)) {
      setError('Selecione um fluxo existente (guia Fluxos). Campanhas não criam fluxo automaticamente.')
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
          flow_id: newCampaignFlowId,
          isca_message: newIscaMessage.trim() || 'Olá {nome}, tudo bem?',
          isca_messages: newIscas.map((x) => x.trim()).filter(Boolean).slice(0, 5),
          trigger_condition: newTriggerCondition,
          trigger_keyword: newTriggerKeyword.trim() || null,
          status: 'draft' as CampaignStatus,
          min_delay_seconds: 2,
          max_delay_seconds: 15,
        })
        .select(
          'id, user_id, name, description, audience_tags, scheduled_start_at, isca_message, isca_messages, trigger_condition, trigger_keyword, flow_id, status, min_delay_seconds, max_delay_seconds, created_at, updated_at',
        )
        .single()
      if (insert.error || !insert.data) {
        throw new Error(insert.error?.message ?? 'Falha ao criar campanha.')
      }
      const ins = insert.data as {
        audience_tags?: string[] | null
        trigger_keyword?: string | null
        scheduled_start_at?: string | null
        isca_message?: string | null
        isca_messages?: string[] | null
        trigger_condition?: string | null
        flow_id?: string | null
      }
      const created = {
        ...(insert.data as object),
        audience_tags: normalizeTags(ins.audience_tags),
        trigger_keyword: ins.trigger_keyword?.trim() ? ins.trigger_keyword.trim() : null,
        isca_message: (ins.isca_message ?? '').trim() || '',
        isca_messages: (ins.isca_messages ?? null) as string[] | null,
        trigger_condition: (ins.trigger_condition ?? 'equals') as ZvTriggerCondition,
        flow_id: (ins.flow_id ?? newCampaignFlowId) as string,
        scheduled_start_at: ins.scheduled_start_at ?? null,
      } as Campaign

      setCampaigns((prev) => [created, ...prev])
      setSelectedId(created.id)
      setNewOpen(false)
      setNewName('')
      setNewAudienceTags([])
      setNewDescription('')
      setNewScheduledStartLocal('')
      setNewIscaMessage('Olá {nome}, tudo bem? Aqui é da equipe Zapifica…')
      setNewIscas([
        'Olá {nome}, tudo bem? Aqui é da equipe Zapifica…',
        'Oi {nome}! Tudo certo? Só confirmando uma coisa rapidinho…',
        'Olá! Esse WhatsApp é o contato certo pra falar com você?',
        'Oi! Posso te fazer uma pergunta rápida? 🙂',
        'Olá {nome}! Vi seu contato e queria confirmar uma informação.',
      ])
      setNewTriggerCondition('equals')
      setNewTriggerKeyword('')
      setNewCampaignFlowId('')
      setSuccess(
        'Campanha criada em rascunho. Ajuste a isca e o gatilho aqui; as etapas ficam no fluxo que você escolheu (guia Fluxos).',
      )
      window.setTimeout(() => setSuccess(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao criar campanha.')
    } finally {
      setCreating(false)
    }
  }, [
    newName,
    newDescription,
    newAudienceTags,
    newScheduledStartLocal,
    newIscaMessage,
    newIscas,
    newTriggerCondition,
    newTriggerKeyword,
    newCampaignFlowId,
    flows,
    userId,
  ])

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

  const createEmptyFlow = useCallback(async () => {
    if (!userId) return
    const name = window.prompt('Nome do novo fluxo:', 'Novo fluxo')?.trim()
    if (!name) return
    const { data, error: e } = await supabase
      .from('zv_flows')
      .insert({ user_id: userId, name, description: null })
      .select('id, user_id, name, description, created_at, updated_at')
      .single()
    if (e || !data) {
      setError(e?.message ?? 'Falha ao criar fluxo.')
      return
    }
    setFlows((prev) => [data as ZvFlow, ...prev])
    setSelectedFlowId((data as ZvFlow).id)
    setVoiceSubTab('fluxos')
    setSuccess('Fluxo criado. Adicione etapas abaixo.')
    window.setTimeout(() => setSuccess(null), 4000)
  }, [userId])

  const openFlowForEdit = useCallback((flowId: string) => {
    setSelectedFlowId(flowId)
    setVoiceSubTab('fluxos')
  }, [])

  const renameFlow = useCallback(
    async (f: ZvFlow) => {
      const name = window.prompt('Nome do fluxo:', f.name)?.trim()
      if (!name) return
      setError(null)
      const { error: e } = await supabase.from('zv_flows').update({ name }).eq('id', f.id)
      if (e) {
        setError(`Falha ao renomear o fluxo: ${e.message}`)
        return
      }
      setFlows((prev) => prev.map((x) => (x.id === f.id ? { ...x, name } : x)))
      setSuccess('Fluxo atualizado.')
      window.setTimeout(() => setSuccess(null), 3000)
    },
    [],
  )

  const duplicateFlow = useCallback(
    async (f: ZvFlow) => {
      if (!userId) {
        setError('Sessão inválida.')
        return
      }
      setError(null)
      const base = `Cópia de ${f.name}`.trim()
      const newName = base.slice(0, 200)
      const { data: ins, error: insE } = await supabase
        .from('zv_flows')
        .insert({
          user_id: userId,
          name: newName,
          description: f.description ?? null,
        })
        .select('id, user_id, name, description, created_at, updated_at')
        .single()
      if (insE || !ins) {
        setError(insE?.message ?? 'Falha ao duplicar o fluxo.')
        return
      }
      const newFlow = ins as ZvFlow
        const { data: oldSteps, error: stE } = await supabase
        .from('zv_funnels')
        .select(
          'step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds',
        )
        .eq('flow_id', f.id)
        .order('step_order', { ascending: true })
      if (stE) {
        await supabase.from('zv_flows').delete().eq('id', newFlow.id)
        setError(`Falha ao ler etapas: ${stE.message}`)
        return
      }
      if (oldSteps && oldSteps.length > 0) {
        const rows = (oldSteps as {
          step_order: number
          message: string
          media_type: FunnelMediaType
          media_url: string | null
          delay_seconds: number
          expected_trigger: string | null
          advance_type: string | null
          min_delay_seconds: number | null
          max_delay_seconds: number | null
        }[]).map((s) => ({
            flow_id: newFlow.id,
            step_order: s.step_order,
            message: s.message,
            media_type: s.media_type,
            media_url: s.media_url,
            delay_seconds: s.delay_seconds,
            expected_trigger: s.expected_trigger,
            advance_type: s.advance_type,
            min_delay_seconds: s.min_delay_seconds,
            max_delay_seconds: s.max_delay_seconds,
          }),
        )
        const { error: inStepE } = await supabase.from('zv_funnels').insert(rows)
        if (inStepE) {
          await supabase.from('zv_flows').delete().eq('id', newFlow.id)
          setError(`Falha ao copiar etapas: ${inStepE.message}`)
          return
        }
      }
      setFlows((prev) => [newFlow, ...prev])
      setSelectedFlowId(newFlow.id)
      setVoiceSubTab('fluxos')
      setSuccess('Fluxo duplicado. Revise o nome e as etapas à direita.')
      window.setTimeout(() => setSuccess(null), 5000)
    },
    [userId],
  )

  const deleteFlow = useCallback(
    async (f: ZvFlow) => {
      setError(null)
      const blockers = (campaigns as Campaign[]).filter(
        (c) => c.flow_id === f.id && (c.status === 'draft' || c.status === 'active' || c.status === 'paused'),
      )
      if (blockers.length > 0) {
        setError(
          `Não é possível excluir: ${blockers.length} campanha(s) ainda estão em rascunho/ativas/pausadas usando este fluxo. Na guia Campanhas, troque o fluxo dessas campanhas (ou conclua/exclua) e tente de novo.`,
        )
        return
      }
      if (
        !window.confirm(
          `Excluir o fluxo "${f.name}"? As etapas serão apagadas junto. Esta ação não pode ser desfeita.`,
        )
      ) {
        return
      }
      const { error: e } = await supabase.from('zv_flows').delete().eq('id', f.id)
      if (e) {
        setError(`Falha ao excluir o fluxo: ${e.message}`)
        return
      }
      setFlows((prev) => prev.filter((x) => x.id !== f.id))
      if (selectedFlowId === f.id) {
        setSelectedFlowId(null)
      }
      setSuccess('Fluxo excluído.')
      window.setTimeout(() => setSuccess(null), 4000)
    },
    [campaigns, selectedFlowId],
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
    async (c: Campaign) => {
      if (!userId) {
        setError('Sessão inválida.')
        return
      }
      if (activateInFlightRef.current) {
        return
      }
      activateInFlightRef.current = true
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

        const audienceType = (c.audience_type ?? 'tags') as 'tags' | 'audience' | 'individual'

        const iscas = (c.isca_messages ?? [])
          .map((x) => (x ?? '').trim())
          .filter(Boolean)
          .slice(0, 5)
        const fallbackIsca = (c.isca_message ?? '').trim()
        if (iscas.length === 0 && !fallbackIsca) {
          throw new Error('Preencha ao menos 1 mensagem de isca na guia Campanhas antes de ativar.')
        }

        if (!c.flow_id) {
          throw new Error('Esta campanha está sem fluxo (provavelmente o fluxo foi excluído). Selecione outro fluxo antes de ativar.')
        }
        const { data: stepsData, error: stepsErr } = await supabase
          .from('zv_funnels')
          .select(
            'id, flow_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds, created_at, updated_at',
          )
          .eq('flow_id', c.flow_id)
          .order('step_order', { ascending: true })
        if (stepsErr) throw new Error(stepsErr.message)

        const ordered = [...(stepsData ?? [])] as FunnelStep[]
        if (ordered.length === 0) {
          throw new Error('Adicione ao menos uma etapa no fluxo vinculado (guia Fluxos).')
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

        let leadQuery = supabase
          .from('leads')
          .select('id, name, phone, tag, extraction_id')
          .eq('user_id', userId)

        if (audienceType === 'tags') {
          const tags = normalizeTags(c.audience_tags)
          if (tags.length === 0) {
            throw new Error('Selecione ao menos um público (tags) nesta campanha antes de ativar.')
          }
          leadQuery = leadQuery.in('tag', tags)
        } else if (audienceType === 'audience') {
          const audId = (c.audience_id ?? '').trim()
          if (!audId) {
            throw new Error('Selecione um público salvo antes de ativar.')
          }
          const { data: audRow, error: audErr } = await supabase
            .from('zv_audiences')
            .select('id, lead_ids')
            .eq('user_id', userId)
            .eq('id', audId)
            .maybeSingle()
          if (audErr) throw new Error(`Público: ${audErr.message}`)
          const ids = ((audRow as any)?.lead_ids ?? []) as string[]
          if (!ids.length) {
            throw new Error('Este público está vazio. Adicione contatos nele antes de ativar.')
          }
          leadQuery = leadQuery.in('id', ids)
        } else {
          const ids = (c.audience_lead_ids ?? []).filter(Boolean)
          if (!ids.length) {
            throw new Error('Selecione ao menos 1 cliente individual antes de ativar.')
          }
          leadQuery = leadQuery.in('id', ids)
        }

        const { data: leadRows, error: leadErr } = await leadQuery

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

        // Mesmo celular não pode gerar várias iscas: se o CRM tiver 2+ contatos com o mesmo número,
        // só disparamos uma isca por telefone (evita “Rodolfo + Floripa” duplicados no WhatsApp).
        const byPhone = new Map<string, (typeof rawLeads)[0]>()
        for (const l of withPhone) {
          const k = phoneDigitsForQueue(l.phone)
          if (!k) continue
          if (!byPhone.has(k)) byPhone.set(k, l)
        }
        const audienceForIsca = Array.from(byPhone.values())

        if (audienceForIsca.length === 0) {
          throw new Error(
            'Não há leads com telefone válido para o público selecionado. Confira o CRM ou a extração.',
          )
        }

        const exIds = [
          ...new Set(
            audienceForIsca.map((l) => l.extraction_id).filter(Boolean),
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

        // Anti-ban (isca): espaça os leads com delay cumulativo aleatório.
        // Ex.: lead1 now+5s, lead2 now+15s, lead3 now+28s...
        let cumulativeMs = 0
        const minS = Math.max(0, Number(c.min_delay_seconds) || 0)
        const maxS = Math.max(minS, Number(c.max_delay_seconds) || 0)

        const { data: alreadyPending, error: pendErr } = await supabase
          .from('scheduled_messages')
          .select('lead_id')
          .eq('user_id', userId)
          .eq('zv_campaign_id', c.id)
          .is('zv_funnel_step_id', null)
          .in('status', ['pending', 'processing'])
        if (pendErr) {
          console.warn('[ZapVoiceCampaigns] check isca duplicada:', pendErr.message)
        }
        const leadIdsComIscaPendente = new Set(
          (alreadyPending ?? [])
            .map((r) => (r as { lead_id: string | null }).lead_id)
            .filter((x): x is string => Boolean(x)),
        )

        let insertedCount = 0

        for (const lead of audienceForIsca) {
          if (leadIdsComIscaPendente.has(lead.id)) {
            continue
          }
          const loc = lead.extraction_id
            ? locByEx.get(lead.extraction_id) ?? null
            : null
          const vars: TemplateVars = {
            nome: firstNameFromFullName(lead.name),
            empresa: lead.name.trim() || 'sua empresa',
            cidade: cityFromExtractionLocation(loc),
          }

          // ISCA: somente o painel enfileira (zv_funnel_step_id nulo). Webhook nunca manda isca.
          cumulativeMs += pickRandomIntInclusive(minS, maxS) * 1000
          const scheduledAt = new Date(startMs + cumulativeMs).toISOString()
          // Rotação de iscas: distribui as 5 opções entre os leads (A,B,C,D,E, A,B…).
          const pick = (iscas.length > 0 ? iscas : [fallbackIsca]).filter(Boolean)
          const chosen = pick.length ? pick[insertedCount % pick.length]! : (fallbackIsca || 'Olá {nome}, tudo bem?')
          const messageBody = applyMessageTemplate(chosen, vars)

          // Se o usuário está ativando/enviando uma NOVA isca para este lead,
          // precisamos permitir uma nova execução do fluxo após o gatilho.
          // Caso contrário, a barreira anti-loop (`lead_campaign_completions`) pode bloquear em `ja_concluida`.
          await supabase
            .from('lead_campaign_completions')
            .delete()
            .eq('user_id', userId)
            .eq('lead_id', lead.id)
            .eq('campaign_id', c.id)

          await supabase
            .from('lead_campaign_progress')
            .delete()
            .eq('user_id', userId)
            .eq('lead_id', lead.id)
            .eq('campaign_id', c.id)

          const row: Record<string, unknown> = {
            user_id: userId,
            lead_id: lead.id,
            zv_campaign_id: c.id,
            zv_funnel_step_id: null,
            is_active: true,
            recipient_type: 'personal',
            content_type: 'text',
            message_body: messageBody || null,
            media_url: null,
            scheduled_at: scheduledAt,
            status: 'pending',
            recipient_phone: lead.phone,
            min_delay_seconds: c.min_delay_seconds,
            max_delay_seconds: c.max_delay_seconds,
          }

          const { error: insErr } = await supabase.from('scheduled_messages').insert([row])
          if (insErr) {
            if (insErr.code === '23505') {
              continue
            }
            throw new Error(`Fila: ${insErr.message}`)
          }
          insertedCount += 1

          const { error: progErr } = await supabase
            .from('lead_campaign_progress')
            .upsert(
              {
                user_id: userId,
                lead_id: lead.id,
                campaign_id: c.id,
                next_step_order: (ordered[0]?.step_order ?? 1),
                total_steps: ordered.reduce(
                  (acc, s) => Math.max(acc, Number(s.step_order) || 0),
                  0,
                ) || ordered.length,
                status: 'active',
              },
              { onConflict: 'user_id,lead_id,campaign_id' },
            )
          if (progErr) {
            throw new Error(`Progresso da campanha: ${progErr.message}`)
          }

          const lockUntilIso = new Date(startMs + 6 * 60 * 60 * 1000).toISOString()
          await supabase
            .from('leads')
            .update({ funnel_locked_until: lockUntilIso })
            .eq('id', lead.id)
            .eq('user_id', userId)
        }

        if (insertedCount === 0) {
          throw new Error(
            'Nenhuma isca nova: todos os leads do público já têm isca ativa/pendente ou houve conflito de duplicata. A fila de isca vem só desta tela, não do webhook.',
          )
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
        const total = insertedCount
        const nLeads = audienceForIsca.length
        const inicioFila =
          startMs > now
            ? ` A fila começa em ${formatDateBr(new Date(startMs).toISOString())}.`
            : ''
        setSuccess(
          `Campanha ativa: ${total} isca(s) agendada(s) para ${nLeads} lead${
            nLeads === 1 ? '' : 's'
          }. O gatilho e o fluxo (guia Fluxos) definem a sequência após a resposta.${inicioFila}`,
        )
        window.setTimeout(() => setSuccess(null), 8000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        activateInFlightRef.current = false
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
      if (!confirm('Excluir esta campanha? O fluxo vinculado permanece (guia Fluxos).')) {
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
    if (!selectedFlowId) return
    const nextOrder = (steps[steps.length - 1]?.step_order ?? 0) + 1
    const { data, error: e } = await supabase
      .from('zv_funnels')
      .insert({
        flow_id: selectedFlowId,
        step_order: nextOrder,
        message: '',
        media_type: 'text',
        media_url: null,
        delay_seconds: 0,
        expected_trigger: null,
        advance_type: 'timer',
        min_delay_seconds: 2,
        max_delay_seconds: 15,
      })
      .select(
        'id, flow_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, advance_type, min_delay_seconds, max_delay_seconds, created_at, updated_at',
      )
      .single()
    if (e || !data) {
      setError(`Falha ao adicionar etapa: ${e?.message ?? 'desconhecido'}`)
      return
    }
    setSteps((prev) => [...prev, data as FunnelStep])
  }, [selectedFlowId, steps])

  const saveStep = useCallback(
    async (
      stepId: string,
      patch: Partial<
        Pick<
          FunnelStep,
          | 'message'
          | 'media_type'
          | 'media_url'
          | 'delay_seconds'
          | 'expected_trigger'
          | 'advance_type'
          | 'min_delay_seconds'
          | 'max_delay_seconds'
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
    // Evita gaps em step_order: após excluir, renumera 1..N no fluxo selecionado.
    const nextLocal = steps.filter((s) => s.id !== stepId).sort((a, b) => a.step_order - b.step_order)
    setSteps(nextLocal)
    if (selectedFlowId) {
      // Estratégia segura contra unique(flow_id, step_order):
      // 1) joga tudo para step_order temporário (negativos únicos)
      // 2) escreve a ordem final 1..N
      for (let i = 0; i < nextLocal.length; i += 1) {
        const s = nextLocal[i]!
        const tempOrder = -1000 - i
        await supabase.from('zv_funnels').update({ step_order: tempOrder }).eq('id', s.id)
      }
      for (let i = 0; i < nextLocal.length; i += 1) {
        const s = nextLocal[i]!
        const newOrder = i + 1
        await supabase.from('zv_funnels').update({ step_order: newOrder }).eq('id', s.id)
      }
      setSteps((prev) => prev.slice().sort((a, b) => a.step_order - b.step_order))
    }
  }, [])

  const moveStep = useCallback(
    async (stepId: string, direction: -1 | 1) => {
      const idx = steps.findIndex((s) => s.id === stepId)
      if (idx === -1) return
      const swap = idx + direction
      if (swap < 0 || swap >= steps.length) return
      const a = steps[idx]
      const b = steps[swap]

      // Truque para evitar conflito do unique(flow_id, step_order):
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
              ? 'Campanhas (isca e gatilho), fluxos de automação e relatórios — organizados em abas abaixo.'
              : mainTab === 'contatos'
                ? 'Unifique e limpe a base: importe CSV (modelo completo) e gerencie origens na interface de contatos.'
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

      {mainTab === 'campanhas' ? (
        <div className="mb-2 flex flex-wrap gap-1 border-b border-zinc-100">
          {(
            [
              { id: 'campanhas' as const, label: 'Campanhas (isca & gatilho)' },
              { id: 'fluxos' as const, label: 'Fluxos (automação)' },
              { id: 'relatorios' as const, label: 'Relatórios' },
            ] as const
          ).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setVoiceSubTab(id)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition ${
                voiceSubTab === id
                  ? 'border-brand-600 text-brand-800'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {mainTab === 'campanhas' && voiceSubTab === 'relatorios' && userId ? (
        <ZapVoiceReportsTab
          userId={userId}
          campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
        />
      ) : null}

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

      {/* Campanhas / Fluxos: painel duplo (Relatórios fica fora) */}
      {mainTab === 'campanhas' && voiceSubTab !== 'relatorios' ? (
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* COLUNA ESQUERDA: campanhas ou fluxos */}
        <aside className="rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-sm ring-1 ring-zinc-100/80">
          {voiceSubTab === 'fluxos' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 px-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Seus fluxos
                </p>
                <span className="text-xs tabular-nums text-zinc-400">{flows.length}</span>
              </div>
              <button
                type="button"
                onClick={() => void createEmptyFlow()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-brand-300 bg-brand-50 px-3 py-2.5 text-xs font-semibold text-brand-800 hover:bg-brand-100"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Novo fluxo
              </button>
              <div className="max-h-[420px] space-y-1.5 overflow-y-auto">
                {flows.map((f) => {
                  const active = f.id === selectedFlowId
                  return (
                    <div
                      key={f.id}
                      className={`flex w-full min-w-0 items-stretch gap-0.5 overflow-hidden rounded-lg border text-sm transition ${
                        active
                          ? 'border-brand-300 bg-brand-50/80 text-brand-900'
                          : 'border-zinc-200 bg-white text-zinc-800 hover:border-brand-200'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => openFlowForEdit(f.id)}
                        className="min-w-0 flex-1 px-2.5 py-2 text-left font-medium"
                      >
                        <span className="line-clamp-2 break-words">{f.name}</span>
                      </button>
                      <div
                        className="flex shrink-0 flex-col justify-center gap-0.5 border-l border-zinc-200/70 bg-white/50 py-0.5 pr-0.5 pl-0.5"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => openFlowForEdit(f.id)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-brand-100 hover:text-brand-800"
                            title="Editar etapas (abre o fluxo à direita)"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => void duplicateFlow(f)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-brand-100 hover:text-brand-800"
                            title="Duplicar fluxo"
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteFlow(f)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-rose-500 transition hover:bg-rose-50"
                            title="Excluir fluxo"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {flows.length === 0 ? (
                  <p className="px-1 text-xs text-zinc-500">Nenhum fluxo ainda. Crie um acima.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <>
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
            onClick={() => {
              setNewOpen((prev) => {
                const next = !prev
                if (!prev && flows.length > 0) {
                  setNewCampaignFlowId((cur) =>
                    cur && flows.some((f) => f.id === cur) ? cur : flows[0]!.id,
                  )
                }
                if (prev) setNewCampaignFlowId('')
                return next
              })
            }}
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
                  Fluxo de automação
                </label>
                {flows.length === 0 ? (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Não há fluxos cadastrados. Abra a guia <b>Fluxos</b>, crie um fluxo com as etapas e volte aqui para criar a campanha.
                  </p>
                ) : (
                  <select
                    value={newCampaignFlowId}
                    onChange={(e) => setNewCampaignFlowId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  >
                    {flows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
                <p className="mt-1 text-[11px] text-zinc-500">
                  A campanha usa um fluxo já existente; nada é criado automaticamente na guia Fluxos.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Público (uma ou mais tags)
                </label>
                <TagMultiPicker
                  options={audienceOptions}
                  value={newAudienceTags}
                  onChange={setNewAudienceTags}
                  customHint="O disparo inclui qualquer lead cuja tag estiver marcada (lógica OU). Tags vêm do Extrator, CSV ou inclusão manual na base."
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
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Mensagens de isca (5 opções, revezamento automático)
                </label>
                <div className="space-y-2">
                  {newIscas.map((v, idx) => (
                    <div key={idx} className="rounded-lg border border-zinc-200 bg-white p-2">
                      <p className="mb-1 text-[11px] font-semibold text-zinc-600">
                        Isca {idx + 1}
                      </p>
                      <textarea
                        rows={2}
                        value={v}
                        onChange={(e) => {
                          const next = newIscas.slice()
                          next[idx] = e.target.value
                          setNewIscas(next)
                          if (idx === 0) setNewIscaMessage(e.target.value)
                        }}
                        className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                      />
                    </div>
                  ))}
                </div>
                <MessageVariableChips
                  variables={MESSAGE_VARIABLES}
                  onInsert={(key) => {
                    const next = newIscas.slice()
                    next[0] = (next[0] ?? '') + key
                    setNewIscas(next)
                    setNewIscaMessage((prev) => prev + key)
                  }}
                  className="mt-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Regra do gatilho
                </label>
                <select
                  value={newTriggerCondition}
                  onChange={(e) => setNewTriggerCondition(e.target.value as ZvTriggerCondition)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                >
                  <option value="equals">Igual a</option>
                  <option value="contains">Contém</option>
                  <option value="starts_with">Começa com</option>
                  <option value="not_contains">Não contém</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Palavra-chave (gatilho)
                </label>
                <input
                  value={newTriggerKeyword}
                  onChange={(e) => setNewTriggerKeyword(e.target.value)}
                  placeholder="Ex.: QUERO, SIM, CUPOM10"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Após a isca, o lead precisa enviar esta palavra (ou regra) para entrar no fluxo escolhido acima.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void createCampaign()}
                  disabled={creating || flows.length === 0 || !newCampaignFlowId}
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
                  onClick={() => {
                    setNewOpen(false)
                    setNewCampaignFlowId('')
                  }}
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
            </>
          )}
        </aside>

        {/* COLUNA DIREITA: campanha ou etapas do fluxo */}
        <section className="space-y-5">
          {voiceSubTab === 'campanhas' && !selected ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 shadow-sm">
              Selecione uma campanha à esquerda — ou crie a primeira para começar.
            </div>
          ) : voiceSubTab === 'campanhas' && selected ? (
            <>
              {leadPickerOpen ? (
                <div
                  className="fixed inset-0 z-[90] flex items-center justify-center bg-zinc-950/50 p-4"
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-zinc-900">Selecionar clientes</h4>
                        <p className="mt-1 text-sm text-zinc-600">
                          Escolha os contatos que vão receber a isca desta campanha.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLeadPickerOpen(false)}
                        className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"
                        aria-label="Fechar"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <input
                        value={leadPickerQuery}
                        onChange={(e) => setLeadPickerQuery(e.target.value)}
                        placeholder="Buscar por nome, telefone ou tag…"
                        className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={leadPickerBusy}
                        onClick={() => {
                          if (userId) void ensureLeadPickerRows(userId)
                        }}
                        className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
                      >
                        {leadPickerBusy ? 'Carregando…' : 'Atualizar'}
                      </button>
                    </div>

                    <div className="mt-4 max-h-[55vh] overflow-auto rounded-xl border border-zinc-200">
                      <table className="w-full min-w-[700px] border-collapse text-left text-sm">
                        <thead className="sticky top-0 z-[1] bg-zinc-50">
                          <tr className="border-b border-zinc-200">
                            <th className="w-[44px] px-3 py-2">
                              <span className="sr-only">Selecionar</span>
                            </th>
                            <th className="px-3 py-2 font-semibold text-zinc-700">Nome</th>
                            <th className="px-3 py-2 font-semibold text-zinc-700">Telefone</th>
                            <th className="px-3 py-2 font-semibold text-zinc-700">Tag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const q = leadPickerQuery.trim().toLowerCase()
                            const rows = leadPickerRows.filter((r) => {
                              if (!q) return true
                              const name = (r.name ?? '').toLowerCase()
                              const phone = (r.phone ?? '').replace(/\D/g, '')
                              const tag = (r.tag ?? '').toLowerCase()
                              const qq = q.replace(/\D/g, '')
                              return name.includes(q) || (qq && phone.includes(qq)) || tag.includes(q)
                            })
                            return rows.map((r) => {
                              const cur = new Set((selected.audience_lead_ids ?? []) as string[])
                              const checked = cur.has(r.id)
                              return (
                                <tr key={r.id} className="border-b border-zinc-100 hover:bg-zinc-50/70">
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      className="rounded border-zinc-300"
                                      checked={checked}
                                      onChange={() => {
                                        const next = new Set(cur)
                                        if (next.has(r.id)) next.delete(r.id)
                                        else next.add(r.id)
                                        const arr = Array.from(next)
                                        setCampaigns((prev) =>
                                          prev.map((c) =>
                                            c.id === selected.id ? { ...c, audience_lead_ids: arr } : c,
                                          ),
                                        )
                                        void updateCampaign(selected.id, { audience_lead_ids: arr })
                                      }}
                                    />
                                  </td>
                                  <td className="px-3 py-2 font-medium text-zinc-900">{r.name}</td>
                                  <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-700">
                                    {r.phone ?? '—'}
                                  </td>
                                  <td className="px-3 py-2 text-zinc-600">{r.tag ?? '—'}</td>
                                </tr>
                              )
                            })
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : null}

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
                        onClick={() => void activateCampaign(selected)}
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
                      Público
                    </p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-[200px_1fr]">
                      <label className="block text-[11px] font-semibold text-zinc-700">
                        Tipo
                        <select
                          value={(selected.audience_type ?? 'tags') as any}
                          onChange={(e) => {
                            const v = e.target.value as 'tags' | 'audience' | 'individual'
                            setCampaigns((prev) =>
                              prev.map((c) =>
                                c.id === selected.id
                                  ? {
                                      ...c,
                                      audience_type: v,
                                      audience_id: v === 'audience' ? (c.audience_id ?? null) : null,
                                      audience_lead_ids: v === 'individual' ? (c.audience_lead_ids ?? []) : [],
                                    }
                                  : c,
                              ),
                            )
                            void updateCampaign(selected.id, {
                              audience_type: v,
                              audience_id: v === 'audience' ? (selected.audience_id ?? null) : null,
                              audience_lead_ids: v === 'individual' ? (selected.audience_lead_ids ?? []) : [],
                            })
                          }}
                          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-inner"
                        >
                          <option value="tags">Tags</option>
                          <option value="audience">Público salvo</option>
                          <option value="individual">Clientes individuais</option>
                        </select>
                      </label>

                      {(selected.audience_type ?? 'tags') === 'audience' ? (
                        <label className="block text-[11px] font-semibold text-zinc-700">
                          Público salvo
                          <select
                            value={selected.audience_id ?? ''}
                            onChange={(e) => {
                              const v = e.target.value || null
                              setCampaigns((prev) =>
                                prev.map((c) =>
                                  c.id === selected.id ? { ...c, audience_id: v } : c,
                                ),
                              )
                              void updateCampaign(selected.id, { audience_id: v })
                            }}
                            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-inner"
                          >
                            <option value="">Selecione…</option>
                            {savedAudiences.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({a.lead_ids?.length ?? 0})
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-[10px] font-medium text-zinc-500">
                            Crie públicos na aba <b>Base de contatos</b> selecionando contatos e clicando em “Criar público”.
                          </p>
                        </label>
                      ) : null}
                    </div>
                    <div className="mt-1.5">
                      {(selected.audience_type ?? 'tags') === 'tags' ? (
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
                      ) : (selected.audience_type ?? 'tags') === 'individual' ? (
                        <div className="rounded-lg border border-zinc-200 bg-white p-3">
                          <p className="text-xs font-medium text-zinc-700">
                            {((selected.audience_lead_ids ?? []) as string[]).length} cliente(s) selecionado(s).
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              if (userId) void ensureLeadPickerRows(userId)
                              setLeadPickerOpen(true)
                            }}
                            className="mt-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
                          >
                            Selecionar clientes…
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[11px] font-medium text-zinc-700">
                      <span className="tabular-nums text-brand-700">
                        {audienceReachCount ?? '—'}
                      </span>{' '}
                      lead{(audienceReachCount ?? 0) === 1 ? '' : 's'} (estimativa por tags)
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
                      Automação
                    </p>
                    <p className="mt-1.5 text-sm font-medium text-zinc-800">Fluxo vinculado</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      As etapas pós-isca ficam na guia <b>Fluxos</b> (automação).
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
                    <label className="mb-1 block text-xs font-medium text-zinc-700">
                      Gatilho (palavra-chave após a isca)
                    </label>
                    <input
                      value={selected.trigger_keyword ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, trigger_keyword: v || null } : c,
                          ),
                        )
                      }}
                      onBlur={(e) => {
                        const t = e.target.value.trim() || null
                        setCampaigns((prev) =>
                          prev.map((c) => (c.id === selected.id ? { ...c, trigger_keyword: t } : c)),
                        )
                        void updateCampaign(selected.id, { trigger_keyword: t })
                      }}
                      placeholder="Ex.: QUERO, CUPOM, SIM"
                      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Depois que a <b>Mensagem inicial</b> (isca) for enviada, o lead precisa
                      responder com exatamente este texto (normalizado: minúsculas, sem espaços
                      duplicados) para o sistema enfileirar a próxima etapa do funil.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700">
                      Mensagem da isca (primeiro disparo)
                    </label>
                    <textarea
                      rows={4}
                      value={selected.isca_message ?? ''}
                      onChange={(e) => {
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, isca_message: e.target.value } : c,
                          ),
                        )
                      }}
                      onBlur={(e) =>
                        void updateCampaign(selected.id, { isca_message: e.target.value.trim() || '' })
                      }
                      className="w-full max-w-xl rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                    <MessageVariableChips
                      variables={MESSAGE_VARIABLES}
                      onInsert={(key) => {
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id
                              ? { ...c, isca_message: (c.isca_message ?? '') + key }
                              : c,
                          ),
                        )
                      }}
                      className="mt-2 max-w-xl"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700">
                      Regra do gatilho (comparar com a palavra-chave)
                    </label>
                    <select
                      value={selected.trigger_condition}
                      onChange={(e) => {
                        const v = e.target.value as ZvTriggerCondition
                        setCampaigns((prev) =>
                          prev.map((c) =>
                            c.id === selected.id ? { ...c, trigger_condition: v } : c,
                          ),
                        )
                        void updateCampaign(selected.id, { trigger_condition: v })
                      }}
                      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                    >
                      <option value="equals">Igual a (texto normalizado)</option>
                      <option value="contains">Contém</option>
                      <option value="starts_with">Começa com</option>
                      <option value="not_contains">Não contém</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700">
                      Fluxo de automação
                    </label>
                    <select
                      value={selected.flow_id}
                      onChange={(e) => {
                        const v = e.target.value
                        setCampaigns((prev) =>
                          prev.map((c) => (c.id === selected.id ? { ...c, flow_id: v } : c)),
                        )
                        void updateCampaign(selected.id, { flow_id: v })
                      }}
                      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                    >
                      {flows.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </>
          ) : null}
          {voiceSubTab === 'fluxos' && !selectedFlowId ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 shadow-sm">
              Selecione um fluxo à esquerda ou crie um novo.
            </div>
          ) : null}
          {voiceSubTab === 'fluxos' && selectedFlowId ? (
              <>
              {/* Editor de etapas do fluxo */}
              <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm ring-1 ring-zinc-100/80">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-zinc-900">
                      <span>Fluxo: {selectedFlow?.name ?? '—'}</span>
                      {selectedFlow ? (
                        <button
                          type="button"
                          onClick={() => void renameFlow(selectedFlow)}
                          className="text-xs font-semibold text-brand-700 underline decoration-brand-300 underline-offset-2 transition hover:text-brand-900"
                        >
                          Renomear
                        </button>
                      ) : null}
                    </h3>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      Cada etapa é uma mensagem WhatsApp na ordem do roteiro. Use os botões de
                      variáveis no cartão da etapa para inserir dados do lead, da empresa e do
                      horário.
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
          ) : null}
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
        | 'message'
        | 'media_type'
        | 'media_url'
        | 'delay_seconds'
        | 'expected_trigger'
        | 'advance_type'
        | 'min_delay_seconds'
        | 'max_delay_seconds'
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
    setStepMinDelay(typeof step.min_delay_seconds === 'number' ? step.min_delay_seconds : 2)
    setStepMaxDelay(typeof step.max_delay_seconds === 'number' ? step.max_delay_seconds : 15)
  }, [
    step.id,
    step.message,
    step.media_type,
    step.media_url,
    step.delay_seconds,
    step.min_delay_seconds,
    step.max_delay_seconds,
  ])

  const mediaNeedsUrl = mediaType !== 'text'
  const dirty =
    message !== step.message ||
    mediaType !== step.media_type ||
    (mediaUrl || '').trim() !== (step.media_url ?? '').trim() ||
    delaySeconds !== step.delay_seconds ||
    stepMinDelay !== (typeof step.min_delay_seconds === 'number' ? step.min_delay_seconds : 2) ||
    stepMaxDelay !== (typeof step.max_delay_seconds === 'number' ? step.max_delay_seconds : 15)

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
    if (!Number.isFinite(stepMinDelay) || !Number.isFinite(stepMaxDelay)) {
      setLocalError('Delay mínimo/máximo inválido.')
      return
    }
    if (stepMinDelay < 0 || stepMaxDelay < 0 || stepMaxDelay < stepMinDelay) {
      setLocalError('Delay mínimo/máximo precisa ser >= 0 e Máx >= Mín.')
      return
    }
    onSave({
      message,
      media_type: mediaType,
      media_url: mediaType === 'text' ? null : mediaUrl.trim() || null,
      delay_seconds: delaySeconds,
      expected_trigger: null,
      advance_type: 'timer',
      min_delay_seconds: stepMinDelay,
      max_delay_seconds: stepMaxDelay,
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
            Etapa {String(index).padStart(2, '0')}
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
            <MessageVariableChips
              variables={MESSAGE_VARIABLES}
              onInsert={(key) => setMessage((prev) => prev + key)}
              className="mt-2"
            />
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
                ? 'Atraso após a confirmação do gatilho da campanha, antes de enfileirar esta etapa. Use 0 para o menor atraso possível.'
                : 'Tempo decorrido desde a etapa anterior (enviada e processada).'}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Avanço temporizado (anti-ban)
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Após o gatilho da campanha, todo o fluxo segue automático. Cada etapa
              espera um tempo aleatório entre <b>Mín</b> e <b>Máx</b> antes de disparar.
            </p>
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
            </div>
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
