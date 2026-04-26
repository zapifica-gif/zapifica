import { useCallback, useEffect, useMemo, useState, type ChangeEventHandler } from 'react'
import { Download, Loader2, Search, UserPlus, Users2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  CSV_TEMPLATE,
  findNameColumn,
  findPhoneColumn,
  parseSimpleCsv,
  phoneDigitsForLead,
} from '../../lib/csvImport'
import {
  fetchGoogleContacts,
  getGoogleProviderToken,
} from '../../lib/googleContactsImport'

const SOURCE_DEFS: { id: string; label: string; className: string }[] = [
  { id: 'google_maps', label: 'Google Maps', className: 'bg-sky-50 text-sky-900 ring-sky-200' },
  { id: 'instagram', label: 'Instagram', className: 'bg-fuchsia-50 text-fuchsia-900 ring-fuchsia-200' },
  { id: 'manual_csv', label: 'Arquivo', className: 'bg-amber-50 text-amber-900 ring-amber-200' },
  { id: 'google_contacts', label: 'Google Contacts', className: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
]

const NULL_KEY = 'null' // leads sem coluna `source`

function badgeForSource(source: string | null | undefined) {
  const s = source ?? ''
  if (!s) {
    return { label: 'Outro', className: 'bg-zinc-100 text-zinc-700 ring-zinc-200' }
  }
  const f = SOURCE_DEFS.find((x) => x.id === s)
  if (f) return { label: f.label, className: f.className }
  return { label: s, className: 'bg-zinc-100 text-zinc-700 ring-zinc-200' }
}

function importTagLabel(prefix: 'manual' | 'google'): string {
  const d = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  if (prefix === 'manual') return `Importação Manual - ${d}`
  return `Google Contacts - ${d}`
}

type LeadRow = {
  id: string
  name: string
  phone: string | null
  source: string | null
  tag: string | null
  created_at: string
}

type Props = {
  userId: string
  onContactsChanged: () => void
  onError: (msg: string) => void
  onSuccess: (msg: string) => void
}

export function ContactsBasePanel({ userId, onContactsChanged, onError, onSuccess }: Props) {
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [includeSources, setIncludeSources] = useState<Set<string>>(() => {
    const s = new Set(SOURCE_DEFS.map((d) => d.id))
    s.add(NULL_KEY)
    return s
  })
  const [csvOpen, setCsvOpen] = useState(false)
  const [csvBusy, setCsvBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase
      .from('leads')
      .select('id, name, phone, source, tag, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(800)

    const { data, error: e } = await q
    if (e) {
      onError(`Não foi possível carregar contatos: ${e.message}`)
      setLeads([])
      setLoading(false)
      return
    }
    setLeads((data ?? []) as LeadRow[])
    setLoading(false)
  }, [userId, onError])

  useEffect(() => {
    void load()
  }, [load])

  const allSourceKeys = useMemo(() => {
    const s = new Set(SOURCE_DEFS.map((d) => d.id))
    s.add(NULL_KEY)
    return s
  }, [])

  const isShowingAllOrigins = useMemo(
    () => includeSources.size === allSourceKeys.size,
    [includeSources, allSourceKeys],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return leads.filter((l) => {
      if (!isShowingAllOrigins) {
        const k = l.source && l.source.length > 0 ? l.source : NULL_KEY
        if (!includeSources.has(k)) return false
      }
      if (!q) return true
      const name = (l.name ?? '').toLowerCase()
      const ph = (l.phone ?? '').replace(/\D/g, '')
      return (
        name.includes(q) ||
        ph.includes(q.replace(/\D/g, '')) ||
        (l.tag ?? '').toLowerCase().includes(q)
      )
    })
  }, [leads, search, includeSources, isShowingAllOrigins])

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const u = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = u
    a.download = 'modelo-contatos-zapifica.csv'
    a.click()
    URL.revokeObjectURL(u)
  }

  const handleCsvFile: ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCsvBusy(true)
    setImportProgress(null)
    try {
      const text = await file.text()
      const { headers, rows } = parseSimpleCsv(text)
      const pCol = findPhoneColumn(headers)
      const nCol = findNameColumn(headers)
      if (!pCol) {
        onError('Não encontrei a coluna de telefone. Use a planilha modelo (nome, telefone).')
        return
      }
      const tag = importTagLabel('manual')
      const toInsert: { user_id: string; name: string; phone: string; status: string; ai_enabled: boolean; source: string; tag: string }[] = []
      for (const row of rows) {
        const nameRaw = nCol ? row[nCol] ?? '' : 'Contato'
        const name = (nameRaw || 'Contato').trim().slice(0, 200)
        const d = phoneDigitsForLead(row[pCol] ?? '')
        if (!d) continue
        toInsert.push({
          user_id: userId,
          name: name || 'Contato',
          phone: d,
          status: 'novo',
          ai_enabled: true,
          source: 'manual_csv',
          tag,
        })
      }
      if (toInsert.length === 0) {
        onError('Nenhum telefone válido no arquivo. Verifique o DDI 55 e o formato.')
        return
      }
      setImportProgress(`Importando ${toInsert.length} contatos…`)
      const ch = 150
      for (let i = 0; i < toInsert.length; i += ch) {
        const { error: insE } = await supabase
          .from('leads')
          .insert(toInsert.slice(i, i + ch))
        if (insE) {
          onError(`Erro ao salvar: ${insE.message}`)
          return
        }
      }
      onSuccess(`${toInsert.length} contato(s) importado(s) do CSV. Tag: “${tag}”.`)
      setCsvOpen(false)
      onContactsChanged()
      void load()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setCsvBusy(false)
      setImportProgress(null)
    }
  }

  const importFromGoogle = useCallback(async () => {
    setGoogleBusy(true)
    setImportProgress(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = getGoogleProviderToken(session)
      if (!token) {
        onError(
          'Token do Google indisponível. Faça login de novo (Google) e permita acesso a contatos, ou tente o fluxo OAuth com o painel de auth.',
        )
        return
      }
      setImportProgress('Buscando contatos no Google…')
      const contacts = await fetchGoogleContacts(token)
      if (contacts.length === 0) {
        onError('Nenhum contato com telefone foi retornado pela API do Google.')
        return
      }
      const tag = importTagLabel('google')
      const toInsert = contacts.map((c) => ({
        user_id: userId,
        name: c.name.slice(0, 200),
        phone: c.phone,
        status: 'novo' as const,
        ai_enabled: true,
        source: 'google_contacts' as const,
        tag,
      }))
      setImportProgress(`Salvando ${toInsert.length} contato(s)…`)
      const ch = 150
      for (let i = 0; i < toInsert.length; i += ch) {
        const { error: insE } = await supabase
          .from('leads')
          .insert(toInsert.slice(i, i + ch))
        if (insE) {
          onError(`Erro ao salvar: ${insE.message}`)
          return
        }
      }
      onSuccess(`${toInsert.length} contato(s) importado(s) do Google. Tag: “${tag}”.`)
      onContactsChanged()
      void load()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setGoogleBusy(false)
      setImportProgress(null)
    }
  }, [userId, onError, onSuccess, onContactsChanged, load])

  const startGoogleOAuth = useCallback(async () => {
    setGoogleBusy(true)
    setImportProgress(null)
    const redirect = `${window.location.origin}${window.location.pathname}${window.location.search}#contatos`
    const { data, error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirect,
        scopes:
          'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
        queryParams: { access_type: 'offline', prompt: 'consent' },
        skipBrowserRedirect: false,
      },
    })
    if (e) {
      onError(e.message)
      setGoogleBusy(false)
      return
    }
    if (data.url) {
      window.location.assign(data.url)
    }
  }, [onError])

  function toggleSource(id: string) {
    setIncludeSources((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        if (next.size <= 1) return next
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function selectAllOrigins() {
    setIncludeSources(new Set(allSourceKeys))
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200/90 bg-gradient-to-r from-zinc-50/80 to-white p-5 shadow-sm ring-1 ring-zinc-100/80 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200/80">
            <Users2 className="h-6 w-6 text-brand-600" aria-hidden />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Base de contatos</h3>
            <p className="text-sm text-zinc-600">
              Central estilo Google Contacts — unifique arquivos, Google e extrações.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCsvOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:border-amber-300 hover:bg-amber-50"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Importar arquivo (.CSV)
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const { data: { session } } = await supabase.auth.getSession()
                if (getGoogleProviderToken(session)) {
                  void importFromGoogle()
                } else {
                  void startGoogleOAuth()
                }
              })()
            }}
            disabled={googleBusy}
            className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-60"
          >
            {googleBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Importar do Google
          </button>
        </div>
      </div>

      {importProgress ? (
        <p className="text-sm font-medium text-brand-800" role="status">
          {importProgress}
        </p>
      ) : null}
      {googleBusy && !importProgress ? (
        <p className="text-xs text-zinc-500">Preparando…</p>
      ) : null}

      {csvOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-zinc-900">Importar CSV</h4>
            <p className="mt-1 text-sm text-zinc-600">
              O arquivo precisa conter as colunas <code className="text-xs">nome</code> e{' '}
              <code className="text-xs">telefone</code>.
            </p>
            <button
              type="button"
              onClick={downloadTemplate}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Baixar planilha modelo
            </button>
            <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-8 text-sm text-zinc-600 transition hover:border-brand-300 hover:bg-brand-50/30">
              {csvBusy ? (
                <Loader2 className="h-8 w-8 animate-spin text-brand-600" aria-hidden />
              ) : (
                <>
                  <span className="font-medium text-zinc-800">Arraste o CSV ou clique</span>
                  <span className="mt-1 text-xs">Telefones serão normalizados com DDI 55</span>
                </>
              )}
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={handleCsvFile}
                disabled={csvBusy}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCsvOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="relative min-w-0 max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, telefone ou tag…"
            className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-10 pr-3 text-sm shadow-inner focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Origem (múltipla)
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={selectAllOrigins}
              className="rounded-lg px-2 py-1 text-[10px] font-medium text-brand-700 hover:underline"
            >
              Selecionar todas
            </button>
            {SOURCE_DEFS.map((o) => {
              const on = includeSources.has(o.id)
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggleSource(o.id)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium ring-1 transition ${
                    on
                      ? o.className
                      : 'bg-zinc-100/90 text-zinc-400 line-through ring-zinc-200/80'
                  }`}
                >
                  {o.label}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => toggleSource(NULL_KEY)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ${
                includeSources.has(NULL_KEY)
                  ? 'bg-zinc-200 text-zinc-900 ring-zinc-300'
                  : 'bg-zinc-100/90 text-zinc-400 line-through ring-zinc-200/80'
              }`}
            >
              Sem origem
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-sm text-zinc-500">Carregando contatos…</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-sm ring-1 ring-zinc-100/80">
          <div className="max-h-[min(70vh,560px)] overflow-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-[1] border-b border-zinc-200 bg-zinc-50/95 backdrop-blur">
                <tr>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Nome</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Telefone</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Origem</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Tag</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-zinc-500">
                      Nenhum contato nesse filtro. Importe um CSV ou ajuste a busca.
                    </td>
                  </tr>
                ) : (
                  filtered.map((l) => {
                    const b = badgeForSource(l.source)
                    return (
                      <tr
                        key={l.id}
                        className="border-b border-zinc-100/90 transition hover:bg-zinc-50/80"
                      >
                        <td className="px-4 py-3 font-medium text-zinc-900">{l.name}</td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-zinc-700">
                          {l.phone ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${b.className}`}
                          >
                            {b.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-xs truncate text-zinc-600" title={l.tag ?? ''}>
                          {l.tag ?? '—'}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
            Mostrando {filtered.length} de {leads.length} contato(s) carregado(s) recentemente
          </p>
        </div>
      )}
    </div>
  )
}
