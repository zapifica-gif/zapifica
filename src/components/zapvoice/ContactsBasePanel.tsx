import { useCallback, useEffect, useMemo, useState, type ChangeEventHandler } from 'react'
import {
  Copy,
  Download,
  Loader2,
  Pencil,
  Search,
  Settings2,
  Tag,
  Trash2,
  UserPlus,
  Users2,
} from 'lucide-react'
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

const NULL_KEY = 'null'

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

type AudienceRow = {
  id: string
  name: string
  lead_ids: string[]
  created_at: string
}

type TagPresetRow = {
  id: string
  name: string
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
  const [presets, setPresets] = useState<TagPresetRow[]>([])
  const [audiences, setAudiences] = useState<AudienceRow[]>([])
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

  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [renameMassFrom, setRenameMassFrom] = useState('')
  const [renameMassTo, setRenameMassTo] = useState('')
  const [presetBusyId, setPresetBusyId] = useState<string | null>(null)
  const [massBusy, setMassBusy] = useState(false)
  const [syncPresetsBusy, setSyncPresetsBusy] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editingLead, setEditingLead] = useState<LeadRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editTag, setEditTag] = useState('')
  const [saveContactBusy, setSaveContactBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<LeadRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // seleção para criar público
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set())
  const [audienceOpen, setAudienceOpen] = useState(false)
  const [audienceName, setAudienceName] = useState('')
  const [audienceBusy, setAudienceBusy] = useState(false)

  // adicionar contato manualmente
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addPhone, setAddPhone] = useState('')
  const [addTag, setAddTag] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const loadPresets = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('zv_contact_tag_presets')
      .select('id, name, created_at')
      .eq('user_id', userId)
      .order('name', { ascending: true })
    if (e) {
      console.warn('[ContactsBasePanel] etiquetas biblioteca:', e.message)
      setPresets([])
      return
    }
    setPresets((data ?? []) as TagPresetRow[])
  }, [userId])

  const loadAudiences = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('zv_audiences')
      .select('id, name, lead_ids, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (e) {
      console.warn('[ContactsBasePanel] públicos:', e.message)
      setAudiences([])
      return
    }
    setAudiences((data ?? []) as AudienceRow[])
  }, [userId])

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
    await loadPresets()
    await loadAudiences()
    setLoading(false)
  }, [userId, onError, loadPresets, loadAudiences])

  useEffect(() => {
    void load()
  }, [load])

  function toggleLeadSelected(id: string) {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function createAudienceFromSelection() {
    const name = audienceName.trim().slice(0, 120)
    if (!name) {
      onError('Dê um nome para o público.')
      return
    }
    const ids = Array.from(selectedLeadIds)
    if (ids.length === 0) {
      onError('Selecione ao menos 1 contato para criar o público.')
      return
    }
    setAudienceBusy(true)
    try {
      const { error } = await supabase.from('zv_audiences').insert({
        user_id: userId,
        name,
        lead_ids: ids,
      })
      if (error) {
        onError(`Público: ${error.message}`)
        return
      }
      onSuccess(`Público criado: “${name}” (${ids.length} contato(s)).`)
      setAudienceOpen(false)
      setAudienceName('')
      setSelectedLeadIds(new Set())
      onContactsChanged()
      await loadAudiences()
    } finally {
      setAudienceBusy(false)
    }
  }

  async function addManualContact() {
    const name = addName.trim().slice(0, 200)
    if (!name) {
      onError('O nome é obrigatório.')
      return
    }
    const phoneDigits = phoneDigitsForLead(addPhone)
    if (!phoneDigits) {
      onError('Informe um telefone válido com DDI (ex.: 5511999990000).')
      return
    }
    const tag = addTag.trim() || null
    setAddBusy(true)
    try {
      const { error } = await supabase.from('leads').insert({
        user_id: userId,
        name,
        phone: phoneDigits,
        status: 'novo',
        ai_enabled: true,
        source: 'manual_csv',
        tag,
      })
      if (error) {
        onError(`Contato: ${error.message}`)
        return
      }
      onSuccess('Contato criado.')
      setAddOpen(false)
      setAddName('')
      setAddPhone('')
      setAddTag('')
      onContactsChanged()
      void load()
    } finally {
      setAddBusy(false)
    }
  }

  const tagAutocompleteList = useMemo(() => {
    const fromLeads = new Set<string>()
    for (const l of leads) {
      const t = (l.tag ?? '').trim()
      if (t) fromLeads.add(t)
    }
    const fromPresets = new Set<string>()
    for (const p of presets) {
      const t = p.name.trim()
      if (t) fromPresets.add(t)
    }
    return [...new Set([...fromLeads, ...fromPresets])].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [leads, presets])

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

  function openEdit(l: LeadRow) {
    setEditingLead(l)
    setEditName(l.name ?? '')
    setEditPhone(l.phone ?? '')
    setEditTag(l.tag ?? '')
    setEditOpen(true)
  }

  async function saveEdit() {
    if (!editingLead) return
    const name = editName.trim().slice(0, 200)
    if (!name) {
      onError('O nome é obrigatório.')
      return
    }
    const phoneDigits = phoneDigitsForLead(editPhone)
    if (!phoneDigits) {
      onError('Informe um telefone válido com DDI (ex.: 5511999990000).')
      return
    }
    const tag = editTag.trim() || null
    setSaveContactBusy(true)
    try {
      const { error: e } = await supabase
        .from('leads')
        .update({
          name,
          phone: phoneDigits,
          tag,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingLead.id)
        .eq('user_id', userId)
      if (e) {
        onError(`Não foi possível salvar: ${e.message}`)
        return
      }
      onSuccess('Contato atualizado.')
      setEditOpen(false)
      setEditingLead(null)
      onContactsChanged()
      void load()
    } finally {
      setSaveContactBusy(false)
    }
  }

  async function duplicateLead(l: LeadRow) {
    const nm = `${l.name.trim()} (cópia)`.slice(0, 200)
    const digits = phoneDigitsForLead(l.phone)
    if (!digits) {
      onError(
        'Este contato precisa de um telefone válido (DDI 55) para duplicar. Clique em editar e ajuste o número.',
      )
      return
    }
    try {
      const { error: insE } = await supabase.from('leads').insert({
        user_id: userId,
        name: nm,
        phone: digits,
        status: 'novo',
        ai_enabled: true,
        source: l.source ?? 'manual_csv',
        tag: l.tag?.trim() || null,
      })
      if (insE) {
        onError(`Não foi possível duplicar: ${insE.message}`)
        return
      }
      onSuccess(`Contato duplicado: “${nm}”.`)
      onContactsChanged()
      void load()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      const { error: e } = await supabase
        .from('leads')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('user_id', userId)
      if (e) {
        onError(`Exclusão: ${e.message}`)
        return
      }
      onSuccess('Contato excluído.')
      setDeleteTarget(null)
      onContactsChanged()
      void load()
    } finally {
      setDeleteBusy(false)
    }
  }

  async function addPreset() {
    const n = newPresetName.trim()
    if (!n) return
    setPresetBusyId('new')
    try {
      const { error } = await supabase.from('zv_contact_tag_presets').insert({
        user_id: userId,
        name: n.slice(0, 240),
      })
      if (error?.code === '23505') {
        onError('Já existe uma etiqueta igual na biblioteca.')
        return
      }
      if (error) {
        onError(`Etiqueta: ${error.message}`)
        return
      }
      setNewPresetName('')
      onSuccess('Etiqueta criada.')
      await loadPresets()
    } finally {
      setPresetBusyId(null)
    }
  }

  async function deletePreset(id: string) {
    setPresetBusyId(id)
    try {
      const { error } = await supabase.from('zv_contact_tag_presets').delete().eq('id', id).eq('user_id', userId)
      if (error) {
        onError(error.message)
        return
      }
      onSuccess('Etiqueta removida da biblioteca (contatos continuam com a mesma marcação).')
      await loadPresets()
    } finally {
      setPresetBusyId(null)
    }
  }

  async function renameTagEverywhere() {
    const from = renameMassFrom.trim()
    const to = renameMassTo.trim()
    if (!from || !to) {
      onError('Preencha a etiqueta antiga e a nova.')
      return
    }
    setMassBusy(true)
    try {
      const { data: rows, error: qe } = await supabase
        .from('leads')
        .select('id')
        .eq('user_id', userId)
        .eq('tag', from)
      if (qe) {
        onError(qe.message)
        return
      }
      const n = rows?.length ?? 0
      if (n === 0) {
        onError('Nenhum contato usa exatamente essa etiqueta (texto idêntico).')
        return
      }
      const { error: ue } = await supabase
        .from('leads')
        .update({ tag: to.slice(0, 480), updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('tag', from)
      if (ue) {
        onError(ue.message)
        return
      }

      await supabase
        .from('zv_contact_tag_presets')
        .update({ name: to.slice(0, 240) })
        .eq('user_id', userId)
        .eq('name', from)

      onSuccess(`${n} contato(s) atualizados e biblioteca sincronizada.`)
      setRenameMassFrom('')
      setRenameMassTo('')
      void load()
    } finally {
      setMassBusy(false)
    }
  }

  async function syncDistinctTagsIntoPresets() {
    setSyncPresetsBusy(true)
    try {
      const distinct = [...new Set(leads.map((l) => (l.tag ?? '').trim()).filter(Boolean))]
      let added = 0
      for (const name of distinct) {
        const { error } = await supabase.from('zv_contact_tag_presets').insert({
          user_id: userId,
          name: name.slice(0, 240),
        })
        if (!error || error.code === '23505') {
          if (!error) added += 1
        }
      }
      onSuccess(
        added > 0
          ? `${added} etiqueta(s) nova(s) na biblioteca a partir dos contatos.`
          : 'Nada novo para importar ou já existia.',
      )
      await loadPresets()
    } finally {
      setSyncPresetsBusy(false)
    }
  }

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
      const toInsert: {
        user_id: string
        name: string
        phone: string
        status: string
        ai_enabled: boolean
        source: string
        tag: string
      }[] = []
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
      const {
        data: { session },
      } = await supabase.auth.getSession()
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
        const { error: insE } = await supabase.from('leads').insert(toInsert.slice(i, i + ch))
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
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:border-brand-300 hover:bg-brand-50/50"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Adicionar contato
          </button>
          <button
            type="button"
            disabled={selectedLeadIds.size === 0}
            onClick={() => setAudienceOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
            title="Crie um público com os contatos selecionados"
          >
            <Users2 className="h-4 w-4" aria-hidden />
            Criar público ({selectedLeadIds.size})
          </button>
          <button
            type="button"
            onClick={() => setTagManagerOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50/80 px-4 py-2.5 text-sm font-semibold text-brand-900 shadow-sm transition hover:bg-brand-100/90"
          >
            <Settings2 className="h-4 w-4" aria-hidden />
            Etiquetas
          </button>
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
                const {
                  data: { session },
                } = await supabase.auth.getSession()
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

      {addOpen ? (
        <div
          className="fixed inset-0 z-[86] flex items-center justify-center bg-zinc-950/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-zinc-900">Adicionar contato</h4>
            <div className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-zinc-600">
                Nome
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs font-medium text-zinc-600">
                Telefone (com DDI 55)
                <input
                  value={addPhone}
                  onChange={(e) => setAddPhone(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 font-mono text-sm tabular-nums"
                  placeholder="5511999990000"
                />
              </label>
              <label className="block text-xs font-medium text-zinc-600">
                Etiqueta (tag) (opcional)
                <input
                  value={addTag}
                  onChange={(e) => setAddTag(e.target.value)}
                  list="tag-ac-list"
                  placeholder="Ex.: Cliente VIP"
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-xl px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={addBusy}
                onClick={() => void addManualContact()}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {addBusy ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {audienceOpen ? (
        <div
          className="fixed inset-0 z-[86] flex items-center justify-center bg-zinc-950/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-zinc-900">Criar público</h4>
            <p className="mt-1 text-sm text-zinc-600">
              Você selecionou <strong>{selectedLeadIds.size}</strong> contato(s).
            </p>
            <label className="mt-4 block text-xs font-medium text-zinc-600">
              Nome do público
              <input
                value={audienceName}
                onChange={(e) => setAudienceName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                placeholder="Ex.: VIP Curitiba"
              />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={audienceBusy}
                onClick={() => setAudienceOpen(false)}
                className="rounded-xl px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={audienceBusy}
                onClick={() => void createAudienceFromSelection()}
                className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
              >
                {audienceBusy ? 'Criando…' : 'Criar público'}
              </button>
            </div>
          </div>
        </div>
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

      {editOpen && editingLead ? (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-zinc-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-contact-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h4 id="edit-contact-title" className="text-base font-semibold text-zinc-900">
              Editar contato
            </h4>
            <div className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-zinc-600">
                Nome
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs font-medium text-zinc-600">
                Telefone (com DDI 55)
                <input
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 font-mono text-sm tabular-nums"
                />
              </label>
              <label className="block text-xs font-medium text-zinc-600">
                Etiqueta (tag)
                <input
                  value={editTag}
                  onChange={(e) => setEditTag(e.target.value)}
                  list="tag-ac-list"
                  placeholder="Ex.: Cliente VIP"
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
                <datalist id="tag-ac-list">
                  {tagAutocompleteList.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditOpen(false)
                  setEditingLead(null)
                }}
                className="rounded-xl px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saveContactBusy}
                onClick={() => void saveEdit()}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {saveContactBusy ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-zinc-950/60 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <p className="text-sm font-semibold text-zinc-900">Excluir contato?</p>
            <p className="mt-2 text-sm text-zinc-600">
              Remove <strong>{deleteTarget.name}</strong> da base e o histórico de mensagens ligado a
              ele. Esta ação não dá para desfazer.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => setDeleteTarget(null)}
                className="rounded-xl px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleteBusy ? 'Excluindo…' : 'Excluir'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tagManagerOpen ? (
        <div
          className="fixed inset-0 z-[82] flex items-center justify-center overflow-y-auto bg-zinc-950/50 p-4 py-12"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-base font-semibold text-zinc-900">Gestão de etiquetas</h4>
                <p className="mt-1 text-sm text-zinc-600">
                  Crie sugestões de etiqueta para usar nos contatos. Renomeie em todos os leads de uma
                  vez quando precisar padronizar.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTagManagerOpen(false)}
                className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"
                aria-label="Fechar"
              >
                <span className="sr-only">Fechar</span>✕
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Nova etiqueta na biblioteca
              </p>
              <div className="flex gap-2">
                <input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Nome da etiqueta"
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addPreset()
                  }}
                />
                <button
                  type="button"
                  disabled={presetBusyId === 'new' || !newPresetName.trim()}
                  onClick={() => void addPreset()}
                  className="shrink-0 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {presetBusyId === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Adicionar'}
                </button>
              </div>
            </div>

            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Biblioteca ({presets.length})
              </p>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-zinc-100 bg-zinc-50/50 p-2">
                {presets.length === 0 ? (
                  <li className="px-2 py-2 text-xs text-zinc-500">
                    Nenhuma etiqueta salva — adicione acima ou importe das tags dos contatos.
                  </li>
                ) : (
                  presets.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-sm text-zinc-800 ring-1 ring-zinc-100"
                    >
                      <span className="flex items-center gap-2 truncate font-medium">
                        <Tag className="h-3.5 w-3.5 shrink-0 text-brand-600" aria-hidden />
                        <span className="truncate">{p.name}</span>
                      </span>
                      <button
                        type="button"
                        disabled={presetBusyId === p.id}
                        onClick={() => void deletePreset(p.id)}
                        className="shrink-0 rounded p-1 text-red-600 hover:bg-red-50"
                        title="Remover da biblioteca"
                      >
                        {presetBusyId === p.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <button
                type="button"
                disabled={syncPresetsBusy}
                onClick={() => void syncDistinctTagsIntoPresets()}
                className="mt-2 text-xs font-medium text-brand-700 hover:underline disabled:opacity-50"
              >
                {syncPresetsBusy ? 'Importando…' : '+ Importar etiquetas usadas nos contatos para a biblioteca'}
              </button>
            </div>

            <div className="mt-8 border-t border-zinc-100 pt-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Renomear em todos os contatos
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                O texto antigo deve ser <strong>idêntico</strong> à etiqueta atual (maiúsculas e minúsculas
                contam).
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input
                  value={renameMassFrom}
                  onChange={(e) => setRenameMassFrom(e.target.value)}
                  placeholder="Etiqueta antiga"
                  className="rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
                <input
                  value={renameMassTo}
                  onChange={(e) => setRenameMassTo(e.target.value)}
                  placeholder="Etiqueta nova"
                  className="rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="button"
                disabled={massBusy || !renameMassFrom.trim() || !renameMassTo.trim()}
                onClick={() => void renameTagEverywhere()}
                className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-900 hover:bg-brand-100 disabled:opacity-50"
              >
                {massBusy ? 'Aplicando…' : 'Aplicar rename em todos'}
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
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-[1] border-b border-zinc-200 bg-zinc-50/95 backdrop-blur">
                <tr>
                  <th className="w-[44px] px-4 py-3 font-semibold text-zinc-700">
                    <span className="sr-only">Selecionar</span>
                  </th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Nome</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Telefone</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Origem</th>
                  <th className="px-4 py-3 font-semibold text-zinc-700">Tag</th>
                  <th className="w-[140px] px-4 py-3 text-right font-semibold text-zinc-700">
                    Ações
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                      Nenhum contato nesse filtro. Importe um CSV ou ajuste a busca.
                    </td>
                  </tr>
                ) : (
                  filtered.map((l) => {
                    const b = badgeForSource(l.source)
                    const checked = selectedLeadIds.has(l.id)
                    return (
                      <tr
                        key={l.id}
                        className="border-b border-zinc-100/90 transition hover:bg-zinc-50/80"
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            className="rounded border-zinc-300"
                            checked={checked}
                            onChange={() => toggleLeadSelected(l.id)}
                            aria-label={`Selecionar ${l.name}`}
                          />
                        </td>
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
                        <td className="max-w-[200px] px-4 py-3 truncate text-zinc-600" title={l.tag ?? ''}>
                          {l.tag ?? '—'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openEdit(l)}
                              title="Editar"
                              className="inline-flex rounded-lg p-2 text-zinc-600 hover:bg-brand-50 hover:text-brand-800"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void duplicateLead(l)}
                              title="Duplicar"
                              className="inline-flex rounded-lg p-2 text-zinc-600 hover:bg-zinc-100"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(l)}
                              title="Excluir"
                              className="inline-flex rounded-lg p-2 text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
            Mostrando {filtered.length} de {leads.length} contato(s). Use &quot;Etiquetas&quot; para
            gerenciar o catálogo.
          </p>
        </div>
      )}
    </div>
  )
}
