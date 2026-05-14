import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, Loader2, Search, X } from 'lucide-react'
import {
  Sidebar,
  type DashboardNavId,
} from '../components/Sidebar'
import { supabase } from '../lib/supabase'
import { useImpersonation } from '../contexts/ImpersonationContext'

type CrmSearchRow = {
  result_type: string
  lead_id: string
  lead_name: string
  phone: string
  snippet: string | null
  message_id: string | null
  msg_created_at: string | null
}

const CRM_OPEN_LEAD_KEY = 'zapifica_crm_open_lead'

type DashboardLayoutProps = {
  /** Chave para animação de troca de tela ao mudar o menu. */
  activeNav: DashboardNavId
  onNavigate: (id: DashboardNavId) => void
  title: string
  children: ReactNode
}

export function DashboardLayout({
  activeNav,
  onNavigate,
  title,
  children,
}: DashboardLayoutProps) {
  const [isSuperadmin, setIsSuperadmin] = useState(false)
  const [leadCredits, setLeadCredits] = useState<number | null>(null)
  const { state: imp } = useImpersonation()

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CrmSearchRow[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const searchDebounceRef = useRef<number | null>(null)

  const [crmActivityHint, setCrmActivityHint] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return
      const effectiveUserId = imp.targetUserId ?? user.id
      const [{ data: myProf }, { data: effProf }] = await Promise.all([
        supabase
          .from('user_profiles')
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('user_profiles')
          .select('lead_credits')
          .eq('user_id', effectiveUserId)
          .maybeSingle(),
      ])
      if (cancelled) return
      const role = (myProf as { role?: string } | null)?.role ?? 'client'
      setIsSuperadmin(role === 'superadmin')
      setLeadCredits((effProf as { lead_credits?: number } | null)?.lead_credits ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [imp.targetUserId])

  const effectiveUserIdForRpc = useCallback(async (): Promise<string | null> => {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return null
    return imp.targetUserId ?? user.id
  }, [imp.targetUserId])

  useEffect(() => {
    if (searchDebounceRef.current != null) {
      window.clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }

    const q = searchQuery.trim()
    if (q.length < 2) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }

    setSearchLoading(true)
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null
      void (async () => {
        const tenant = await effectiveUserIdForRpc()
        if (!tenant) {
          setSearchResults([])
          setSearchLoading(false)
          return
        }
        const { data, error } = await supabase.rpc('crm_global_search', {
          p_user_id: tenant,
          p_query: q,
          p_limit: 20,
        })
        if (error) {
          setSearchResults([])
        } else {
          setSearchResults((data ?? []) as CrmSearchRow[])
        }
        setSearchLoading(false)
      })()
    }, 320)

    return () => {
      if (searchDebounceRef.current != null) {
        window.clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [searchQuery, effectiveUserIdForRpc])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = searchWrapRef.current
      if (!el) return
      if (e.target instanceof Node && !el.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const refreshCrmBell = useCallback(async () => {
    const tenant = await effectiveUserIdForRpc()
    if (!tenant) {
      setCrmActivityHint(false)
      return
    }
    const { data, error } = await supabase.rpc('crm_recent_client_threads_count', {
      p_user_id: tenant,
    })
    if (error) {
      setCrmActivityHint(false)
      return
    }
    const n = typeof data === 'number' ? data : Number(data)
    setCrmActivityHint(Number.isFinite(n) && n > 0)
  }, [effectiveUserIdForRpc])

  useEffect(() => {
    void refreshCrmBell()
    const id = window.setInterval(() => void refreshCrmBell(), 45_000)
    return () => window.clearInterval(id)
  }, [refreshCrmBell])

  const openLeadFromSearch = useCallback(
    (leadId: string) => {
      try {
        sessionStorage.setItem(CRM_OPEN_LEAD_KEY, leadId)
      } catch {
        /* ignore */
      }
      setSearchQuery('')
      setSearchResults([])
      setSearchOpen(false)
      onNavigate('crm')
    },
    [onNavigate],
  )

  return (
    <div className="flex min-h-dvh bg-zinc-50">
      <Sidebar active={activeNav} onNavigate={onNavigate} isSuperadmin={isSuperadmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-200/70 bg-white/90 px-6 py-4 shadow-sm shadow-zinc-900/5 backdrop-blur-md">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              {title}
            </h1>
            <p className="text-sm text-zinc-500">
              Visão geral do desempenho da sua equipe e canais.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {leadCredits != null ? (
              <span className="hidden items-center rounded-full bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200 sm:inline-flex">
                Créditos de Busca:{' '}
                <span className="ml-1 tabular-nums text-zinc-900">
                  {leadCredits}
                </span>
                <span className="text-zinc-400">/50</span>
              </span>
            ) : null}
            <div ref={searchWrapRef} className="relative hidden sm:block">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                aria-hidden
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setSearchOpen(true)
                }}
                onFocus={() => setSearchOpen(true)}
                placeholder="Buscar contatos, chats…"
                autoComplete="off"
                className="h-10 w-72 rounded-xl border border-zinc-200 bg-zinc-50 pl-9 pr-9 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-google-blue/50 focus:bg-white"
                aria-expanded={searchOpen}
                aria-controls="global-crm-search-results"
                aria-autocomplete="list"
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 hover:bg-zinc-200/80 hover:text-zinc-700"
                  aria-label="Limpar busca"
                  onClick={() => {
                    setSearchQuery('')
                    setSearchResults([])
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
              {searchOpen && searchQuery.trim().length >= 2 ? (
                <div
                  id="global-crm-search-results"
                  role="listbox"
                  className="absolute right-0 top-[calc(100%+6px)] z-30 max-h-80 w-[min(100vw-2rem,22rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-zinc-900/10"
                >
                  {searchLoading ? (
                    <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Buscando…
                    </div>
                  ) : searchResults.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-zinc-500">Nenhum resultado.</p>
                  ) : (
                    searchResults.map((row) => (
                      <button
                        key={`${row.result_type}-${row.lead_id}-${row.message_id ?? 'lead'}`}
                        type="button"
                        role="option"
                        className="flex w-full flex-col gap-0.5 border-b border-zinc-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-zinc-50"
                        onClick={() => openLeadFromSearch(row.lead_id)}
                      >
                        <span className="text-sm font-semibold text-zinc-900">
                          {row.lead_name}
                          {row.phone ? (
                            <span className="ml-1 font-normal tabular-nums text-zinc-500">
                              · {row.phone}
                            </span>
                          ) : null}
                        </span>
                        {row.result_type === 'message' && row.snippet ? (
                          <span className="line-clamp-2 text-xs text-zinc-600">
                            Mensagem: {row.snippet}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">Contato</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onNavigate('crm')}
              className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 shadow-sm transition hover:border-zinc-300 hover:text-zinc-900"
              aria-label="Abrir CRM e ver atividade recente"
              title="CRM — mensagens recentes de clientes"
            >
              <Bell className="h-4 w-4" />
              {crmActivityHint ? (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
              ) : null}
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6 lg:p-8">
          <div key={activeNav} className="animate-panel-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
