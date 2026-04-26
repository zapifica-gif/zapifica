import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Loader2, Megaphone, Search } from 'lucide-react'
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
  extracted_count: number | null
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

function canDownloadLeadsFile(r: LeadExtractionRow): boolean {
  return r.status === 'completed' && Boolean(r.result_url && r.result_url.trim())
}

function openLeadsFile(r: LeadExtractionRow) {
  if (!canDownloadLeadsFile(r) || !r.result_url) return
  window.open(r.result_url, '_blank', 'noopener,noreferrer')
}

// ---------------------------------------------------------------------------
// CSV helpers para a "Ponte Zap Voice"
// ---------------------------------------------------------------------------

/**
 * Limpa o nome de coluna lido do CSV: BOM, aspas literais, quebras, trim e
 * comparação case-insensitive (sempre use isso para chaves e buscas).
 */
function normalizeCsvHeader(raw: string): string {
  return raw.replace(/["\r\n\uFEFF]/g, '').trim().toLowerCase()
}

/** Remove aspas envolventes e lixo comum de células (nome, telefone, etc.). */
function cleanCsvCellValue(raw: string): string {
  let t = raw.replace(/["\r\n\uFEFF]/g, '').trim()
  // Aspas restantes no início/fim (ex.: export com ""campo"")
  t = t.replace(/^"+|"+$/g, '')
  return t.trim()
}

/** Parse CSV simples (RFC 4180 “bom o suficiente”) — suporta aspas e vírgulas escapadas. */
function parseSimpleCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // BOM no início do arquivo e, por segurança, no início da primeira linha
  const cleaned = text.replace(/^\uFEFF/g, '')
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    const next = cleaned[i + 1]
    if (ch === '"' && inQuotes && next === '"') {
      current += '"'
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++
      lines.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.length) lines.push(current)
  if (lines.length === 0) return { headers: [], rows: [] }

  const splitCsvLine = (line: string): string[] => {
    const out: string[] = []
    let cell = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const next = line[i + 1]
      if (ch === '"' && q && next === '"') {
        cell += '"'
        i++
        continue
      }
      if (ch === '"') {
        q = !q
        continue
      }
      if (ch === ',' && !q) {
        out.push(cell)
        cell = ''
        continue
      }
      cell += ch
    }
    out.push(cell)
    return out
  }

  const firstLine = lines[0].replace(/^\uFEFF/, '')
  const rawHeaderCells = splitCsvLine(firstLine)
  // Chaves normalizadas: comparação robusta a "telefone", \"telefone\", BOM, etc.
  const headers = rawHeaderCells.map((h) => normalizeCsvHeader(h))

  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.replace(/^\uFEFF/, '').trim()) continue
    const values = splitCsvLine(raw)
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      if (!h) return
      obj[h] = cleanCsvCellValue(values[idx] ?? '')
    })
    rows.push(obj)
  }
  return { headers, rows }
}

/** Heurística para encontrar a coluna do telefone (headers já em lowercase). */
function findPhoneColumn(headers: string[]): string | null {
  const exact = new Set([
    'telefone',
    'phone',
    'whatsapp',
    'celular',
    'mobile',
    'telefone celular',
  ])
  for (const h of headers) {
    if (h && exact.has(h)) return h
  }
  // Ordem: frases e termos mais específicos antes do genérico "phone"
  const needIncludes = [
    'telefone celular',
    'telefone',
    'whatsapp',
    'celular',
    'mobile',
    'phone',
  ]
  for (const part of needIncludes) {
    const found = headers.find((h) => h && h.includes(part))
    if (found) return found
  }
  return null
}

/** Nome: headers já normalizados (lowercase, sem aspas). */
function findNameColumn(headers: string[]): string | null {
  const order = [
    'nome_empresa',
    'nome',
    'title',
    'name',
    'titulo',
    'empresa',
    'displayname',
    'username',
  ]
  for (const c of order) {
    if (headers.includes(c)) return c
  }
  // fallback: primeira coluna não vazia
  return headers.find((h) => h && h.length > 0) ?? null
}

/** Coluna de biografia / sobre / descrição (Instagram, principalmente). */
function findBiographyColumn(headers: string[]): string | null {
  const order = ['biografia', 'biography', 'bio', 'sobre', 'description']
  for (const c of order) {
    if (headers.includes(c)) return c
  }
  return headers.find((h) => h.includes('bio') || h.includes('descri')) ?? null
}

/**
 * Regex permissiva para garimpar números de WhatsApp brasileiros dentro de
 * textos livres (a "Bio" do Instagram normalmente tem o WhatsApp solto).
 * Aceita prefixos como "Whatsapp:", "Contato:", "wa.me/", "+55", etc.
 */
const BR_PHONE_REGEX_FRONT =
  /(?:whatsapp|wa\.me|whats|contato|fone|tel|wpp|zap)?[\s:.-]*\+?5?5?\s?\(?\d{2}\)?[\s.-]?\d?[\s.-]?\d{4}[\s.-]?\d{4}/gi

/**
 * Pega o primeiro número brasileiro válido (DDI 55 + DDD + 8/9 dígitos) de
 * dentro de um texto. Retorna apenas dígitos prontos para a Evolution, ou ''.
 */
