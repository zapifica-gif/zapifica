import { useEffect, useState, type ReactNode } from 'react'
import { Bell, Search } from 'lucide-react'
import {
  Sidebar,
  type DashboardNavId,
} from '../components/Sidebar'
import { supabase } from '../lib/supabase'
import { useImpersonation } from '../contexts/ImpersonationContext'

type DashboardLayoutProps = {
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

  return (
    <div className="flex min-h-dvh bg-zinc-50">
      <Sidebar active={activeNav} onNavigate={onNavigate} isSuperadmin={isSuperadmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-200/80 bg-white/80 px-6 py-4 backdrop-blur-md">
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
            <div className="relative hidden sm:block">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                aria-hidden
              />
              <input
                type="search"
                placeholder="Buscar contatos, chats…"
                className="h-10 w-64 rounded-xl border border-zinc-200 bg-zinc-50 pl-9 pr-3 text-sm text-zinc-900 outline-none ring-brand-600/0 transition placeholder:text-zinc-400 focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
            </div>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 shadow-sm transition hover:border-zinc-300 hover:text-zinc-900"
              aria-label="Notificações"
            >
              <Bell className="h-4 w-4" />
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6 lg:p-8">{children}</main>
      </div>
    </div>
  )
}
