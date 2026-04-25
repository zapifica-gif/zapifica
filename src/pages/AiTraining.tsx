import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Loader2, Save, SquarePen } from 'lucide-react'
import { supabase } from '../lib/supabase'

type AiCompanyContextRow = {
  id: number
  user_id: string
  master_prompt: string
  company_summary: string
  updated_at: string
}

type AiTrainingMaterialRow = {
  id: string
  type: 'text' | 'link' | 'file'
  content: string | null
  url: string | null
  is_processed: boolean
  created_at: string
}

export function AiTrainingPage() {
  const [loading, setLoading] = useState(true)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [contextId, setContextId] = useState<number | null>(null)
  const [masterPrompt, setMasterPrompt] = useState('')

  const [materialText, setMaterialText] = useState('')
  const [addingMaterial, setAddingMaterial] = useState(false)
  const [materials, setMaterials] = useState<AiTrainingMaterialRow[]>([])

  const canAddMaterial = useMemo(() => materialText.trim().length > 0, [materialText])

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

    // 2) Materiais
    const mats = await supabase
      .from('ai_training_materials')
      .select('id, type, content, url, is_processed, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (mats.error) {
      setError(`Falha ao carregar materiais: ${mats.error.message}`)
      setLoading(false)
      return
    }

    setMaterials((mats.data ?? []) as AiTrainingMaterialRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

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

  async function adicionarTexto() {
    if (!canAddMaterial) return
    setAddingMaterial(true)
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
      type: 'text' as const,
      content: materialText.trim(),
      url: null,
      is_processed: false,
    }

    const { data, error: insErr } = await supabase
      .from('ai_training_materials')
      .insert(payload)
      .select('id, type, content, url, is_processed, created_at')
      .single()

    setAddingMaterial(false)
    if (insErr) {
      setError(`Falha ao adicionar material: ${insErr.message}`)
      return
    }

    setMaterialText('')
    setMaterials((prev) => [data as AiTrainingMaterialRow, ...prev])
  }

  return (
    <div className="space-y-6">
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
              Fase 1: adicionar texto. Upload e links entram na Fase 2.
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-xs font-semibold text-zinc-700">Adicionar texto</p>
            <textarea
              value={materialText}
              onChange={(e) => setMaterialText(e.target.value)}
              rows={6}
              placeholder="Cole aqui informações úteis: ofertas, prazos, objeções, diferenciais, perguntas frequentes..."
              className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-600/20"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void adicionarTexto()}
                disabled={loading || addingMaterial || !canAddMaterial}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {addingMaterial ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Adicionar
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-4">
            <p className="text-xs font-semibold text-zinc-700">Em breve</p>
            <div className="mt-3 grid grid-cols-1 gap-2">
              <button
                type="button"
                disabled
                className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-400"
              >
                Fazer Upload de PDF/Doc
              </button>
              <button
                type="button"
                disabled
                className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-400"
              >
                Adicionar Link
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-zinc-700">Textos adicionados</p>
            <button
              type="button"
              onClick={() => void loadAll()}
              disabled={loading}
              className="text-xs font-semibold text-brand-700 hover:underline disabled:opacity-50"
            >
              Recarregar
            </button>
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-zinc-500">Carregando…</p>
          ) : materials.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Nenhum material ainda.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {materials.map((m) => (
                <li
                  key={m.id}
                  className="rounded-xl border border-zinc-200 bg-white p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                      {m.type === 'text' ? 'Texto' : m.type}
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

