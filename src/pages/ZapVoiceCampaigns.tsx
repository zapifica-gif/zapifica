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
  audience_tag: string | null
  status: CampaignStatus
  default_delay_seconds: number
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
  created_at: string
  updated_at: string
}

type AudienceTagOption = { tag: string; count: number }

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

/** Variáveis dinâmicas suportadas no editor de mensagem (preview-only). */
const MESSAGE_VARIABLES = [
  { key: '{nome}', helper: 'Primeiro nome do contato' },
  { key: '{empresa}', helper: 'Nome da empresa do lead' },
  { key: '{cidade}', helper: 'Cidade da extração' },
] as const

// ---------------------------------------------------------------------------
// Página principal
// ---------------------------------------------------------------------------

export function ZapVoiceCampaignsPage() {
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

  // form de "Nova Campanha"
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTag, setNewTag] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const selected = useMemo(
    () => campaigns.find((c) => c.id === selectedId) ?? null,
    [campaigns, selectedId],
  )

  /** Quantos leads do usuário casam com a tag da campanha selecionada. */
  const audienceCount = useMemo(() => {
    if (!selected?.audience_tag) return 0
    const found = audienceOptions.find((o) => o.tag === selected.audience_tag)
    return found?.count ?? 0
  }, [audienceOptions, selected])

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
        'id, user_id, name, description, audience_tag, status, default_delay_seconds, created_at, updated_at',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (list.error) {
      setError(`Falha ao listar campanhas: ${list.error.message}`)
      setLoading(false)
      return
    }

    const rows = (list.data ?? []) as Campaign[]
    setCampaigns(rows)
    setSelectedId((prev) => {
      if (prev && rows.some((r) => r.id === prev)) return prev
      return rows[0]?.id ?? null
    })

    await loadAudienceOptions(user.id)
    setLoading(false)
  }, [loadAudienceOptions])

  const loadSteps = useCallback(async (campaignId: string) => {
    setStepsLoading(true)
    const { data, error: e } = await supabase
      .from('zv_funnels')
      .select(
        'id, campaign_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, created_at, updated_at',
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
    if (!selectedId) {
      setSteps([])
      return
    }
    void loadSteps(selectedId)
  }, [selectedId, loadSteps])

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
      const insert = await supabase
        .from('zv_campaigns')
        .insert({
          user_id: userId,
          name: newName.trim(),
          description: newDescription.trim() || null,
          audience_tag: newTag.trim() || null,
          status: 'draft' as CampaignStatus,
          default_delay_seconds: 60,
        })
        .select(
          'id, user_id, name, description, audience_tag, status, default_delay_seconds, created_at, updated_at',
        )
        .single()
      if (insert.error || !insert.data) {
        throw new Error(insert.error?.message ?? 'Falha ao criar campanha.')
      }
      const created = insert.data as Campaign

      // Cria automaticamente uma Etapa 1 vazia para o usuário já editar.
      await supabase.from('zv_funnels').insert({
        campaign_id: created.id,
        step_order: 1,
        message: 'Olá {nome}, tudo bem? Aqui é da equipe Zapifica…',
        media_type: 'text',
        media_url: null,
        delay_seconds: 0,
        expected_trigger: null,
      })

      setCampaigns((prev) => [created, ...prev])
      setSelectedId(created.id)
      setNewOpen(false)
      setNewName('')
      setNewTag('')
      setNewDescription('')
      setSuccess('Campanha criada. Agora monte o roteiro de mensagens.')
      window.setTimeout(() => setSuccess(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao criar campanha.')
    } finally {
      setCreating(false)
    }
  }, [newName, newDescription, newTag, userId])

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
      setCampaigns((prev) => prev.filter((c) => c.id !== id))
      setSelectedId((prev) => {
        if (prev === id) {
          const remaining = campaigns.filter((c) => c.id !== id)
          return remaining[0]?.id ?? null
        }
        return prev
      })
    },
    [campaigns],
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
        delay_seconds: selected.default_delay_seconds,
        expected_trigger: null,
      })
      .select(
        'id, campaign_id, step_order, message, media_type, media_url, delay_seconds, expected_trigger, created_at, updated_at',
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
          'message' | 'media_type' | 'media_url' | 'delay_seconds' | 'expected_trigger'
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
            Monte sequências de mensagens para grupos de leads (por tag). Cada
            etapa é uma mensagem com delay e gatilho de resposta — ideal para
            funis de WhatsApp 100% humanizados.
          </p>
        </div>
      </div>

      {/* Painel duplo */}
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* COLUNA ESQUERDA: lista de campanhas */}
        <aside className="rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-sm ring-1 ring-zinc-100/80">
          <div className="flex items-center justify-between gap-2 px-1 pb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Suas campanhas
            </p>
            <span className="text-xs tabular-nums text-zinc-400">
              {campaigns.length}
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
                  Público (tag de extração)
                </label>
                <select
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                >
                  <option value="">— sem tag específica —</option>
                  {audienceOptions.map((o) => (
                    <option key={o.tag} value={o.tag}>
                      {o.tag} ({o.count})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Use a mesma tag que aparece em "Enviar para Zap Voice" no
                  Extrator de Leads.
                </p>
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
            ) : campaigns.length === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-6 text-center text-xs text-zinc-500">
                Você ainda não tem campanhas. Crie a primeira no botão acima.
              </p>
            ) : (
              campaigns.map((c) => {
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
                      <span className="line-clamp-1">
                        {c.audience_tag ? `Tag: ${c.audience_tag}` : 'Sem tag'}
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
                        onClick={() =>
                          void updateCampaign(selected.id, { status: 'active' })
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-600"
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden />
                        Ativar
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void updateCampaign(selected.id, { status: 'paused' })
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-sm transition hover:bg-amber-600"
                      >
                        <Pause className="h-3.5 w-3.5" aria-hidden />
                        Pausar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void updateCampaign(selected.id, { status: 'completed' })
                      }
                      className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
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
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Users className="h-3 w-3" aria-hidden />
                      Público
                    </p>
                    <select
                      value={selected.audience_tag ?? ''}
                      onChange={(e) =>
                        void updateCampaign(selected.id, {
                          audience_tag: e.target.value || null,
                        })
                      }
                      className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    >
                      <option value="">— sem tag —</option>
                      {audienceOptions.map((o) => (
                        <option key={o.tag} value={o.tag}>
                          {o.tag} ({o.count})
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-[11px] font-medium text-zinc-700">
                      <span className="tabular-nums text-brand-700">
                        {audienceCount}
                      </span>{' '}
                      lead{audienceCount === 1 ? '' : 's'} casa{audienceCount === 1 ? '' : 'm'}
                      {' '}com essa tag
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Clock className="h-3 w-3" aria-hidden />
                      Delay padrão entre mensagens
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        value={selected.default_delay_seconds}
                        onChange={(e) => {
                          const v = Math.max(0, Number(e.target.value) || 0)
                          setCampaigns((prev) =>
                            prev.map((c) =>
                              c.id === selected.id
                                ? { ...c, default_delay_seconds: v }
                                : c,
                            ),
                          )
                        }}
                        onBlur={(e) =>
                          void updateCampaign(selected.id, {
                            default_delay_seconds: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-24 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs tabular-nums shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                      />
                      <span className="text-xs text-zinc-500">segundos</span>
                    </div>
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
        'message' | 'media_type' | 'media_url' | 'delay_seconds' | 'expected_trigger'
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
  const [uploading, setUploading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    setMessage(step.message)
    setMediaType(step.media_type)
    setMediaUrl(step.media_url ?? '')
    setDelaySeconds(step.delay_seconds)
    setTrigger(step.expected_trigger ?? '')
  }, [step.id, step.message, step.media_type, step.media_url, step.delay_seconds, step.expected_trigger])

  const mediaNeedsUrl = mediaType !== 'text'
  const dirty =
    message !== step.message ||
    mediaType !== step.media_type ||
    (mediaUrl || '').trim() !== (step.media_url ?? '').trim() ||
    delaySeconds !== step.delay_seconds ||
    (trigger || '') !== (step.expected_trigger ?? '')

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
    onSave({
      message,
      media_type: mediaType,
      media_url: mediaType === 'text' ? null : mediaUrl.trim() || null,
      delay_seconds: delaySeconds,
      expected_trigger: trigger.trim() || null,
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
              Palavras que avançam o lead para a próxima etapa.
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
