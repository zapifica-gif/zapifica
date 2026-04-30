import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEventHandler } from 'react'
import {
  Copy,
  Download,
  GripVertical,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Settings2,
  Star,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users2,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  CSV_TEMPLATE,
  buildPhoneToLeadIdMap,
  findCargoColumn,
  findCidadeColumn,
  findEmailColumn,
  findEmpresaColumn,
  findEnderecoColumn,
  findLeadIdForNormalizedPhone,
  findNameColumn,
  findPhoneColumn,
  findTagColumn,
  parseSimpleCsv,
  phoneDigitsForLead,
  allCanonicalPhoneKeys,
} from '../../lib/csvImport'

const SOURCE_DEFS: { id: string; label: string; className: string }[] = [
  { id: 'google_maps', label: 'Google Maps', className: 'bg-sky-50 text-sky-900 ring-sky-200' },
  { id: 'instagram', label: 'Instagram', className: 'bg-fuchsia-50 text-fuchsia-900 ring-fuchsia-200' },
  { id: 'manual_csv', label: 'Arquivo', className: 'bg-amber-50 text-amber-900 ring-amber-200' },
  { id: 'google_contacts', label: 'Google Contacts', className: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
  {
    id: 'inbound_whatsapp',
    label: 'WhatsApp',
    className: 'bg-green-50 text-green-900 ring-green-200',
  },
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

function importTagLabelCsvDefault(): string {
  const d = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  return `Importação Manual - ${d}`
}

type LeadRow = {
  id: string
  name: string
  phone: string | null
  source: string | null
  tag: string | null
  created_at: string
  email: string | null
  job_title: string | null
  company_name: string | null
  city: string | null
  address_line: string | null
  contact_starred: boolean
}

type SidebarNav = 'all' | 'starred' | 'other'

function avatarHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h)
  return Math.abs(h) % 360
}

function jobCompanyLine(job: string | null, company: string | null): string {
  const j = (job ?? '').trim()
  const c = (company ?? '').trim()
  if (j && c) return `${j} · ${c}`
  return j || c || '—'
}

function exportContactJson(l: LeadRow): string {
  return JSON.stringify(
    {
      name: l.name,
      phone: l.phone,
      email: l.email,
      tag: l.tag,
      job_title: l.job_title,
      company_name: l.company_name,
      city: l.city,
      address_line: l.address_line,
      source: l.source,
    },
    null,
    2,
  )
}

