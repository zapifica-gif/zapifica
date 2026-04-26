import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { BookOpen, Link2, Loader2, Save, SquarePen, Trash2, Upload } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { supabase } from '../lib/supabase'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

type AiCompanyContextRow = {
  id: number
  user_id: string
  master_prompt: string
  company_summary: string
  updated_at: string
}

type AiTrainingMaterialRow = {
  id: string
  category_id: string | null
  type: 'text' | 'link' | 'file'
  content: string | null
  url: string | null
  is_processed: boolean
  created_at: string
}

type AiTrainingCategoryRow = {
  id: string
  user_id: string
  name: string
  is_active: boolean
  created_at: string
}

export function AiTrainingPage() {
  const [loading, setLoading] = useState(true)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [contextId, setContextId] = useState<number | null>(null)
  const [masterPrompt, setMasterPrompt] = useState('')

  const [categories, setCategories] = useState<AiTrainingCategoryRow[]>([])
  const [materials, setMaterials] = useState<AiTrainingMaterialRow[]>([])

  const [newCategoryName, setNewCategoryName] = useState('')
  const [creatingCategory, setCreatingCategory] = useState(false)

  const [studying, setStudying] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkCategoryId, setLinkCategoryId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadCategoryId, setUploadCategoryId] = useState<string | null>(null)

  const [textDraftByCategory, setTextDraftByCategory] = useState<Record<string, string>>({})
  const [addingTextCategoryId, setAddingTextCategoryId] = useState<string | null>(null)

  const materialsByCategory = useMemo(() => {
    const map: Record<string, AiTrainingMaterialRow[]> = {}
    for (const m of materials) {
      const cid = m.category_id ?? '__none__'
      if (!map[cid]) map[cid] = []
      map[cid].push(m)
    }
    return map
  }, [materials])

  const loadAll = useCallback(async () => {
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

    // 1) Contexto: se não existir, cria uma linha vazia para este usuário.
    const ctx = await supabase
      .from('ai_company_context')
      .select('id, user_id, master_prompt, company_summary, updated_at')
      .eq('user_id', user.id)
      .maybeSingle()

    if (ctx.error) {
      setError(`Falha ao carregar contexto: ${ctx.error.message}`)
      setLoading(false)
      return
    }

    if (!ctx.data) {
      const created = await supabase
        .from('ai_company_context')
        .insert({ user_id: user.id, master_prompt: '', company_summary: '' })
        .select('id, user_id, master_prompt, company_summary, updated_at')
        .single()
      if (created.error) {
        setError(`Falha ao criar contexto: ${created.error.message}`)
        setLoading(false)
        return
      }
      const row = created.data as AiCompanyContextRow
      setContextId(row.id)
      setMasterPrompt(row.master_prompt ?? '')
    } else {
      const row = ctx.data as AiCompanyContextRow
      setContextId(row.id)
      setMasterPrompt(row.master_prompt ?? '')
    }

    // 2) Categorias + Materiais
    const [cats, mats] = await Promise.all([
      supabase
        .from('ai_training_categories')
        .select('id, user_id, name, is_active, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('ai_training_materials')
        .select('id, category_id, type, content, url, is_processed, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200),
    ])

    if (cats.error) {
      setError(`Falha ao carregar categorias: ${cats.error.message}`)
      setLoading(false)
      return
    }
    if (mats.error) {
      setError(`Falha ao carregar materiais: ${mats.error.message}`)
      setLoading(false)
      return
    }

    setCategories((cats.data ?? []) as AiTrainingCategoryRow[])
    setMaterials((mats.data ?? []) as AiTrainingMaterialRow[])
    setLoading(false)
  }, [])

  /** Monta mensagem legível a partir do corpo JSON da Edge Function ou do Response do cliente. */
  async function mensagemErroProcessamento(err: unknown, data: unknown): Promise<string> {
    let backend = ''
    if (data !== null && data !== undefined && typeof data === 'object' && 'error' in data) {
      const v = (data as { error: unknown }).error
      if (typeof v === 'string' && v.trim()) backend = v.trim()
    }
    if (!backend && err !== null && err !== undefined && typeof err === 'object') {
      const ctx = (err as { context?: { response?: Response; json?: () => Promise<unknown> } }).context
      const jsonFn = ctx?.json
      if (typeof jsonFn === 'function') {
        try {
          const contextData = (await jsonFn()) as { error?: unknown } | null
          if (contextData && typeof contextData.error === 'string' && contextData.error.trim()) {
            backend = contextData.error.trim()
          }
        } catch {
          /* ignore */
        }
      }
      const res = ctx?.response
      if (res) {
        try {
          const text = await res.clone().text()
          if (text) {
            try {
              const j = JSON.parse(text) as { error?: string }
              if (typeof j?.error === 'string' && j.error.trim()) backend = j.error.trim()
              else backend = text.slice(0, 400)
            } catch {
              backend = text.slice(0, 400)
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    const base = err instanceof Error ? err.message : String(err)
    if (backend) return `Erro ao processar: ${backend}`
    return `Erro ao processar: ${base}`
  }

  async function processarLink() {
    const url = linkUrl.trim()
    if (!url) {
      setError('Informe uma URL válida.')
      return
    }
    if (!linkCategoryId) {
      setError('Selecione uma categoria antes de estudar um link.')
      return
    }
    setStudying(true)
    setError(null)
    try {
      const { data, error } = await supabase.functions.invoke('process-ai-training', {
        body: { type: 'link', url, categoryId: linkCategoryId },
      })
      if (error) {
        const msg = await mensagemErroProcessamento(error, data)
        setError(msg)
        window.alert(msg)
        return
      }
      const row = (data as { material?: AiTrainingMaterialRow } | null)?.material
      if (row) {
        setMaterials((prev) => [row, ...prev])
      }
      setLinkModalOpen(false)
      setLinkUrl('')
      setLinkCategoryId(null)
      void loadAll()
    } catch (e) {
      const msg = `Erro ao processar: ${e instanceof Error ? e.message : String(e)}`
      setError(msg)
      window.alert(msg)
    } finally {
      setStudying(false)
    }
  }

  async function onEscolherArquivo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    const categoryId = uploadCategoryId
    setUploadCategoryId(null)
    if (!categoryId) {
      setError('Selecione uma categoria antes de enviar arquivo.')
      return
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setError('Sessão inválida. Entre novamente.')
      return
    }

    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${user.id}/treino_${crypto.randomUUID()}_${safe}`

    setStudying(true)
    setError(null)

    try {
      const { error: upErr } = await supabase.storage
        .from('training_files')
        .upload(path, file, {
          upsert: true,
          contentType: file.type || undefined,
        })
      if (upErr) {
        const msg = `Falha no upload: ${upErr.message}`
        setError(msg)
        window.alert(msg)
        return
      }

      const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
      if (isPdf) {
        const arrayBuffer = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise
        let extractedText = ''
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const textContent = await page.getTextContent()
          extractedText += textContent.items.map((s: any) => s.str).join(' ') + '\n'
        }

        const { data, error } = await supabase.functions.invoke('process-ai-training', {
          body: { type: 'pdf_text', text: extractedText, filePath: path, categoryId },
        })
        if (error) {
          const msg = await mensagemErroProcessamento(error, data)
          setError(msg)
          window.alert(msg)
          return
        }
        const row = (data as { material?: AiTrainingMaterialRow } | null)?.material
        if (row) {
          setMaterials((prev) => [row, ...prev])
        }
        void loadAll()
        return
      }

      const { data, error } = await supabase.functions.invoke('process-ai-training', {
        body: { type: 'file', filePath: path, categoryId },
      })
      if (error) {
        const msg = await mensagemErroProcessamento(error, data)
        setError(msg)
        window.alert(msg)
        return
      }
      const row = (data as { material?: AiTrainingMaterialRow } | null)?.material
      if (row) {
        setMaterials((prev) => [row, ...prev])
      }
      void loadAll()
    } catch (e) {
      const msg = `Erro ao processar: ${e instanceof Error ? e.message : String(e)}`
      setError(msg)
      window.alert(msg)
    } finally {
      setStudying(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  async function criarCategoria() {
    const name = newCategoryName.trim()
    if (!name) return
    setCreatingCategory(true)
    setError(null)

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser()
    if (userErr || !user) {
      setCreatingCategory(false)
      setError('Sessão inválida. Entre novamente.')
      return
    }

    const { data, error: insErr } = await supabase
      .from('ai_training_categories')
      .insert({ user_id: user.id, name, is_active: true })
      .select('id, user_id, name, is_active, created_at')
      .single()

    setCreatingCategory(false)
    if (insErr) {
      setError(`Falha ao criar categoria: ${insErr.message}`)
      return
    }

    setNewCategoryName('')
    setCategories((prev) => [...prev, data as AiTrainingCategoryRow])
  }

  async function toggleCategoria(cat: AiTrainingCategoryRow) {
    const next = !cat.is_active
    setError(null)
    const { error: upErr } = await supabase
      .from('ai_training_categories')
      .update({ is_active: next })
      .eq('id', cat.id)
      .eq('user_id', cat.user_id)
    if (upErr) {
      setError(`Falha ao atualizar categoria: ${upErr.message}`)
      return
    }
    setCategories((prev) => prev.map((c) => (c.id === cat.id ? { ...c, is_active: next } : c)))
  }

  async function deletarCategoria(cat: AiTrainingCategoryRow) {
    const ok = window.confirm(
      `Tem certeza que deseja deletar a categoria "${cat.name}"? Os materiais dela também serão removidos.`,
    )
    if (!ok) return
    setError(null)

    const delMats = await supabase
      .from('ai_training_materials')
      .delete()
      .eq('user_id', cat.user_id)
      .eq('category_id', cat.id)
    if (delMats.error) {
      setError(`Falha ao remover materiais: ${delMats.error.message}`)
      return
    }

    const delCat = await supabase
      .from('ai_training_categories')
      .delete()
      .eq('id', cat.id)
      .eq('user_id', cat.user_id)
    if (delCat.error) {
      setError(`Falha ao remover categoria: ${delCat.error.message}`)
      return
    }

    setCategories((prev) => prev.filter((c) => c.id !== cat.id))
    setMaterials((prev) => prev.filter((m) => m.category_id !== cat.id))
  }

  async function salvarPrompt() {
    if (!contextId) return
    setSavingPrompt(true)
    setError(null)

    const { error: upErr } = await supabase
      .from('ai_company_context')
      .update({ master_prompt: masterPrompt })
      .eq('id', contextId)

    setSavingPrompt(false)
    if (upErr) {
      setError(`Falha ao salvar: ${upErr.message}`)
      return
    }
  }

  async function adicionarTexto(categoryId: string) {
    const draft = (textDraftByCategory[categoryId] ?? '').trim()
    if (!draft) return
    setAddingTextCategoryId(categoryId)
    setError(null)

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setAddingMaterial(false)
      setError('Sessão inválida. Entre novamente.')
      return
    }

    const payload = {
      user_id: user.id,
      category_id: categoryId,
      type: 'text' as const,
      content: draft,
      url: null,
      is_processed: false,
    }

    const { data, error: insErr } = await supabase
      .from('ai_training_materials')
      .insert(payload)
      .select('id, category_id, type, content, url, is_processed, created_at')
      .single()

    setAddingTextCategoryId(null)
    if (insErr) {
      setError(`Falha ao adicionar material: ${insErr.message}`)
      return
    }

    setTextDraftByCategory((prev) => ({ ...prev, [categoryId]: '' }))
    setMaterials((prev) => [data as AiTrainingMaterialRow, ...prev])
  }

  return (
    <div className="relative space-y-6">
      {studying ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-zinc-950/45 px-6 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
        >
          <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-2xl">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-brand-600" aria-hidden />
            <p className="mt-4 text-sm font-semibold text-zinc-900">
              A IA está estudando o material (isso pode levar 1 minuto)…
            </p>
            <p className="mt-2 text-xs text-zinc-600">
              Estamos extraindo o conteúdo e gerando um resumo estratégico com o modelo
              DeepSeek Reasoner antes de salvar na base de conhecimento.
            </p>
          </div>
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Treinamento da IA</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">
            Aqui você define o comportamento da IA e adiciona conhecimento bruto para ela usar no atendimento.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
              <SquarePen className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Instruções de Comportamento</h3>
              <p className="text-xs text-zinc-500">
                Diga como a IA deve agir. (Tom, objetivo, o que evitar, etc.)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void salvarPrompt()}
            disabled={loading || savingPrompt}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:from-brand-500 hover:to-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingPrompt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar
          </button>
        </div>

        <div className="mt-4">
          <textarea
            value={masterPrompt}
            onChange={(e) => setMasterPrompt(e.target.value)}
            rows={6}
            placeholder="Ex.: Seja rápido, gentil e persuasivo. Faça perguntas curtas para entender o objetivo do cliente..."
            className="w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-900 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
          />
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700 ring-1 ring-violet-200">
            <BookOpen className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Base de Conhecimento</h3>
            <p className="text-xs text-zinc-500">
              Crie categorias (ex.: empreendimentos) e ative/desative para controlar qual contexto a IA usa.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center">
          <input
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Criar novo empreendimento/categoria… (ex.: Residencial Atlântico)"
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
          />
          <button
            type="button"
            onClick={() => void criarCategoria()}
            disabled={loading || creatingCategory || !newCategoryName.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creatingCategory ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Criar
          </button>
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Recarregar
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          className="hidden"
          onChange={(e) => void onEscolherArquivo(e)}
        />

        <div className="mt-4 space-y-3">
          {loading ? (
            <p className="text-sm text-zinc-500">Carregando…</p>
          ) : categories.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nenhuma categoria ainda. Crie a primeira (ex.: “Dados Gerais” ou um empreendimento).
            </p>
          ) : (
            categories.map((cat) => {
              const draft = textDraftByCategory[cat.id] ?? ''
              const canAdd = draft.trim().length > 0
              const catMats = materialsByCategory[cat.id] ?? []
              return (
                <div key={cat.id} className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">{cat.name}</p>
                      <p className="text-xs text-zinc-500">
                        {cat.is_active ? 'Ativa no atendimento' : 'Desativada (não entra no contexto)'}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void toggleCategoria(cat)}
                        className={[
                          'relative inline-flex h-8 w-14 items-center rounded-full border transition',
                          cat.is_active ? 'border-emerald-200 bg-emerald-100' : 'border-zinc-200 bg-zinc-100',
                        ].join(' ')}
                        aria-pressed={cat.is_active}
                      >
                        <span
                          className={[
                            'inline-block h-6 w-6 transform rounded-full bg-white shadow-sm transition',
                            cat.is_active ? 'translate-x-7' : 'translate-x-1',
                          ].join(' ')}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deletarCategoria(cat)}
                        className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100"
                      >
                        <Trash2 className="h-4 w-4" />
                        Lixeira
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                      <p className="text-xs font-semibold text-zinc-700">Adicionar texto</p>
                      <textarea
                        value={draft}
                        onChange={(e) =>
                          setTextDraftByCategory((prev) => ({ ...prev, [cat.id]: e.target.value }))
                        }
                        rows={6}
                        placeholder="Cole aqui informações úteis: ofertas, prazos, objeções, diferenciais, perguntas frequentes..."
                        className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-600/20"
                      />
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void adicionarTexto(cat.id)}
                          disabled={loading || addingTextCategoryId === cat.id || !canAdd}
                          className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {addingTextCategoryId === cat.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : null}
                          Adicionar
                        </button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-4">
                      <p className="text-xs font-semibold text-zinc-700">Arquivos e links</p>
                      <div className="mt-3 grid grid-cols-1 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setUploadCategoryId(cat.id)
                            fileInputRef.current?.click()
                          }}
                          disabled={loading || studying}
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Upload className="h-4 w-4" />
                          Fazer Upload de PDF/TXT
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setLinkUrl('')
                            setLinkCategoryId(cat.id)
                            setLinkModalOpen(true)
                          }}
                          disabled={loading || studying}
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Link2 className="h-4 w-4" />
                          Adicionar Link
                        </button>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                        PDF: o texto é extraído no seu navegador. TXT: o professor lê do Storage.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4">
                    <p className="text-xs font-semibold text-zinc-700">Materiais desta categoria</p>
                    {catMats.length === 0 ? (
                      <p className="mt-2 text-sm text-zinc-500">Nenhum material ainda.</p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {catMats.map((m) => (
                          <li key={m.id} className="rounded-xl border border-zinc-200 bg-white p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                                {m.type === 'text'
                                  ? 'Texto'
                                  : m.type === 'link'
                                    ? 'Link'
                                    : m.type === 'file'
                                      ? 'Arquivo'
                                      : m.type}
                                {m.is_processed ? ' · Processado' : ' · Pendente'}
                              </p>
                              <p className="text-[11px] text-zinc-400 tabular-nums">
                                {new Date(m.created_at).toLocaleString(undefined, {
                                  day: '2-digit',
                                  month: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </p>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-800">
                              {m.content ?? m.url ?? ''}
                            </p>
                            {m.url && m.type !== 'text' ? (
                              <a
                                href={m.url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline"
                              >
                                Abrir origem
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      {linkModalOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 px-4 backdrop-blur-[2px]">
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="link-modal-title"
          >
            <h3 id="link-modal-title" className="text-sm font-semibold text-zinc-900">
              Adicionar link
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Cole a URL pública (http ou https). A IA vai ler a página e gerar um resumo.
            </p>
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://…"
              className="mt-3 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-600/20"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setLinkModalOpen(false)
                  setLinkCategoryId(null)
                }}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void processarLink()}
                disabled={studying || !linkUrl.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-md hover:from-brand-500 hover:to-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {studying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Estudar link
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