function extractFirstBrazilianPhone(text: string): string {
  if (!text) return ''
  const matches = text.match(BR_PHONE_REGEX_FRONT)
  if (!matches) return ''
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 13) continue
    if (digits.startsWith('55') && digits.length >= 12) return digits
    if (digits.length === 10 || digits.length === 11) return `55${digits}`
    if (digits.length >= 12) return digits
  }
  return ''
}

function buildExtractionTag(r: LeadExtractionRow): string {
  const data = formatDateBr(r.created_at)
  const fonte = r.source === 'instagram' ? 'Instagram' : 'Google Maps'
  return `Extração ${fonte} · ${r.search_term} · ${r.location} · ${data}`
}

type LeadExtractorPageProps = {
  onOpenZapVoice: () => void
}

export function LeadExtractorPage({ onOpenZapVoice }: LeadExtractorPageProps) {
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [balance, setBalance] = useState(0)
  const [rows, setRows] = useState<LeadExtractionRow[]>([])
  const [sendingId, setSendingId] = useState<string | null>(null)

  const [source, setSource] = useState<LeadExtractionSource>('google_maps')
  const [searchTerm, setSearchTerm] = useState('')
  const [country, setCountry] = useState('Brasil')
  const [state, setState] = useState('')
  const [city, setCity] = useState('')
  const [requestedAmount, setRequestedAmount] = useState(50)

  const userIdRef = useRef<string | null>(null)
  const isInstagram = source === 'instagram'

  const searchTermPlaceholder = useMemo(
    () =>
      isInstagram
        ? 'Ex.: petshop, restaurante, clínica'
        : 'Ex.: petshops, auto peças, clínicas',
    [isInstagram],
  )

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

    userIdRef.current = user.id

    const list = await supabase
      .from('lead_extractions')
      .select(
        'id, user_id, source, search_term, location, requested_amount, status, result_url, extracted_count, created_at',
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

  // Realtime: quando a Apify terminar e o webhook atualizar a extração no banco,
  // a tela reflete o novo status (e o saldo) sem F5 do usuário.
  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | null = null

    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user || cancelled) return

      const channel = supabase
        .channel(`lead_extractions:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'lead_extractions',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            const newRow = payload.new as LeadExtractionRow | null
            const oldRow = payload.old as { id?: string } | null

            if (payload.eventType === 'DELETE' && oldRow?.id) {
              setRows((prev) => prev.filter((r) => r.id !== oldRow.id))
              return
            }

            if (!newRow) return

            setRows((prev) => {
              const idx = prev.findIndex((r) => r.id === newRow.id)
              if (idx === -1) {
                return [newRow, ...prev]
              }
              const next = prev.slice()
              next[idx] = { ...prev[idx], ...newRow }
              return next
            })

            // Quando o backend reembolsa créditos parciais, a profile muda.
            // Recarregamos somente o saldo (consulta leve) para refletir.
            if (
              payload.eventType === 'UPDATE' &&
              (newRow.status === 'completed' || newRow.status === 'failed')
            ) {
              void supabase
                .from('profiles')
                .select('extraction_credits')
                .eq('id', user.id)
                .maybeSingle()
                .then(({ data }) => {
                  if (data && typeof data.extraction_credits === 'number') {
                    setBalance(data.extraction_credits)
                  }
                })
            }
          },
        )
        .subscribe()

      cleanup = () => {
        void supabase.removeChannel(channel)
      }
    })()

    return () => {
      cancelled = true
      if (cleanup) cleanup()
    }
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (requestedAmount < 1 || requestedAmount > 200) {
      setError('A quantidade deve ser entre 1 e 200 leads.')
      return
    }
    if (!searchTerm.trim()) {
      setError(
        isInstagram
          ? 'Informe um nicho ou palavra-chave (ex.: petshop).'
          : 'Informe o termo de busca.',
      )
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
            apifyError?: string
            balance?: number
            newBalance?: number
            refunded?: boolean
          })
        : {}

    if (fnError) {
      if (typeof d.balance === 'number') setBalance(d.balance)
      const apifyDetail = typeof d.apifyError === 'string' && d.apifyError.trim() ? d.apifyError.trim() : ''
      const main =
        d.error && typeof d.error === 'string'
          ? d.error
          : `Não foi possível iniciar a extração: ${fnError.message}`
      setError(apifyDetail ? `${main}\n\nDetalhe (Apify): ${apifyDetail}` : main)
      void load()
      return
    }

    if (d.ok === false) {
      if (typeof d.balance === 'number') setBalance(d.balance)
      const apifyDetail = typeof d.apifyError === 'string' && d.apifyError.trim() ? d.apifyError.trim() : ''
      const main =
        d.error ??
        (d.refunded
          ? 'A requisição à Apify falhou; o saldo foi reposto. Tente de novo em instantes.'
          : 'Falha na extração.')
      setError(apifyDetail ? `${main}\n\nDetalhe (Apify): ${apifyDetail}` : main)
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

  /**
   * Ponte Zap Voice: baixa o CSV gerado pelo webhook, fica só com as linhas
   * que têm telefone, e insere os contatos na tabela `leads` (CRM/Zap Voice)
   * usando o `tag` para agrupar por extração.
   */
  const sendToZapVoice = useCallback(
    async (r: LeadExtractionRow) => {
      if (!canDownloadLeadsFile(r) || !r.result_url) return
      const userId = userIdRef.current
      if (!userId) {
        setError('Sessão inválida. Entre novamente.')
        return
      }

      setError(null)
      setMessage(null)
      setSendingId(r.id)

      try {
        const res = await fetch(r.result_url, { cache: 'no-store' })
        if (!res.ok) {
          throw new Error(`Não consegui baixar o CSV (HTTP ${res.status}).`)
        }
        const csvText = await res.text()
        const { headers, rows: csvRows } = parseSimpleCsv(csvText)
        if (csvRows.length === 0) {
          throw new Error('O arquivo de leads está vazio.')
        }

        const phoneCol = findPhoneColumn(headers)
        const bioCol = findBiographyColumn(headers)
        if (!phoneCol && !bioCol) {
          throw new Error(
            'Não encontrei nem coluna de telefone nem de biografia no CSV. ' +
              'Esperado: telefone/phone/whatsapp ou biografia/biography.',
          )
        }
        const nameCol = findNameColumn(headers)

        const tag = buildExtractionTag(r)

        const leadsPayload = csvRows
          .map((row) => {
            // 1) tenta a coluna direta de telefone
            let phoneDigits = ''
            if (phoneCol) {
              const phoneRaw = cleanCsvCellValue(row[phoneCol] ?? '')
              phoneDigits = phoneRaw.replace(/\D/g, '')
            }
            // 2) fallback: garimpa o WhatsApp dentro da biografia (Instagram)
            if (!phoneDigits && bioCol) {
              const bio = cleanCsvCellValue(row[bioCol] ?? '')
              phoneDigits = extractFirstBrazilianPhone(bio)
            }
            if (!phoneDigits) return null
            const nameFromCsv = nameCol ? cleanCsvCellValue(row[nameCol] ?? '') : ''
            const rawName = nameFromCsv || `Lead ${phoneDigits.slice(-4)}`
            return {
              user_id: userId,
              name: rawName.slice(0, 200),
              phone: phoneDigits,
              status: 'novo',
              ai_enabled: true,
              source: r.source === 'instagram' ? 'instagram' : 'google_maps',
              tag,
              extraction_id: r.id,
            }
          })
          .filter(
            (l): l is {
              user_id: string
              name: string
              phone: string
              status: string
              ai_enabled: boolean
              source: string
              tag: string
              extraction_id: string
            } => l !== null,
          )

        if (leadsPayload.length === 0) {
          throw new Error('Nenhum lead com telefone válido para enviar.')
        }

        // Lotes de 200 para não estourar payload do PostgREST.
        let inserted = 0
        for (let i = 0; i < leadsPayload.length; i += 200) {
          const batch = leadsPayload.slice(i, i + 200)
          const { error: insErr, count } = await supabase
            .from('leads')
            .insert(batch, { count: 'exact' })
          if (insErr) {
            throw new Error(`Falha ao inserir leads no CRM: ${insErr.message}`)
          }
          inserted += count ?? batch.length
        }

        setMessage(
          `Enviei ${inserted} contato${inserted === 1 ? '' : 's'} para o Zap Voice (tag: "${tag}").`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Falha ao enviar para o Zap Voice.'
        setError(msg)
      } finally {
        setSendingId(null)
      }
    },
    [],
  )

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
                {isInstagram ? 'Nicho / palavra-chave' : 'Termo de busca'}
              </label>
              <input
                id="le-term"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={searchTermPlaceholder}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-brand-200 focus:bg-white focus:ring-4 focus:ring-brand-600/15"
              />
              {isInstagram ? (
                <p className="mt-1.5 text-xs text-zinc-500">
                  Buscamos perfis do Instagram que combinem com o nicho dentro da
                  região informada (ex.: "petshop" em Florianópolis, SC).
                </p>
              ) : null}
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
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
              <span>{message}</span>
              <button
                type="button"
                onClick={() => onOpenZapVoice()}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 transition hover:bg-emerald-50"
              >
                <Megaphone className="h-3.5 w-3.5" aria-hidden />
                Abrir Zap Voice
              </button>
            </div>
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
                        onClick={() => openLeadsFile(r)}
                        disabled={!canDownloadLeadsFile(r)}
                        title={
                          canDownloadLeadsFile(r)
                            ? 'Abre o CSV de leads no Storage'
                            : 'Disponível quando o status for Concluída e o arquivo estiver pronto'
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        Baixar Leads
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendToZapVoice(r)}
                        disabled={!canDownloadLeadsFile(r) || sendingId === r.id}
                        title={
                          canDownloadLeadsFile(r)
                            ? 'Importa os contatos com telefone para a base do Zap Voice'
                            : 'Disponível quando a extração estiver concluída'
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50/80 px-2.5 py-1.5 text-xs font-medium text-brand-900 transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {sendingId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Megaphone className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Enviar para Zap Voice
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
