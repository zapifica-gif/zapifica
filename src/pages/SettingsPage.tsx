import { Settings2 } from 'lucide-react'
import { EvolutionConnectionSettings } from '../components/settings/EvolutionConnectionSettings'

export function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <div className="mb-1 flex items-center gap-2 text-zinc-500">
          <Settings2 className="h-5 w-5" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Conta
          </span>
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
          Configurações
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600">
          Integração do WhatsApp e outras conexões técnicas ficam centralizadas
          aqui. Campanhas e funis continuam na aba “Campanhas”.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
        <section className="rounded-2xl border border-zinc-200/90 bg-white p-6 shadow-sm ring-1 ring-zinc-100/80">
          <EvolutionConnectionSettings />
        </section>

        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/40 p-8 text-sm text-zinc-600">
          <h3 className="font-semibold text-zinc-900">Em breve</h3>
          <p className="mt-2 leading-relaxed">
            Time, permissões e outras opções de conta vão completar este painel
            no próximo ciclo.
          </p>
        </div>
      </div>
    </div>
  )
}
