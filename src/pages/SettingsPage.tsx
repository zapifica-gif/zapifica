import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { EvolutionConnectionSettings } from '../components/settings/EvolutionConnectionSettings'
import { supabase } from '../lib/supabase'

type UserSettingsRow = {
  user_id: string
  agencia_nome: string | null
  vendedor_primeiro_nome: string | null
  telefone_contato: string | null
  instagram_empresa: string | null
  site_empresa: string | null
  avalie_google: string | null
  endereco: string | null
  telefones: string[]
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)

  const [agenciaNome, setAgenciaNome] = useState('')
  const [vendedorPrimeiroNome, setVendedorPrimeiroNome] = useState('')
  const [telefoneContato, setTelefoneContato] = useState('')
  const [instagramEmpresa, setInstagramEmpresa] = useState('')
  const [siteEmpresa, setSiteEmpresa] = useState('')
  const [avalieGoogle, setAvalieGoogle] = useState('')
  const [endereco, setEndereco] = useState('')
  const [telefonesRaw, setTelefonesRaw] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      const { data } = await supabase.auth.getUser()
      const uid = data.user?.id ?? null
      if (!uid) {
        if (!cancelled) {
          setError('Sessão inválida. Entre novamente.')
          setLoading(false)
        }
        return
      }
      setUserId(uid)

      const { data: row, error: e } = await supabase
        .from('user_settings')
        .select(
          'user_id, agencia_nome, vendedor_primeiro_nome, telefone_contato, instagram_empresa, site_empresa, avalie_google, endereco, telefones',
        )
        .eq('user_id', uid)
        .maybeSingle()
      if (cancelled) return
      if (e) {
        setError(`Falha ao carregar configurações: ${e.message}`)
        setLoading(false)
        return
      }

      const r = (row as UserSettingsRow | null) ?? null
      setAgenciaNome((r?.agencia_nome ?? '').trim())
      setVendedorPrimeiroNome((r?.vendedor_primeiro_nome ?? '').trim())
      setTelefoneContato((r?.telefone_contato ?? '').trim())
      setInstagramEmpresa((r?.instagram_empresa ?? '').trim())
      setSiteEmpresa((r?.site_empresa ?? '').trim())
      setAvalieGoogle((r?.avalie_google ?? '').trim())
      setEndereco((r?.endereco ?? '').trim())
      setTelefonesRaw((r?.telefones ?? []).filter(Boolean).join(' / '))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (!userId) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const telefones = telefonesRaw
        .split('/')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20)

      const payload = {
        user_id: userId,
        agencia_nome: agenciaNome.trim() || null,
        vendedor_primeiro_nome: vendedorPrimeiroNome.trim() || null,
        telefone_contato: telefoneContato.trim() || null,
        instagram_empresa: instagramEmpresa.trim() || null,
        site_empresa: siteEmpresa.trim() || null,
        avalie_google: avalieGoogle.trim() || null,
        endereco: endereco.trim() || null,
        telefones,
      }

      const { error: e } = await supabase
        .from('user_settings')
        .upsert(payload, { onConflict: 'user_id' })
      if (e) throw new Error(e.message)

      setSuccess('Configurações salvas. As tags dinâmicas já passam a funcionar nas próximas mensagens.')
      window.setTimeout(() => setSuccess(null), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

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

        <section className="rounded-2xl border border-zinc-200/90 bg-white p-6 shadow-sm ring-1 ring-zinc-100/80">
          <h3 className="text-base font-semibold text-zinc-900">
            Dados da Empresa (para tags dinâmicas)
          </h3>
          <p className="mt-1 text-sm text-zinc-600">
            Aqui você configura os dados que aparecem automaticamente nas mensagens, via tags como{' '}
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs text-brand-700">
              {'{agencia_nome}'}
            </code>{' '}
            e{' '}
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs text-brand-700">
              {'{telefone_contato}'}
            </code>
            . Você não edita e-mail/senha aqui.
          </p>

          {error ? (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
              {success}
            </div>
          ) : null}

          {loading ? (
            <p className="mt-4 text-sm text-zinc-500">Carregando…</p>
          ) : (
            <div className="mt-5 grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Nome da Agência/Empresa
                  </label>
                  <input
                    value={agenciaNome}
                    onChange={(e) => setAgenciaNome(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Primeiro nome do vendedor
                  </label>
                  <input
                    value={vendedorPrimeiroNome}
                    onChange={(e) => setVendedorPrimeiroNome(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Telefone de contato (principal)
                  </label>
                  <input
                    value={telefoneContato}
                    onChange={(e) => setTelefoneContato(e.target.value)}
                    placeholder="(47) 99999-9999"
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Telefones (lista)
                  </label>
                  <input
                    value={telefonesRaw}
                    onChange={(e) => setTelefonesRaw(e.target.value)}
                    placeholder="(47) 99999-9999 / (48) 98888-8888"
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Separe por <b>/</b>. Usado na tag <b>{'{telefones}'}</b>.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Instagram da empresa
                  </label>
                  <input
                    value={instagramEmpresa}
                    onChange={(e) => setInstagramEmpresa(e.target.value)}
                    placeholder="@suaempresa"
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700">
                    Site
                  </label>
                  <input
                    value={siteEmpresa}
                    onChange={(e) => setSiteEmpresa(e.target.value)}
                    placeholder="https://…"
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Link “Avalie no Google”
                </label>
                <input
                  value={avalieGoogle}
                  onChange={(e) => setAvalieGoogle(e.target.value)}
                  placeholder="https://g.page/…/review"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-700">
                  Endereço
                </label>
                <input
                  value={endereco}
                  onChange={(e) => setEndereco(e.target.value)}
                  placeholder="Rua…, 123 — Bairro — Cidade/UF"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>

              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center justify-center rounded-xl bg-brand-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