function isOtherContactRow(l: LeadRow): boolean {
  const src = (l.source ?? '').trim()
  const nm = (l.name ?? '').trim()
  return src === 'inbound_whatsapp' || /^novo\s+lead/i.test(nm)
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
  const [importProgress, setImportProgress] = useState<string | null>(null)

  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [renameMassFrom, setRenameMassFrom] = useState('')
  const [renameMassTo, setRenameMassTo] = useState('')
  const [presetBusyId, setPresetBusyId] = useState<string | null>(null)
  const [massBusy, setMassBusy] = useState(false)
  const [syncPresetsBusy, setSyncPresetsBusy] = useState(false)

  const [sidebarNav, setSidebarNav] = useState<SidebarNav>('all')
  const [sidebarTagFilter, setSidebarTagFilter] = useState<string | null>(null)
  const [rowMenuLeadId, setRowMenuLeadId] = useState<string | null>(null)
  const rowMenuRef = useRef<HTMLDivElement | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editingLead, setEditingLead] = useState<LeadRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editTag, setEditTag] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editJobTitle, setEditJobTitle] = useState('')
  const [editCompany, setEditCompany] = useState('')
  const [editCity, setEditCity] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [saveContactBusy, setSaveContactBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<LeadRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [bulkDeleteTagPick, setBulkDeleteTagPick] = useState('')
  const [bulkDeletePreview, setBulkDeletePreview] = useState<number | null>(null)
  const [bulkDeleteConfirmTag, setBulkDeleteConfirmTag] = useState<string | null>(null)
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false)
  const [bulkDeletePreviewBusy, setBulkDeletePreviewBusy] = useState(false)

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
  const [addEmail, setAddEmail] = useState('')
  const [addJobTitle, setAddJobTitle] = useState('')
  const [addCompany, setAddCompany] = useState('')
  const [addCity, setAddCity] = useState('')
  const [addAddress, setAddAddress] = useState('')
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
      .select(
        'id, name, phone, source, tag, created_at, email, job_title, company_name, city, address_line, contact_starred',
      )
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
    setLeads(
      (data ?? []).map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: String(r.id),
          name: String(r.name ?? ''),
          phone: (r.phone as string | null) ?? null,
          source: (r.source as string | null) ?? null,
          tag: (r.tag as string | null) ?? null,
          created_at: String(r.created_at ?? ''),
          email: (r.email as string | null) ?? null,
          job_title: (r.job_title as string | null) ?? null,
          company_name: (r.company_name as string | null) ?? null,
          city: (r.city as string | null) ?? null,
          address_line: (r.address_line as string | null) ?? null,
          contact_starred: Boolean(r.contact_starred),
        }
      }),
    )
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
      const email = addEmail.trim().slice(0, 320) || null
      const job_title = addJobTitle.trim().slice(0, 240) || null
      const company_name = addCompany.trim().slice(0, 240) || null
      const city = addCity.trim().slice(0, 160) || null
      const address_line = addAddress.trim().slice(0, 500) || null
      const { error } = await supabase.from('leads').insert({
        user_id: userId,
        name,
        phone: phoneDigits,
        status: 'novo',
        ai_enabled: true,
        source: null,
        tag,
        email,
        job_title,
        company_name,
        city,
        address_line,
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
      setAddEmail('')
      setAddJobTitle('')
      setAddCompany('')
      setAddCity('')
      setAddAddress('')
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

  const marcadoresSidebar = useMemo(() => {
    const counts = new Map<string, number>()
    for (const l of leads) {
      const t = (l.tag ?? '').trim()
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const fromPresets = presets.map((p) => ({
      label: p.name.trim(),
      count: counts.get(p.name.trim()) ?? 0,
      key: `p-${p.id}`,
    }))
    const presetNames = new Set(presets.map((p) => p.name.trim()))
    const extras = [...counts.keys()]
      .filter((t) => !presetNames.has(t))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((t) => ({ label: t, count: counts.get(t)!, key: `t-${t}` }))
    const merged = [...fromPresets, ...extras].sort((a, b) =>
      a.label.localeCompare(b.label, 'pt-BR'),
    )
    return merged
  }, [leads, presets])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const qdigits = q.replace(/\D/g, '')
    return leads.filter((l) => {
      if (sidebarTagFilter !== null && (l.tag ?? '').trim() !== sidebarTagFilter) {
        return false
      }
      if (sidebarNav === 'starred' && !l.contact_starred) return false
      if (sidebarNav === 'other' && !isOtherContactRow(l)) return false
      if (!isShowingAllOrigins) {
        const k = l.source && l.source.length > 0 ? l.source : NULL_KEY
        if (!includeSources.has(k)) return false
      }
      if (!q) return true
      const hay = [
        l.name,
        l.phone,
        l.tag,
        l.email,
        l.job_title,
        l.company_name,
        l.city,
        l.address_line,
      ]
        .map((x) => (x ?? '').toLowerCase())
        .join(' ')
      const ph = (l.phone ?? '').replace(/\D/g, '')
      return hay.includes(q) || (qdigits.length >= 3 && ph.includes(qdigits))
    })
  }, [
    leads,
    search,
    includeSources,
    isShowingAllOrigins,
    sidebarNav,
    sidebarTagFilter,
  ])

  useEffect(() => {
    if (!rowMenuLeadId) return
    function onDoc(e: MouseEvent) {
      const el = rowMenuRef.current
      if (el && !el.contains(e.target as Node)) setRowMenuLeadId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [rowMenuLeadId])

  function openEdit(l: LeadRow) {
    setEditingLead(l)
    setEditName(l.name ?? '')
    setEditPhone(l.phone ?? '')
    setEditTag(l.tag ?? '')
    setEditEmail((l.email ?? '').trim())
    setEditJobTitle((l.job_title ?? '').trim())
    setEditCompany((l.company_name ?? '').trim())
    setEditCity((l.city ?? '').trim())
    setEditAddress((l.address_line ?? '').trim())
    setEditOpen(true)
  }

  async function toggleStarLead(l: LeadRow) {
    const next = !l.contact_starred
    try {
      const { error: e } = await supabase
        .from('leads')
        .update({ contact_starred: next })
        .eq('id', l.id)
        .eq('user_id', userId)
      if (e) {
        onError(e.message)
        return
      }
      void load()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  async function setLeadTagQuick(leadId: string, tag: string) {
    const t = tag.trim().slice(0, 480) || null
    try {
      const { error: e } = await supabase
        .from('leads')
        .update({ tag: t, updated_at: new Date().toISOString() })
        .eq('id', leadId)
        .eq('user_id', userId)
      if (e) {
        onError(e.message)
        return
      }
      setRowMenuLeadId(null)
      onSuccess('Marcador atualizado.')
      void load()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
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
    const email = editEmail.trim().slice(0, 320) || null
    const job_title = editJobTitle.trim().slice(0, 240) || null
    const company_name = editCompany.trim().slice(0, 240) || null
    const city = editCity.trim().slice(0, 160) || null
    const address_line = editAddress.trim().slice(0, 500) || null
    setSaveContactBusy(true)
    try {
      const { error: e } = await supabase
        .from('leads')
        .update({
          name,
          phone: phoneDigits,
          tag,
          email,
          job_title,
          company_name,
          city,
          address_line,
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
        source: l.source ?? null,
        tag: l.tag?.trim() || null,
        email: l.email?.trim() || null,
        job_title: l.job_title?.trim() || null,
        company_name: l.company_name?.trim() || null,
        city: l.city?.trim() || null,
        address_line: l.address_line?.trim() || null,
        contact_starred: false,
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

  async function loadBulkDeleteCount() {
    const tag = bulkDeleteTagPick.trim()
    if (!tag) {
      onError('Escolha ou digite uma etiqueta (texto idêntico aos contatos).')
      setBulkDeletePreview(null)
      return
    }
    setBulkDeletePreviewBusy(true)
    try {
      const { count, error } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tag', tag)
      if (error) {
        onError(error.message)
        setBulkDeletePreview(null)
        return
      }
      setBulkDeletePreview(count ?? 0)
      if ((count ?? 0) === 0) {
        onError('Nenhum contato com essa etiqueta exata.')
      }
    } finally {
      setBulkDeletePreviewBusy(false)
    }
  }

  function openBulkDeleteConfirm() {
    const tag = bulkDeleteTagPick.trim()
    if (!tag) {
      onError('Escolha ou digite a etiqueta da lista que deseja apagar.')
      return
    }
    if ((bulkDeletePreview ?? 0) < 1) {
      onError('Clique em «Contar contatos» e confira o número antes de excluir.')
      return
    }
    setBulkDeleteConfirmTag(tag)
  }

  async function executeBulkDeleteByTag() {
    if (!bulkDeleteConfirmTag) return
    setBulkDeleteBusy(true)
    try {
      const { error } = await supabase
        .from('leads')
        .delete()
        .eq('user_id', userId)
        .eq('tag', bulkDeleteConfirmTag)
      if (error) {
        onError(`Exclusão em massa: ${error.message}`)
        return
      }
      onSuccess(
        `Todos os contatos com a etiqueta «${bulkDeleteConfirmTag}» foram excluídos.`,
      )
      setBulkDeleteConfirmTag(null)
      setBulkDeleteTagPick('')
      setBulkDeletePreview(null)
      setSelectedLeadIds(new Set())
      onContactsChanged()
      void load()
    } finally {
      setBulkDeleteBusy(false)
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
      const eCol = findEmailColumn(headers)
      const cargoCol = findCargoColumn(headers)
      const empCol = findEmpresaColumn(headers)
      const cityCol = findCidadeColumn(headers)
      const addrCol = findEnderecoColumn(headers)
      const tagCol = findTagColumn(headers)
      if (!pCol) {
        onError(
          'Não encontrei a coluna de telefone. Baixe o modelo (nome, telefone, email, cargo, empresa, cidade, endereco, tag).',
        )
        return
      }

      type Accum = {
        phone: string
        name: string
        email: string | null
        job_title: string | null
        company_name: string | null
        city: string | null
        address_line: string | null
        tagCell: string
      }

      const defaultTag = importTagLabelCsvDefault()
      const byPhone = new Map<string, Accum>()

      for (const row of rows) {
        const nameRaw = nCol ? row[nCol] ?? '' : ''
        const name = (nameRaw || 'Contato').trim().slice(0, 200) || 'Contato'
        const d = phoneDigitsForLead(row[pCol] ?? '')
        if (!d) continue
        const tagCellRaw = tagCol ? (row[tagCol] ?? '').trim() : ''
        const acc: Accum = {
          phone: d,
          name,
          email: eCol ? (row[eCol] ?? '').trim().slice(0, 320) || null : null,
          job_title: cargoCol ? (row[cargoCol] ?? '').trim().slice(0, 240) || null : null,
          company_name: empCol ? (row[empCol] ?? '').trim().slice(0, 240) || null : null,
          city: cityCol ? (row[cityCol] ?? '').trim().slice(0, 160) || null : null,
          address_line: addrCol ? (row[addrCol] ?? '').trim().slice(0, 500) || null : null,
          tagCell: tagCellRaw,
        }
        byPhone.set(d, acc)
      }

      if (byPhone.size === 0) {
        onError('Nenhum telefone válido no arquivo. Verifique o DDI 55 e o formato.')
        return
      }

      const queryKeys: string[] = []
      for (const phone of byPhone.keys()) {
        queryKeys.push(...allCanonicalPhoneKeys(phone))
      }
      const uniqueQueryKeys = [...new Set(queryKeys)]

      type LeadMini = { id: string; phone: string | null }
      const existingList: LeadMini[] = []
      const seenId = new Set<string>()
      const chunkIn = 100
      for (let i = 0; i < uniqueQueryKeys.length; i += chunkIn) {
        const slice = uniqueQueryKeys.slice(i, i + chunkIn)
        const { data, error: qErr } = await supabase
          .from('leads')
          .select('id, phone')
          .eq('user_id', userId)
          .in('phone', slice)
        if (qErr) {
          onError(`Erro ao buscar existentes: ${qErr.message}`)
          return
        }
        for (const r of (data ?? []) as LeadMini[]) {
          if (!seenId.has(r.id)) {
            seenId.add(r.id)
            existingList.push(r)
          }
        }
      }

      const phoneLookup = buildPhoneToLeadIdMap(existingList)

      type InsertRow = {
        user_id: string
        name: string
        phone: string
        status: string
        ai_enabled: boolean
        source: string
        tag: string | null
        email: string | null
        job_title: string | null
        company_name: string | null
        city: string | null
        address_line: string | null
      }

      type UpdatePatch = {
        name: string
        phone: string
        email: string | null
        job_title: string | null
        company_name: string | null
        city: string | null
        address_line: string | null
        updated_at: string
        tag?: string | null
      }

      const toInsert: InsertRow[] = []
      const toUpdate: { id: string; patch: UpdatePatch }[] = []

      for (const acc of byPhone.values()) {
        const existingId = findLeadIdForNormalizedPhone(phoneLookup, acc.phone)
        const tagExplicit = acc.tagCell.length > 0 ? acc.tagCell.slice(0, 480) : null

        const patchCore = {
          name: acc.name,
          phone: acc.phone,
          email: acc.email,
          job_title: acc.job_title,
          company_name: acc.company_name,
          city: acc.city,
          address_line: acc.address_line,
          updated_at: new Date().toISOString(),
        }

        if (existingId) {
          const patch: UpdatePatch =
            tagExplicit !== null
              ? { ...patchCore, tag: tagExplicit }
              : { ...patchCore }
          toUpdate.push({ id: existingId, patch })
        } else {
          toInsert.push({
            user_id: userId,
            name: acc.name,
            phone: acc.phone,
            status: 'novo',
            ai_enabled: true,
            source: 'manual_csv',
            tag: tagExplicit ?? defaultTag,
            email: acc.email,
            job_title: acc.job_title,
            company_name: acc.company_name,
            city: acc.city,
            address_line: acc.address_line,
          })
        }
      }

      setImportProgress(`Processando ${byPhone.size} linha(s) — atualizando e criando…`)

      const updChunk = 25
      for (let i = 0; i < toUpdate.length; i += updChunk) {
        const slice = toUpdate.slice(i, i + updChunk)
        const results = await Promise.all(
          slice.map(({ id, patch }) =>
            supabase.from('leads').update(patch).eq('id', id).eq('user_id', userId),
          ),
        )
        const failed = results.find((r) => r.error)
        if (failed?.error) {
          onError(`Erro ao atualizar: ${failed.error.message}`)
          return
        }
      }

      const ch = 150
      for (let i = 0; i < toInsert.length; i += ch) {
        const { error: insE } = await supabase.from('leads').insert(toInsert.slice(i, i + ch))
        if (insE) {
          onError(`Erro ao criar registros: ${insE.message}`)
          return
        }
      }

      onSuccess(
        `CSV aplicado à base (${byPhone.size} número(s)): ${toUpdate.length} atualizado(s), ${toInsert.length} novo(s). Novos sem tag no arquivo recebem “${defaultTag}”; em atualizações, tag vazia preserva a atual.`,
      )
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
    <div className="flex min-h-[min(680px,calc(100vh-240px))] flex-col gap-3">
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
          <div className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
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
                E-mail (opcional)
                <input
                  type="email"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600">
                  Cargo (opcional)
                  <input
                    value={addJobTitle}
                    onChange={(e) => setAddJobTitle(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600">
                  Empresa (opcional)
                  <input
                    value={addCompany}
                    onChange={(e) => setAddCompany(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600">
                  Cidade (opcional)
                  <input
                    value={addCity}
                    onChange={(e) => setAddCity(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600">
                  Endereço (opcional)
                  <input
                    value={addAddress}
                    onChange={(e) => setAddAddress(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-xs font-medium text-zinc-600">
                Etiqueta (tag) (opcional)
                <input
                  value={addTag}
                  onChange={(e) => setAddTag(e.target.value)}
                  list="tag-ac-list-add"
                  placeholder="Ex.: Cliente VIP"
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
                <datalist id="tag-ac-list-add">
                  {tagAutocompleteList.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
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
      {csvOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-zinc-900">Importar CSV</h4>
            <p className="mt-1 text-sm text-zinc-600">
              Colunas do modelo:{' '}
              <code className="text-xs">
                nome, telefone, email, cargo, empresa, cidade, endereco, tag
              </code>
              . Obrigatório: <strong>nome</strong> e <strong>telefone</strong>. Linhas com o mesmo
              telefone (considerando o 9º dígito BR) são <strong>mescladas</strong> com o cadastro
              existente.
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
          <div className="max-h-[min(90vh,760px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl">
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
                E-mail
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600">
                  Cargo
                  <input
                    value={editJobTitle}
                    onChange={(e) => setEditJobTitle(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600">
                  Empresa
                  <input
                    value={editCompany}
                    onChange={(e) => setEditCompany(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600">
                  Cidade
                  <input
                    value={editCity}
                    onChange={(e) => setEditCity(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600">
                  Endereço
                  <input
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-xs font-medium text-zinc-600">
                Etiqueta (tag)
                <input
                  value={editTag}
                  onChange={(e) => setEditTag(e.target.value)}
                  list="tag-ac-list-edit"
                  placeholder="Ex.: Cliente VIP"
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
                <datalist id="tag-ac-list-edit">
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

            <div className="mt-8 border-t border-red-100 pt-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                Excluir lista inteira (por etiqueta)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Cada importação CSV recebe uma etiqueta do tipo{' '}
                <span className="font-mono text-[11px]">Importação Manual - DD/MM/AAAA</span>. Escolha a
                mesma etiqueta para apagar só aquela lista, ou qualquer etiqueta exata igual em todos os
                contatos.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={bulkDeleteTagPick}
                  onChange={(e) => {
                    setBulkDeleteTagPick(e.target.value)
                    setBulkDeletePreview(null)
                  }}
                  placeholder="Digite ou escolha a etiqueta"
                  list="contact-tag-delete-list"
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm"
                />
                <datalist id="contact-tag-delete-list">
                  {tagAutocompleteList.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <button
                  type="button"
                  disabled={bulkDeletePreviewBusy || !bulkDeleteTagPick.trim()}
                  onClick={() => void loadBulkDeleteCount()}
                  className="shrink-0 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {bulkDeletePreviewBusy ? 'Contando…' : 'Contar contatos'}
                </button>
              </div>
              {bulkDeletePreview !== null ? (
                <p className="mt-2 text-sm font-medium text-zinc-800">
                  {bulkDeletePreview} contato(s) com esta etiqueta.
                </p>
              ) : null}
              <button
                type="button"
                disabled={bulkDeleteBusy || (bulkDeletePreview ?? 0) < 1}
                onClick={() => openBulkDeleteConfirm()}
                className="mt-3 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                Excluir todos com esta etiqueta…
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkDeleteConfirmTag ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-zinc-950/60 p-4"
          role="alertdialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-red-100 bg-white p-6 shadow-2xl">
            <p className="text-base font-semibold text-red-900">Exclusão irreversível</p>
            <p className="mt-3 text-sm text-zinc-700">
              Serão removidos <strong>todos os contatos</strong> cuja etiqueta é exatamente:{' '}
              <strong className="break-all">{bulkDeleteConfirmTag}</strong>.
            </p>
            <p className="mt-2 text-sm text-zinc-600">
              Isso apaga também o histórico de mensagens vinculado a esses leads, conforme o banco.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={bulkDeleteBusy}
                onClick={() => setBulkDeleteConfirmTag(null)}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={bulkDeleteBusy}
                onClick={() => void executeBulkDeleteByTag()}
                className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
              >
                {bulkDeleteBusy ? 'Excluindo…' : 'Sim, excluir todos'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#dadce0] bg-white shadow-sm lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-1 border-b border-[#dadce0] bg-white p-3 lg:w-[280px] lg:border-b-0 lg:border-r">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mb-2 inline-flex items-center justify-center gap-2 rounded-full border border-[#dadce0] bg-white px-4 py-2.5 text-sm font-medium text-[#1a73e8] shadow-sm transition hover:bg-[#f8f9fa]"
          >
            <Plus className="h-5 w-5 shrink-0" strokeWidth={2} aria-hidden />
            Criar contato
          </button>
          <button
            type="button"
            onClick={() => {
              setSidebarNav('all')
              setSidebarTagFilter(null)
            }}
            className={`flex w-full items-center justify-between rounded-r-full px-4 py-2 text-left text-sm font-medium ${
              sidebarNav === 'all' && sidebarTagFilter === null
                ? 'bg-[#e8f0fe] text-[#1967d2]'
                : 'text-[#3c4043] hover:bg-[#f1f3f4]'
            }`}
          >
            <span>Contatos</span>
            <span className="text-xs tabular-nums text-[#5f6368]">{leads.length}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSidebarNav('starred')
              setSidebarTagFilter(null)
            }}
            className={`flex w-full items-center justify-between rounded-r-full px-4 py-2 text-left text-sm font-medium ${
              sidebarNav === 'starred'
                ? 'bg-[#e8f0fe] text-[#1967d2]'
                : 'text-[#3c4043] hover:bg-[#f1f3f4]'
            }`}
          >
            <span>Frequentes</span>
            <span className="text-xs tabular-nums text-[#5f6368]">
              {leads.filter((x) => x.contact_starred).length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSidebarNav('other')
              setSidebarTagFilter(null)
            }}
            className={`flex w-full items-center justify-between rounded-r-full px-4 py-2 text-left text-sm font-medium ${
              sidebarNav === 'other'
                ? 'bg-[#e8f0fe] text-[#1967d2]'
                : 'text-[#3c4043] hover:bg-[#f1f3f4]'
            }`}
          >
            <span>Outros contatos</span>
            <span className="text-xs tabular-nums text-[#5f6368]">
              {leads.filter(isOtherContactRow).length}
            </span>
          </button>

          <p className="mt-4 px-4 text-[11px] font-medium uppercase tracking-wide text-[#5f6368]">
            Corrigir e gerenciar
          </p>
          <button
            type="button"
            onClick={() => setCsvOpen(true)}
            className="flex w-full items-center gap-2 rounded-r-full px-4 py-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
          >
            <Upload className="h-4 w-4 shrink-0 text-[#5f6368]" aria-hidden />
            Importar arquivo
          </button>
          <button
            type="button"
            onClick={() => setTagManagerOpen(true)}
            className="flex w-full items-center gap-2 rounded-r-full px-4 py-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
          >
            <Settings2 className="h-4 w-4" aria-hidden />
            Etiquetas
          </button>
          <button
            type="button"
            disabled={selectedLeadIds.size === 0}
            onClick={() => setAudienceOpen(true)}
            className="flex w-full items-center gap-2 rounded-r-full px-4 py-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4] disabled:opacity-40"
          >
            <Users2 className="h-4 w-4" aria-hidden />
            Criar público ({selectedLeadIds.size})
          </button>

          <div className="mt-4 flex items-center justify-between px-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#5f6368]">
              Marcadores
            </p>
            <button
              type="button"
              onClick={() => setTagManagerOpen(true)}
              className="rounded p-1 text-[#5f6368] hover:bg-[#f1f3f4]"
              title="Gerenciar marcadores"
              aria-label="Adicionar marcador"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[200px] space-y-0.5 overflow-y-auto pb-2">
            {marcadoresSidebar.length === 0 ? (
              <p className="px-4 py-2 text-xs text-[#80868b]">Nenhum marcador ainda.</p>
            ) : (
              marcadoresSidebar.map((m) => {
                const active = sidebarTagFilter === m.label
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      setSidebarNav('all')
                      setSidebarTagFilter(active ? null : m.label)
                    }}
                    className={`flex w-full items-center justify-between rounded-r-full px-4 py-1.5 text-left text-sm ${
                      active ? 'bg-[#e8f0fe] text-[#1967d2]' : 'text-[#3c4043] hover:bg-[#f1f3f4]'
                    }`}
                  >
                    <span className="truncate pr-2" title={m.label}>
                      {m.label}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[#5f6368]">{m.count}</span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dadce0] px-6 py-4">
            <h2 className="text-[22px] font-normal tracking-tight text-[#202124]">
              Contatos ({filtered.length})
            </h2>
          </header>

          <div className="flex flex-col gap-3 border-b border-[#f1f3f4] px-6 py-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="relative min-w-0 max-w-xl flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#5f6368]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisa"
                className="w-full rounded-lg border border-[#dadce0] bg-[#f1f3f4] py-2.5 pl-10 pr-4 text-sm text-[#202124] placeholder:text-[#5f6368] focus:border-[#1a73e8] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#1a73e8]"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-[#5f6368]">
                Origem
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={selectAllOrigins}
                  className="rounded-md px-2 py-1 text-[10px] font-medium text-[#1a73e8] hover:underline"
                >
                  Todas
                </button>
                {SOURCE_DEFS.map((o) => {
                  const on = includeSources.has(o.id)
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggleSource(o.id)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-[#dadce0] transition ${
                        on ? o.className + ' opacity-100' : 'bg-zinc-50 text-zinc-400 line-through'
                      }`}
                    >
                      {o.label}
                    </button>
                  )
                })}
                <button
                  type="button"
                  onClick={() => toggleSource(NULL_KEY)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-[#dadce0] ${
                    includeSources.has(NULL_KEY)
                      ? 'bg-zinc-200 text-zinc-900'
                      : 'bg-zinc-50 text-zinc-400 line-through'
                  }`}
                >
                  Sem origem
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-1 justify-center py-16 text-sm text-[#5f6368]">
              Carregando contatos…
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[960px] table-fixed border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-[1] border-b border-[#e8eaed] bg-white">
                    <tr className="text-xs font-medium text-[#5f6368]">
                      <th className="w-10 px-2 py-3 pl-6 font-medium" aria-hidden />
                      <th className="w-12 px-1 py-3 font-medium" aria-hidden />
                      <th className="relative w-[26%] py-3 pl-2 pr-4 font-medium">Título</th>
                      <th className="w-[18%] px-4 py-3 font-medium">E-mail</th>
                      <th className="w-[14%] px-4 py-3 font-medium">Número de telefone</th>
                      <th className="w-[18%] px-4 py-3 font-medium">Cargo e empresa</th>
                      <th className="w-[12%] px-4 py-3 font-medium">Cidade</th>
                      <th className="w-[18%] px-4 py-3 font-medium">Endereço</th>
                      <th className="w-[120px] py-3 pr-6 text-right font-medium">
                        <span className="sr-only">Ações</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-[#202124]">
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-6 py-12 text-center text-sm text-[#5f6368]">
                          Nenhum contato nesta visualização.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((l) => {
                        const checked = selectedLeadIds.has(l.id)
                        const initial = ((l.name || '?').trim().charAt(0) || '?').toUpperCase()
                        const hue = avatarHue(l.name || l.id)
                        const menuOpen = rowMenuLeadId === l.id
                        return (
                          <tr
                            key={l.id}
                            className="group border-b border-[#e8eaed] transition-colors hover:bg-[#e8f0fe]"
                          >
                            <td className="w-10 py-2 pl-4 align-middle">
                              <span
                                className={`inline-flex text-[#5f6368] ${checked ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}`}
                              >
                                <GripVertical className="h-4 w-4" aria-hidden />
                              </span>
                            </td>
                            <td className="w-12 py-2 pl-1 align-middle">
                              <input
                                type="checkbox"
                                className={`rounded border-[#dadce0] text-[#1a73e8] focus:ring-[#1a73e8] ${checked ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}`}
                                checked={checked}
                                onChange={() => toggleLeadSelected(l.id)}
                                aria-label={`Selecionar ${l.name}`}
                              />
                            </td>
                            <td className="py-2 pr-2 align-middle">
                              <div className="flex min-w-0 items-center gap-3">
                                <span
                                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white shadow-sm"
                                  style={{ backgroundColor: `hsl(${hue} 54% 46%)` }}
                                >
                                  {initial}
                                </span>
                                <span className="truncate font-medium">{l.name}</span>
                              </div>
                            </td>
                            <td className="truncate px-4 py-2 align-middle text-sm text-[#3c4043]">
                              {l.email ?? '—'}
                            </td>
                            <td className="truncate px-4 py-2 align-middle font-mono text-xs tabular-nums text-[#3c4043]">
                              {l.phone ?? '—'}
                            </td>
                            <td className="truncate px-4 py-2 align-middle text-sm text-[#3c4043]">
                              {jobCompanyLine(l.job_title, l.company_name)}
                            </td>
                            <td className="truncate px-4 py-2 align-middle text-sm text-[#3c4043]">
                              {(l.city ?? '').trim() || '—'}
                            </td>
                            <td className="truncate px-4 py-2 align-middle text-sm text-[#3c4043]">
                              {(l.address_line ?? '').trim() || '—'}
                            </td>
                            <td className="relative py-2 pr-4 text-right align-middle">
                              <div
                                className={`inline-flex items-center justify-end gap-0.5 ${menuOpen ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => void toggleStarLead(l)}
                                  className="rounded-full p-2 text-[#5f6368] hover:bg-[#dadce0]/50"
                                  title={l.contact_starred ? 'Remover dos frequentes' : 'Favoritar'}
                                  aria-label="Favoritar"
                                >
                                  <Star
                                    className="h-[18px] w-[18px]"
                                    fill={l.contact_starred ? '#f9ab00' : 'none'}
                                    stroke={l.contact_starred ? '#f9ab00' : 'currentColor'}
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEdit(l)}
                                  className="rounded-full p-2 text-[#5f6368] hover:bg-[#dadce0]/50"
                                  title="Editar"
                                  aria-label="Editar"
                                >
                                  <Pencil className="h-[18px] w-[18px]" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRowMenuLeadId(menuOpen ? null : l.id)}
                                  className="rounded-full p-2 text-[#5f6368] hover:bg-[#dadce0]/50"
                                  aria-expanded={menuOpen}
                                  aria-label="Mais opções"
                                >
                                  <MoreVertical className="h-[18px] w-[18px]" />
                                </button>
                              </div>
                              {menuOpen ? (
                                <div
                                  ref={rowMenuRef}
                                  className="absolute right-6 top-[calc(100%-4px)] z-20 min-w-[220px] rounded-lg border border-[#dadce0] bg-white py-1 shadow-lg"
                                  role="menu"
                                >
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                                    role="menuitem"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(exportContactJson(l))
                                      onSuccess('Dados exportados para a área de transferência.')
                                      setRowMenuLeadId(null)
                                    }}
                                  >
                                    <Copy className="h-4 w-4" aria-hidden />
                                    Exportar
                                  </button>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                                    role="menuitem"
                                    onClick={() => {
                                      void duplicateLead(l)
                                      setRowMenuLeadId(null)
                                    }}
                                  >
                                    <UserPlus className="h-4 w-4" aria-hidden />
                                    Duplicar
                                  </button>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[#d93025] hover:bg-[#fce8e6]"
                                    role="menuitem"
                                    onClick={() => {
                                      setDeleteTarget(l)
                                      setRowMenuLeadId(null)
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" aria-hidden />
                                    Excluir
                                  </button>
                                  <div className="my-1 border-t border-[#e8eaed]" />
                                  <p className="px-4 py-1 text-xs font-medium uppercase text-[#5f6368]">
                                    Alterar marcadores
                                  </p>
                                  <div className="max-h-40 overflow-y-auto">
                                    {[
                                      ...new Set([
                                        ...presets.map((p) => p.name.trim()),
                                        ...tagAutocompleteList,
                                      ]),
                                    ]
                                      .filter(Boolean)
                                      .slice(0, 16)
                                      .map((tagName) => (
                                        <button
                                          key={tagName}
                                          type="button"
                                          className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-[#3c4043] hover:bg-[#f1f3f4]"
                                          onClick={() => void setLeadTagQuick(l.id, tagName)}
                                        >
                                          <span
                                            className={`inline-block h-3.5 w-3.5 rounded border ${(l.tag ?? '').trim() === tagName.trim() ? 'border-[#1a73e8] bg-[#1a73e8]' : 'border-[#dadce0]'}`}
                                          />
                                          {tagName}
                                        </button>
                                      ))}
                                  </div>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-[#e8eaed] px-6 py-2 text-xs text-[#5f6368]">
                Mostrando {filtered.length} de {leads.length} nesta vista.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
