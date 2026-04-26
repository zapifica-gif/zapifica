import { useCallback, useEffect, useState } from 'react'
import { Download, FolderKanban, Loader2, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'

type LeadExtractionSource = 'google_maps' | 'instagram'
type LeadExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed'

type LeadExtractionRow = {
  id: string
  user_id: string
  source: LeadExtractionSource
  search_term: string
  location: string
  requested_amount: number
  status: LeadExtractionStatus
  result_url: string | null
  created_at: string
}

const COUNTRIES = ['Brasil', 'Argentina', 'Chile', 'Paraguai', 'Uruguai'] as const

const statusLabel: Record<LeadExtractionStatus, string> = {
  pending: 'Pendente',
  processing: 'Processando',
  completed: 'Concluída',
  failed: 'Falhou',
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

function downloadTextAsFile(filename: string, text: string) {
  const blob = new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

type LeadExtractorPageProps = {
  onOpenCrm: () => void
}

export function LeadExtractorPage({ onOpenCrm }: LeadExtractorPageProps) {
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [balance, setBalance] = useState(0)
  const [rows, setRows] = useState<LeadExtractionRow[]>([])

  const [source, setSource] = useState<LeadExtractionSource>('google_maps')
  const [searchTerm, setSearchTerm] = useState('')
  const [country, setCountry] = useState('Brasil')
  const [state, setState] = useState('')
  const [city, setCity] = useState('')
  const [requestedAmount, setRequestedAmount] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser()
    if (userErr || !user) {
      setError('Sessão inválida. Entre novamente.')
      setLoading(false)
      return
    }

    const prof = await supabase
      .from('profiles')
      .select('id, extraction_credits')
      .eq('id', user.id)
      .maybeSingle()

    if (prof.error) {
      setError(`Falha ao carregar perfil: ${prof.error.message}`)
      setLoading(false)
      return
    }

    if (!prof.data) {
      const ins = await supabase
        .from('profiles')
        .insert({ id: user.id, phone: null, extraction_credits: 0 })
        .select('id, extraction_credits')
        .single()
      if (ins.error) {
        setError(`Falha ao criar perfil: ${ins.error.message}`)
        setLoading(false)
        return
      }
      setBalance(ins.data.extraction_credits ?? 0)
    } else {
      setBalance(prof.data.extraction_credits ?? 0)
    }

    const list = await supabase
      .from('lead_extractions')
      .select(
        'id, user_id, source, search_term, location, requested_amount, status, result_url, created_at',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (list.error) {
      setError(`Falha ao listar extrações: ${list.error.message}`)
      setLoading(false)
      return
    }

    setRows((list.data ?? []) as LeadExtractionRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (requestedAmount < 1 || requestedAmount > 200) {
      setError('A quantidade deve ser entre 1 e 200 leads.')
      return
    }
    if (!searchTerm.trim()) {
      setError('Informe o termo de busca.')
      return
    }
    if (!country.trim() || !state.trim() || !city.trim()) {
      setError('Preencha país, estado e cidade.')
      return
    }
    if (balance < requestedAmount) {
      setError(
        `Seu saldo (${balance} leads) é menor que a quantidade solicitada (${requestedAmount}).`,
      )
      return
    }

    setSubmitting(true)
    const { data, error: fnError } = await supabase.functions.invoke('apify-extractor', {
      body: {
        source,
        searchTerm: searchTerm.trim(),
        country: country.trim(),
        state: state.trim(),
        city: city.trim(),
        requestedAmount,
      },
    })
    setSubmitting(false)

    const d =
      data && typeof data === 'object'
        ? (data as {
            ok?: boolean
            error?: string
            balance?: number
            newBalance?: number
            refunded?: boolean
          })
        : {}

    if (fnError) {
      if (typeof d.balance === 'number') setBalance(d.balance)
      setError(
        d.error && typeof d.error === 'string'
          ? d.error
          : `Não foi possível iniciar a extração: ${fnError.message}`,
      )
      void load()
      return
    }

    if (d.ok === false) {
      if (typeof d.balance === 'number') setBalance(d.balance)
      setError(
        d.error ??
          (d.refunded
            ? 'A requisição à Apify falhou; o saldo foi reposto. Tente de novo em instantes.'
            : 'Falha na extração.'),
      )
      void load()
      return
    }

    if (d.ok) {
      if (typeof d.newBalance === 'number') setBalance(d.newBalance)
      setMessage('Extração enfileirada. O processamento ocorre na Apify; você verá o status abaixo.')
      void load()
    } else {
      setError('Resposta inesperada do servidor.')
    }
  }

  function exportRowCsv(r: LeadExtractionRow) {
    const head = 'termo,localizacao,data,quantidade,fonte,status,url_resultado\n'
    const line = [
      r.search_term,
      r.location,
      r.created_at,
      String(r.requested_amount),
      r.source,
      r.status,
      r.result_url ?? '',
    ]
      .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
      .join(',')
    downloadTextAsFile(`extracao-${r.id.slice(0, 8)}.csv`, head + line)
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">Extrator de Leads</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600">
          Busque negócios no Google Maps ou perfis no Instagram. O consumo é contabilizado no seu
          saldo e o histórico fica abaixo.
        </p>
      </div>

      <div className="rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-white via-white to-brand-50/50 p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600/10 text-brand-700">
              <Search className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium text-zinc-500">Seu saldo</p>
              <p className="text-2xl font-semibold tabular-nums text-zinc-900">
                {loading ? '—' : `${balance} leads`}
              </p>
            </div>
          </div>
          <p className="max-w-sm text-right text-xs leading-relaxed text-zinc-500">
            Cada lead solicitado reserva 1 unidade do saldo no momento do disparo. Ajuste o saldo
            com o time Zapifica, se necessário.
          </p>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-1">
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-sm"
        >
          <h3 className="text-base font-semibold text-zinc-900">Nova busca</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Preencha os campos e clique em extrair. Validação e débito ocorrem no servidor.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-source">
                Fonte de busca
              </label>
              <select
                id="le-source"
                value={source}
                onChange={(e) => setSource(e.target.value as LeadExtractionSource)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none ring-brand-600/0 transition focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              >
                <option value="google_maps">Google Maps</option>
                <option value="instagram">Instagram</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-term">
                Termo de busca
              </label>
              <input
                id="le-term"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Ex.: petshops, auto peças, clínicas"
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-country">
                País
              </label>
              <select
                id="le-country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              >
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-state">
                Estado
              </label>
              <input
                id="le-state"
                value={state}
                onChange={(e) => setState(e.target.value.toUpperCase())}
                placeholder="Ex.: SC"
                maxLength={2}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-city">
                Cidade
              </label>
              <input
                id="le-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Ex.: Florianópolis"
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700" htmlFor="le-qty">
                Quantidade de leads (máx. 200)
              </label>
              <input
                id="le-qty"
                type="number"
                min={1}
                max={200}
                value={requestedAmount}
                onChange={(e) => setRequestedAmount(Number(e.target.value) || 0)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
            </div>
          </div>

          {error ? (
            <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
              {message}
            </p>
          ) : null}

          <div className="mt-6">
            <button
              type="submit"
              disabled={submitting || loading}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[0_8px_24px_rgba(106,0,184,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Iniciando…
                </>
              ) : (
                'Extrair leads'
              )}
            </button>
          </div>
        </form>
      </div>

      <section>
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Suas extrações recentes
        </h3>
        <div className="overflow-x-auto rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50/80">
                <th className="px-4 py-3 font-medium text-zinc-700">Termo</th>
                <th className="px-4 py-3 font-medium text-zinc-700">Localização</th>
                <th className="px-4 py-3 font-medium text-zinc-700">Data</th>
                <th className="px-4 py-3 font-medium text-zinc-700">Qtd</th>
                <th className="px-4 py-3 font-medium text-zinc-700">Status</th>
                <th className="px-4 py-3 text-right font-medium text-zinc-700">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-zinc-500"
                  >
                    Nenhuma extração ainda. Faça a primeira busca acima.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-zinc-100 last:border-0"
                >
                  <td className="px-4 py-3 text-zinc-900">{r.search_term}</td>
                  <td className="px-4 py-3 text-zinc-600">{r.location}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatDateBr(r.created_at)}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-900">{r.requested_amount}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        r.status === 'failed'
                          ? 'bg-red-50 text-red-800 ring-1 ring-red-200'
                          : r.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                            : r.status === 'processing'
                              ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200'
                              : 'bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200'
                      }`}
                    >
                      {statusLabel[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => exportRowCsv(r)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Exportar CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenCrm()}
                        className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50/80 px-2.5 py-1.5 text-xs font-medium text-brand-900 transition hover:bg-brand-100"
                      >
                        <FolderKanban className="h-3.5 w-3.5" />
                        Enviar para o CRM
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500">Carregando…</p>
        ) : null}
      </section>
    </div>
  )
}
