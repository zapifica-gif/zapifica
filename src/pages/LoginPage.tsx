import { useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Lock, Mail } from 'lucide-react'
import logoZapifica from '../assets/logo-zapifica.png'
import { supabase } from '../lib/supabase'

function mapAuthErrorMessage(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login') || m.includes('invalid credentials')) {
    return 'Email ou senha incorretos.'
  }
  if (m.includes('email not confirmed')) {
    return 'Confirme seu email antes de entrar.'
  }
  if (m.includes('too many requests')) {
    return 'Muitas tentativas. Aguarde um momento e tente de novo.'
  }
  return message || 'Não foi possível entrar. Tente novamente.'
}

type AuthView = 'login' | 'recovery'

export function LoginPage() {
  const [view, setView] = useState<AuthView>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: signError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    setSubmitting(false)

    if (signError) {
      setError(mapAuthErrorMessage(signError.message))
      return
    }
  }

  async function handleRecovery(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    const trimmed = email.trim()
    if (!trimmed) {
      setError('Informe o email da sua conta.')
      return
    }
    setSubmitting(true)
    const redirectTo = `${window.location.origin}/`
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo,
    })
    setSubmitting(false)
    if (resetErr) {
      setError(mapAuthErrorMessage(resetErr.message))
      return
    }
    setInfo(
      'Se existir uma conta com este email, enviamos um link para redefinir a senha. Confira a caixa de entrada e o spam.',
    )
  }

  const inputFocusClass =
    'outline-none transition placeholder:text-zinc-600 focus:border-google-blue/80 focus-visible:border-google-blue/80 focus-visible:ring-2 focus-visible:ring-google-blue/90 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-60'

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-zinc-950 px-4 py-12">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-600/25 via-zinc-950 to-zinc-950" />
      <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-brand-green/10 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex w-fit items-center justify-center rounded-xl bg-white px-4 py-2 shadow-sm">
            <img
              src={logoZapifica}
              alt="Zapifica"
              className="h-10 w-auto max-w-[220px] object-contain"
              width={220}
              height={40}
            />
          </div>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            Acesse sua conta para gerenciar conversas, funis e automações em
            tempo real.
          </p>
        </div>

        <div className="animate-panel-in rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 shadow-2xl shadow-black/40 ring-1 ring-white/5 backdrop-blur-xl">
          {view === 'login' ? (
            <>
              <h2 className="text-lg font-semibold text-white">
                Bem-vindo de volta
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Digite seus dados para continuar.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-white">Recuperar senha</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Informe o email da conta. Você recebe um link seguro da Zapifica
                para criar uma nova senha.
              </p>
            </>
          )}

          {error ? (
            <div
              role="alert"
              className="mt-5 rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </div>
          ) : null}
          {info ? (
            <div
              role="status"
              className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100"
            >
              {info}
            </div>
          ) : null}

          {view === 'login' ? (
            <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Email
                </label>
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                    aria-hidden
                  />
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="nome@empresa.com"
                    disabled={submitting}
                    className={`h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 pl-10 pr-3 text-sm text-white ${inputFocusClass}`}
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Senha
                </label>
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                    aria-hidden
                  />
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    disabled={submitting}
                    className={`h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 pl-10 pr-3 text-sm text-white ${inputFocusClass}`}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-sm">
                <label className="flex cursor-pointer items-center gap-2 text-zinc-400">
                  <input
                    type="checkbox"
                    disabled={submitting}
                    className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-google-blue focus-visible:ring-2 focus-visible:ring-google-blue/80 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-60"
                  />
                  Lembrar-me
                </label>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setView('recovery')
                    setError(null)
                    setInfo(null)
                  }}
                  className="font-medium text-google-blue/90 transition hover:text-google-blue disabled:opacity-50"
                >
                  Esqueceu a senha?
                </button>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="btn-primary-magnetic group h-11 w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Entrando…' : 'Entrar'}
                <ArrowRight
                  className="h-4 w-4 transition group-hover:translate-x-0.5 group-disabled:group-hover:translate-x-0"
                  aria-hidden
                />
              </button>
            </form>
          ) : (
            <form className="mt-8 space-y-5" onSubmit={(e) => void handleRecovery(e)}>
              <div>
                <label
                  htmlFor="recovery-email"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Email da conta
                </label>
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                    aria-hidden
                  />
                  <input
                    id="recovery-email"
                    name="recovery-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="nome@empresa.com"
                    disabled={submitting}
                    className={`h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 pl-10 pr-3 text-sm text-white ${inputFocusClass}`}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="btn-primary-magnetic w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Enviando…' : 'Enviar link de recuperação'}
              </button>

              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  setView('login')
                  setError(null)
                  setInfo(null)
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/50 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Voltar ao login
              </button>
            </form>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-zinc-600">
          Ao continuar, você aceita os termos de serviço e a política de
          privacidade da Zapifica.
        </p>
      </div>
    </div>
  )
}
