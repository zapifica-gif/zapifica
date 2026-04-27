import { useEffect, useMemo, useState } from 'react'
import { Building2, Database, Loader2, LogIn, Plus, Shield } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useImpersonation } from '../contexts/ImpersonationContext'

type Tab = 'clientes' | 'biblioteca'

type UserProfileRow = {
  user_id: string
  role: string
  company_name: string | null
  company_logo_url: string | null
  created_at: string
}

type LeadRow = {
  id: string
  user_id: string
  name: string
  phone: string | null
  source: string | null
  tag: string | null
  created_at: string
}

function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-xl bg-zinc-200/70 ${className}`} />
}

function prettyPhone(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (!d) return '—'
  const tail = d.startsWith('55') ? d.slice(2) : d
  if (tail.length === 11) return `(${tail.slice(0, 2)}) ${tail.slice(2, 7)}-${tail.slice(7)}`
  if (tail.length === 10) return `(${tail.slice(0, 2)}) ${tail.slice(2, 6)}-${tail.slice(6)}`
  return `+${d}`
}

function formatDateBr(iso: string): string {
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

async function callCreateTenant(payload: {
  email: string
  password: string
  company_name: string
  company_logo_url: string
}): Promise<{ ok: boolean; error: string | null }> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  if (!token) return { ok: false, error: 'Sessão inválida. Faça login novamente.' }

  const base = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
  const url = `${base}/functions/v1/create-tenant`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  if (!res.ok) {
    return { ok: false, error: raw.slice(0, 600) || `HTTP ${res.status}` }
  }
  return { ok: true, error: null }
}

export function SuperAdminPage() {
  const { impersonate } = useImpersonation()
  const [tab, setTab] = useState<Tab>('clientes')
  const [loading, setLoading] = useState(true)
  const [isSuper, setIsSuper] = useState(false)
  const [meCompany, setMeCompany] = useState<string>('Agência')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [clients, setClients] = useState<UserProfileRow[]>([])
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [companyByUser, setCompanyByUser] = useState<Map<string, string>>(new Map())

  // form create tenant
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [creating, setCreating] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        if (!cancelled) setLoading(false)
        return
      }
      const uid = user.id
      const { data: prof, error: pErr } = await supabase
        .from('user_profiles')
        .select('role, company_name')
        .eq('user_id', uid)
        .maybeSingle()
      if (pErr) {
        if (!cancelled) setError(pErr.message)
        if (!cancelled) setLoading(false)
        return
      }
      const role = (prof as { role?: string } | null)?.role ?? 'client'
      const cn = (prof as { company_name?: string | null } | null)?.company_name ?? 'Agência'
      if (!cancelled) {
        setIsSuper(role === 'superadmin')
        setMeCompany((cn ?? '').trim() || 'Agência')
      }
      if (role !== 'superadmin') {
        if (!cancelled) setLoading(false)
        return
      }

      const { data: all, error: listErr } = await supabase
        .from('user_profiles')
        .select('user_id, role, company_name, company_logo_url, created_at')
        .eq('role', 'client')
        .order('created_at', { ascending: false })
      if (listErr) {
        if (!cancelled) setError(listErr.message)
        if (!cancelled) setLoading(false)
        return
      }
      const rows = (all ?? []) as UserProfileRow[]
      const map = new Map<string, string>()
      for (const r of rows) {
        map.set(r.user_id, (r.company_name ?? '').trim() || 'Sem nome')
      }
      if (!cancelled) {
        setClients(rows)
        setCompanyByUser(map)
      }

      // biblioteca global (carrega leve por padrão)
      const { data: ld, error: ldErr } = await supabase
        .from('leads')
        .select('id, user_id, name, phone, source, tag, created_at')
        .order('created_at', { ascending: false })
        .limit(200)
      if (ldErr) {
        if (!cancelled) setError(ldErr.message)
        if (!cancelled) setLoading(false)
        return
      }
      if (!cancelled) {
        setLeads((ld ?? []) as LeadRow[])
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const canRender = !loading && isSuper

  const leadsWithCompany = useMemo(() => {
    return leads.map((l) => ({
      ...l,
      company: companyByUser.get(l.user_id) ?? l.user_id.slice(0, 8),
    }))
  }, [leads, companyByUser])

  const handleCreate = async () => {
    setError(null)
    setSuccess(null)
    const e = email.trim().toLowerCase()
    const p = password.trim()
    if (!e || !p) {
      setError('Informe e-mail e senha.')
      return
    }
    setCreating(true)

    let logoUrl = ''
    if (logoFile) {
      setUploadingLogo(true)
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setUploadingLogo(false)
        setCreating(false)
        setError('Sessão inválida. Faça login novamente.')
        return
      }
      const safeName = logoFile.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'logo'
      const path = `${user.id}/${Date.now()}_${safeName}`
      const up = await supabase.storage
        .from('company_logos')
        .upload(path, logoFile, { upsert: true, cacheControl: '3600' })
      if (up.error) {
        setUploadingLogo(false)
        setCreating(false)
        setError(`Falha ao enviar logo: ${up.error.message}`)
        return
      }
      const { data: pub } = supabase.storage.from('company_logos').getPublicUrl(path)
      logoUrl = pub.publicUrl
      setUploadingLogo(false)
    }

    const r = await callCreateTenant({
      email: e,
      password: p,
      company_name: companyName.trim(),
      company_logo_url: logoUrl,
    })
    setCreating(false)
    if (!r.ok) {
      setError(r.error ?? 'Falha ao criar cliente.')
      return
    }
    setSuccess('Cliente criado com sucesso.')
    setEmail('')
    setPassword('')
    setCompanyName('')
    setLogoFile(null)
    // refresh list
    const { data: all } = await supabase
      .from('user_profiles')
      .select('user_id, role, company_name, company_logo_url, created_at')
      .eq('role', 'client')
      .order('created_at', { ascending: false })
    const rows = (all ?? []) as UserProfileRow[]
    setClients(rows)
    const map = new Map<string, string>()
    for (const r2 of rows) {
      map.set(r2.user_id, (r2.company_name ?? '').trim() || 'Sem nome')
    }
    setCompanyByUser(map)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    )
  }

  if (!isSuper) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600/10 text-brand-700 ring-1 ring-brand-200">
            <Shield className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Acesso restrito</h2>
            <p className="text-sm text-zinc-600">
              Este painel é exclusivo para superadmin.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {success ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 shadow-sm ring-1 ring-emerald-100">
          {success}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900 shadow-sm ring-1 ring-rose-100">
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-white via-white to-zinc-50 p-6 shadow-sm lg:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-brand-600">Painel Supremo</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
              Olá, {meCompany}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-600">
              Gestão multi-tenant: crie clientes, acesse como cliente e explore a
              biblioteca global.
            </p>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800 ring-1 ring-brand-200">
              Superadmin
            </span>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-1 border-b border-zinc-200/90">
        <button
          type="button"
          onClick={() => setTab('clientes')}
          className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
            tab === 'clientes'
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <Building2 className="h-4 w-4" aria-hidden />
          Gestão de clientes
        </button>
        <button
          type="button"
          onClick={() => setTab('biblioteca')}
          className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
            tab === 'biblioteca'
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <Database className="h-4 w-4" aria-hidden />
          Biblioteca global de leads
        </button>
      </div>

      {canRender && tab === 'clientes' ? (
        <div className="grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-zinc-900">
                Cadastrar novo cliente
              </h3>
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
                create-tenant
              </span>
            </div>
            <div className="mt-5 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  E-mail
                </label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="cliente@empresa.com"
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Senha
                </label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Senha forte (mín. 8)"
                  type="password"
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Nome da empresa
                </label>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Petshop do João"
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Logo da empresa (arquivo)
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-zinc-700 hover:file:bg-zinc-200/70 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Enviamos para o bucket `company_logos` e salvamos a URL pública no perfil.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || uploadingLogo}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-bold text-white shadow-[0_10px_32px_rgba(106,0,184,0.30)] transition hover:bg-brand-700 disabled:opacity-60"
              >
                {creating || uploadingLogo ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden />
                )}
                {uploadingLogo ? 'Enviando logo…' : 'Criar cliente'}
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                A conta é criada com e-mail confirmado. Depois você pode acessar
                como cliente via impersonation.
              </p>
            </div>
          </aside>

          <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-zinc-900">
                  Clientes cadastrados
                </h3>
                <p className="mt-1 text-sm text-zinc-600">
                  Lista de `user_profiles` com role `client`.
                </p>
              </div>
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
                {clients.length}
              </span>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50/70 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    <th className="px-4 py-3">Empresa</th>
                    <th className="px-4 py-3">Logo</th>
                    <th className="px-4 py-3">UID</th>
                    <th className="px-4 py-3">Criado em</th>
                    <th className="px-4 py-3">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {clients.map((c) => (
                    <tr key={c.user_id} className="hover:bg-zinc-50/40">
                      <td className="px-4 py-3 font-medium text-zinc-900">
                        {(c.company_name ?? '').trim() || 'Sem nome'}
                      </td>
                      <td className="px-4 py-3">
                        {c.company_logo_url ? (
                          <img
                            src={c.company_logo_url}
                            alt="logo"
                            className="h-8 w-8 rounded-full border border-zinc-200 object-cover"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-zinc-100 ring-1 ring-zinc-200" />
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-600">
                        {c.user_id}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 tabular-nums">
                        {formatDateBr(c.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                          title="Acessar como cliente"
                          onClick={() => {
                            const name =
                              (c.company_name ?? '').trim() || c.user_id.slice(0, 8)
                            impersonate({
                              targetUserId: c.user_id,
                              targetCompanyName: name,
                            })
                          }}
                        >
                          <LogIn className="h-3.5 w-3.5" aria-hidden />
                          Acessar painel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {canRender && tab === 'biblioteca' ? (
        <section className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-zinc-900">
                Biblioteca global de leads
              </h3>
              <p className="mt-1 text-sm text-zinc-600">
                Últimos 200 leads do sistema (superadmin).
              </p>
            </div>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
              {leads.length}
            </span>
          </div>
          <div className="mt-5 space-y-3">
            {(() => {
              const groups = new Map<string, Array<(typeof leadsWithCompany)[number]>>()
              for (const l of leadsWithCompany) {
                const key = l.company
                const arr = groups.get(key) ?? []
                arr.push(l)
                groups.set(key, arr)
              }
              const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
              return ordered.map(([company, rows]) => (
                <details
                  key={company}
                  className="group overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-gradient-to-r from-zinc-50 to-white px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900">
                        {company}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        Total de leads capturados: <span className="font-semibold tabular-nums text-zinc-700">{rows.length}</span>
                      </p>
                    </div>
                    <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
                      {rows.length}
                    </span>
                  </summary>
                  <div className="overflow-x-auto border-t border-zinc-100">
                    <table className="w-full min-w-[920px] border-collapse text-left text-sm">
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
                        {rows.map((l) => (
                          <tr key={l.id} className="hover:bg-zinc-50/40">
                            <td className="px-4 py-3 text-zinc-800">{l.name}</td>
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
                              {formatDateBr(l.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))
            })()}
          </div>
          <p className="mt-3 text-[11px] text-zinc-500">
            Dica: isso já é a “gaveta por cliente”. Próximo passo é paginação e filtros por origem/tag.
          </p>
        </section>
      ) : null}
    </div>
  )
}

