import { useEffect, useMemo, useState } from 'react'
import { Activity, MessageSquare, TrendingUp, Users, Zap } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { StatCard } from '../components/StatCard'
import { supabase } from '../lib/supabase'

type UserProfileRow = {
  role: 'client' | 'superadmin' | string
  company_name: string | null
  company_logo_url: string | null
}

type LeadRow = {
  id: string
  name: string
  phone: string | null
  source: string | null
  tag: string | null
  created_at: string
}

type ActiveCampaignRow = {
  id: string
  name: string
  status: string
  updated_at: string
  scheduled_start_at: string | null
}

function prettyPhone(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (!d) return '—'
  const tail = d.startsWith('55') ? d.slice(2) : d
  if (tail.length === 11) return `(${tail.slice(0, 2)}) ${tail.slice(2, 7)}-${tail.slice(7)}`
  if (tail.length === 10) return `(${tail.slice(0, 2)}) ${tail.slice(2, 6)}-${tail.slice(6)}`
  return `+${d}`
}

function formatDayBr(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  } catch {
    return iso
  }
}

function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-xl bg-zinc-200/70 ${className}`} />
}

export function HomePage() {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<UserProfileRow | null>(null)
  const [counts, setCounts] = useState<{
    leads: number
    activeCampaigns: number
    messages: number
  } | null>(null)
  const [latestLeads, setLatestLeads] = useState<LeadRow[]>([])
  const [activeCampaigns, setActiveCampaigns] = useState<ActiveCampaignRow[]>([])
  const [trend, setTrend] = useState<Array<{ day: string; leads: number }>>([])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      setLoading(true)
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        if (!cancelled) setLoading(false)
        return
      }

      const uid = user.id

      const profQ = supabase
        .from('user_profiles')
        .select('role, company_name, company_logo_url')
        .eq('user_id', uid)
        .maybeSingle()

      const leadsCountQ = supabase
        .from('leads')
        .select('*', { head: true, count: 'exact' })
        .eq('user_id', uid)

      const activeCampaignsCountQ = supabase
        .from('zv_campaigns')
        .select('*', { head: true, count: 'exact' })
        .eq('user_id', uid)
        .eq('status', 'active')

      const messagesCountQ = supabase
        .from('scheduled_messages')
        .select('*', { head: true, count: 'exact' })
        .eq('user_id', uid)

      const latestLeadsQ = supabase
        .from('leads')
        .select('id, name, phone, source, tag, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(10)

      const activeCampaignsQ = supabase
        .from('zv_campaigns')
        .select('id, name, status, updated_at, scheduled_start_at')
        .eq('user_id', uid)
        .in('status', ['active', 'paused', 'draft'])
        .order('updated_at', { ascending: false })
        .limit(6)

      // Trend: últimos 14 dias
      const since = new Date()
      since.setDate(since.getDate() - 13)
      since.setHours(0, 0, 0, 0)
      const trendQ = supabase
        .from('leads')
        .select('created_at')
        .eq('user_id', uid)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: true })

      const [profR, leadsCountR, actCountR, msgCountR, latestR, actR, trendR] =
        await Promise.all([
          profQ,
          leadsCountQ,
          activeCampaignsCountQ,
          messagesCountQ,
          latestLeadsQ,
          activeCampaignsQ,
          trendQ,
        ])

      if (cancelled) return

      setProfile((profR.data as UserProfileRow | null) ?? null)
      setCounts({
        leads: leadsCountR.count ?? 0,
        activeCampaigns: actCountR.count ?? 0,
        messages: msgCountR.count ?? 0,
      })
      setLatestLeads((latestR.data as LeadRow[] | null) ?? [])
      setActiveCampaigns((actR.data as ActiveCampaignRow[] | null) ?? [])

      const buckets = new Map<string, number>()
      for (let i = 0; i < 14; i += 1) {
        const d = new Date(since.getTime())
        d.setDate(d.getDate() + i)
        const key = d.toISOString().slice(0, 10)
        buckets.set(key, 0)
      }
      for (const row of ((trendR.data ?? []) as { created_at: string }[])) {
        const k = row.created_at.slice(0, 10)
        buckets.set(k, (buckets.get(k) ?? 0) + 1)
      }
      const series = [...buckets.entries()].map(([isoDay, n]) => ({
        day: formatDayBr(isoDay),
        leads: n,
      }))
      setTrend(series)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const companyName = (profile?.company_name ?? '').trim() || 'Zapifica'
  const logoUrl = (profile?.company_logo_url ?? '').trim() || null
  const role = profile?.role ?? 'client'

  const lastSyncLabel = useMemo(() => {
    const d = new Date()
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }, [])

  const trendTotal = useMemo(
    () => trend.reduce((acc, x) => acc + x.leads, 0),
    [trend],
  )

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-white via-white to-brand-50/80 p-6 shadow-sm lg:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-brand-600">Painel de controle</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
              Olá, equipe {companyName}
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600">
              Acompanhe leads, campanhas e mensagens em tempo real — com dados do
              seu workspace.
            </p>
          </div>
          <div className="flex gap-2">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt="Logo da empresa"
                className="h-8 w-8 rounded-full border border-white/70 object-cover shadow-sm ring-1 ring-zinc-200"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold text-zinc-600 ring-1 ring-zinc-200">
                {companyName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/15">
              Tudo operacional
            </span>
            <span className="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600">
              Última atualização: {lastSyncLabel}
            </span>
            {role === 'superadmin' ? (
              <span className="inline-flex items-center rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800 ring-1 ring-brand-200">
                Superadmin
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Indicadores principais
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard
            title="Leads capturados"
            value={loading ? '—' : String(counts?.leads ?? 0)}
            subtitle="Total do seu workspace"
            icon={Users}
            trend={
              loading
                ? 'Carregando…'
                : `${trendTotal} lead${trendTotal === 1 ? '' : 's'} nos últimos 14 dias`
            }
          />
          <StatCard
            title="Mensagens na fila"
            value={loading ? '—' : String(counts?.messages ?? 0)}
            subtitle="scheduled_messages do seu usuário"
            icon={MessageSquare}
            trend={loading ? 'Carregando…' : 'Inclui campanhas e agendamentos do CRM.'}
          />
          <StatCard
            title="Campanhas ativas"
            value={loading ? '—' : String(counts?.activeCampaigns ?? 0)}
            subtitle="Zap Voice rodando agora"
            icon={TrendingUp}
            trend={loading ? 'Carregando…' : 'Status: active'}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-zinc-900">
                Evolução de leads
              </h3>
              <p className="mt-1 text-sm text-zinc-600">
                Últimos 14 dias (capturas no CRM).
              </p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">
              <Activity className="h-3.5 w-3.5" aria-hidden />
              {loading ? 'Carregando…' : `${trendTotal} no período`}
            </span>
          </div>
          <div className="mt-5 h-56">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="leadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(106,0,184)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="rgb(106,0,184)" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="rgba(0,0,0,0.06)" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 12,
                      border: '1px solid rgba(0,0,0,0.08)',
                      boxShadow: '0 18px 50px rgba(0,0,0,0.10)',
                    }}
                    labelStyle={{ fontSize: 12, fontWeight: 700 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="leads"
                    stroke="rgb(106,0,184)"
                    strokeWidth={2}
                    fill="url(#leadFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200/80 bg-zinc-900 p-6 text-zinc-100 shadow-sm ring-1 ring-zinc-800">
          <h3 className="text-base font-semibold text-white">
            Campanhas rodando agora
          </h3>
          <p className="mt-1 text-sm text-zinc-400">
            Zap Voice (draft/paused/active) do seu usuário.
          </p>
          <div className="mt-6 space-y-2">
            {loading ? (
              <>
                <Skeleton className="h-10 w-full bg-zinc-800/70" />
                <Skeleton className="h-10 w-full bg-zinc-800/70" />
                <Skeleton className="h-10 w-full bg-zinc-800/70" />
              </>
            ) : activeCampaigns.length === 0 ? (
              <p className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-4 text-sm text-zinc-400">
                Nenhuma campanha por aqui ainda. Crie uma em “Campanhas Zap Voice”.
              </p>
            ) : (
              activeCampaigns.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/30 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="line-clamp-1 text-sm font-semibold text-white">
                      {c.name}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      {c.status === 'active'
                        ? 'Ativa'
                        : c.status === 'paused'
                          ? 'Pausada'
                          : 'Rascunho'}
                      {c.scheduled_start_at ? ` · Início: ${formatDayBr(c.scheduled_start_at)}` : ''}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-xs font-semibold text-zinc-200 ring-1 ring-white/10">
                    <Zap className="h-3.5 w-3.5" aria-hidden />
                    {c.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-zinc-900">
              Últimos leads capturados
            </h3>
            <p className="mt-1 text-sm text-zinc-600">
              Os registros mais recentes do seu CRM.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {loading ? 'Carregando…' : `${latestLeads.length} recentes`}
          </span>
        </div>

        <div className="mt-5 overflow-x-auto">
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : latestLeads.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-10 text-center text-sm text-zinc-500">
              Nenhum lead ainda. Comece pelo Extrator, importação CSV na base ou Meta.
            </p>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50/70 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-3">Nome</th>
                  <th className="px-4 py-3">Telefone</th>
                  <th className="px-4 py-3">Origem</th>
                  <th className="px-4 py-3">Tag</th>
                  <th className="px-4 py-3">Criado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {latestLeads.map((l) => (
                  <tr key={l.id} className="hover:bg-zinc-50/40">
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {l.name || 'Sem nome'}
                    </td>
                    <td className="px-4 py-3 text-zinc-700 tabular-nums">
                      {prettyPhone(l.phone)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
                        {l.source ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">{l.tag ?? '—'}</td>
                    <td className="px-4 py-3 text-zinc-500 tabular-nums">
                      {formatDayBr(l.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
