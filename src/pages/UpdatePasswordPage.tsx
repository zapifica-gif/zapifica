import { useState, type FormEvent } from 'react'
import { ArrowRight, Check, Lock } from 'lucide-react'
import logoZapifica from '../assets/logo-zapifica.png'
import { supabase } from '../lib/supabase'

type Props = {
  /** Chamado após salvar a nova senha com sucesso (ex.: limpar modo recovery e URL). */
  onCompleted: () => void
}

function mapUpdateError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('password') && m.includes('weak')) {
    return 'A senha é fraca demais. Use mais caracteres e combine letras e números.'
  }
  if (m.includes('same')) {
    return 'A nova senha não pode ser igual à anterior.'
  }
  return message || 'Não foi possível atualizar a senha.'
}

export function UpdatePasswordPage({ onCompleted }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const inputFocusClass =
    'outline-none transition placeholder:text-zinc-600 focus:border-google-blue/80 focus-visible:border-google-blue/80 focus-visible:ring-2 focus-visible:ring-google-blue/90 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-60'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 6) {
      setError('Use pelo menos 6 caracteres na nova senha.')
      return
    }
    if (password !== confirm) {
      setError('A confirmação precisa ser igual à nova senha.')
      return
    }
    setSubmitting(true)
    const { error: upErr } = await supabase.auth.updateUser({ password })
    setSubmitting(false)
    if (upErr) {
      setError(mapUpdateError(upErr.message))
      return
    }
    onCompleted()
  }

  async function signOutAndLeave() {
    await supabase.auth.signOut()
    onCompleted()
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-zinc-950 px-4 py-12">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-600/25 via-zinc-950 to-zinc-950" />
      <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-brand-green/10 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex w-fit items-center justify-center rounded-2xl bg-white p-3 shadow-md ring-1 ring-zinc-200/80">
            <img
              src={logoZapifica}
              alt="Zapifica"
              className="h-10 w-auto max-w-[220px] object-contain"
              width={220}
              height={40}
            />
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
            Defina uma nova senha segura para a sua conta Zapifica.
          </p>
        </div>

        <div className="animate-panel-in rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 shadow-2xl shadow-black/40 ring-1 ring-white/5 backdrop-blur-xl">
          <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-950/30 px-3 py-1 text-xs font-semibold text-emerald-200">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Link válido — você está em modo recuperação
          </div>
          <h2 className="mt-4 text-lg font-semibold text-white">Nova senha</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Digite a nova senha duas vezes e confirme para entrar no painel.
          </p>

          {error ? (
            <div
              role="alert"
              className="mt-5 rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </div>
          ) : null}

          <form className="mt-8 space-y-5" onSubmit={(e) => void handleSubmit(e)}>
            <div>
              <label
                htmlFor="new-password"
                className="mb-1.5 block text-sm font-medium text-zinc-300"
              >
                Nova senha
              </label>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                />
                <input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  disabled={submitting}
                  className={`h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 pl-10 pr-3 text-sm text-white ${inputFocusClass}`}
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="confirm-password"
                className="mb-1.5 block text-sm font-medium text-zinc-300"
              >
                Confirmar nova senha
              </label>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                />
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repita a senha"
                  disabled={submitting}
                  className={`h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 pl-10 pr-3 text-sm text-white ${inputFocusClass}`}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary-magnetic group h-11 w-full disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Salvando…' : 'Salvar nova senha'}
              <ArrowRight
                className="h-4 w-4 transition group-hover:translate-x-0.5 group-disabled:group-hover:translate-x-0"
                aria-hidden
              />
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-zinc-500">
            <button
              type="button"
              onClick={() => void signOutAndLeave()}
              className="font-medium text-zinc-400 underline-offset-2 transition hover:text-white hover:underline"
            >
              Cancelar e voltar ao login
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
