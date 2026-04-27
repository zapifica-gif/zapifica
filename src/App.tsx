import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { DashboardLayout } from './layouts/DashboardLayout'
import { supabase } from './lib/supabase'
import { AgendaPage } from './pages/AgendaPage'
import { AiTrainingPage } from './pages/AiTraining'
import { CrmPage } from './pages/CrmPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { SettingsPage } from './pages/SettingsPage'
import { ZapVoiceCampaignsPage } from './pages/ZapVoiceCampaigns'
import { LeadExtractorPage } from './pages/LeadExtractor'
import type { DashboardNavId } from './components/Sidebar'
import { SuperAdminPage } from './pages/SuperAdmin'
import { ImpersonationProvider, useImpersonation } from './contexts/ImpersonationContext'

function navTitle(id: DashboardNavId): string {
  switch (id) {
    case 'home':
      return 'Início'
    case 'crm':
      return 'CRM / Funil'
    case 'agenda':
      return 'Agenda Suprema'
    case 'ai-training':
      return 'Treinamento IA'
    case 'zv-campaigns':
      return 'Campanhas Zap Voice'
    case 'lead-extractor':
      return 'Extrator de Leads'
    case 'settings':
      return 'Configurações'
    case 'superadmin':
      return 'Painel da Agência'
    default:
      return 'Zapifica'
  }
}

function DashboardContent({
  activeNav,
  onNavigate,
}: {
  activeNav: DashboardNavId
  onNavigate: (id: DashboardNavId) => void
}) {
  switch (activeNav) {
    case 'home':
      return <HomePage />
    case 'crm':
      return <CrmPage />
    case 'agenda':
      return <AgendaPage />
    case 'ai-training':
      return <AiTrainingPage />
    case 'zv-campaigns':
      return <ZapVoiceCampaignsPage />
    case 'lead-extractor':
      return <LeadExtractorPage onOpenZapVoice={() => onNavigate('zv-campaigns')} />
    case 'settings':
      return <SettingsPage />
    case 'superadmin':
      return <SuperAdminPage />
    default:
      return <HomePage />
  }
}

function ImpersonationBanner() {
  const { state, clear } = useImpersonation()
  if (!state.targetUserId) return null
  const label = state.targetCompanyName?.trim() || state.targetUserId.slice(0, 8)
  return (
    <div className="sticky top-0 z-20 border-b border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-900">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          Você está visualizando o painel do cliente <span className="underline">{label}</span>.
        </p>
        <button
          type="button"
          onClick={clear}
          className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs font-bold text-rose-800 hover:bg-rose-100"
        >
          Sair do modo cliente
        </button>
      </div>
    </div>
  )
}

function AuthLoadingScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-950">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 shadow-lg shadow-[0_12px_40px_rgba(106,0,184,0.35)]">
        <div className="h-6 w-6 animate-pulse rounded-md bg-white/30" />
      </div>
      <p className="text-sm font-medium text-zinc-500">Carregando sessão…</p>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [activeNav, setActiveNav] = useState<DashboardNavId>('home')

  useEffect(() => {
    let cancelled = false

    void supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!cancelled) {
        setSession(s)
        setAuthReady(true)
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!cancelled) {
        setSession(s)
        if (!s) {
          setActiveNav('home')
        }
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  if (!authReady) {
    return <AuthLoadingScreen />
  }

  if (!session) {
    return <LoginPage />
  }

  return (
    <ImpersonationProvider>
      <DashboardLayout
        activeNav={activeNav}
        onNavigate={setActiveNav}
        title={navTitle(activeNav)}
      >
        <ImpersonationBanner />
        <DashboardContent activeNav={activeNav} onNavigate={setActiveNav} />
      </DashboardLayout>
    </ImpersonationProvider>
  )
}
