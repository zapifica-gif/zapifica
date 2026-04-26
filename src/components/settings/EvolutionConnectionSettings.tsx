import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  QrCode,
  Radio,
  RefreshCcw,
  Smartphone,
  Stethoscope,
  X,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  checkConnectionStatus,
  createInstanceAndGetQr,
  getEvolutionBaseUrl,
  getEvolutionWebhookUrl,
  instanceNameFromUserId,
  syncWebhookForCurrentInstance,
  verifyEvolutionInstance,
  type VerifyInstanceResult,
} from '../../services/evolution'

/**
 * Painel de conexão WhatsApp (Evolution API) — instância, QR, webhook, diagnóstico.
 * Antigo bloco “Zap Voice”; agora fica em Configurações.
 */
export function EvolutionConnectionSettings() {
  const [whatsappConnected, setWhatsappConnected] = useState(false)
  const [whatsappPhone, setWhatsappPhone] = useState<string | null>(null)

  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)

  const [successToast, setSuccessToast] = useState<string | null>(null)
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const [infoToast, setInfoToast] = useState<string | null>(null)
  const [disconnectHint, setDisconnectHint] = useState(false)
  const [webhookSyncing, setWebhookSyncing] = useState(false)

  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyInstanceResult | null>(
    null,
  )

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const evolutionBaseUrl = useMemo(() => getEvolutionBaseUrl(), [])
  const supabaseWebhookUrl = useMemo(() => getEvolutionWebhookUrl(), [])
  const previewInstanceName = useMemo(
    () => (currentUserId ? instanceNameFromUserId(currentUserId) : null),
    [currentUserId],
  )

  const closeQrModal = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    setQrModalOpen(false)
    setQrLoading(false)
    setQrDataUrl(null)
    setQrError(null)
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user || cancelled) return

      setCurrentUserId(user.id)

      const s = await checkConnectionStatus(user.id)
      if (cancelled) return

      if (!s.error) {
        setWhatsappConnected(s.connected)
        if (s.phone) setWhatsappPhone(s.phone)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!qrModalOpen) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      return
    }

    let active = true

    const setup = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user || !active) return

      const tick = async () => {
        if (!active) return
        const s = await checkConnectionStatus(user.id)
        if (!active) return

        if (s.connected) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current)
            pollingRef.current = null
          }
          setWhatsappConnected(true)
          if (s.phone) setWhatsappPhone(s.phone)
          setSuccessToast('WhatsApp conectado com sucesso!')
          window.setTimeout(() => {
            if (active) setSuccessToast(null)
          }, 6000)
          closeQrModal()
          return
        }

        if (s.phone) setWhatsappPhone(s.phone)
      }

      await tick()
      if (!active) return
      pollingRef.current = setInterval(tick, 3000)
    }

    void setup()

    return () => {
      active = false
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [qrModalOpen, closeQrModal])

  const openConnectFlow = useCallback(() => {
    setQrModalOpen(true)
    setQrLoading(true)
    setQrDataUrl(null)
    setQrError(null)

    void (async () => {
      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser()

      if (authErr || !user) {
        setQrError('Não foi possível identificar seu usuário. Faça login novamente.')
        setQrLoading(false)
        return
      }

      const result = await createInstanceAndGetQr(user.id)
      setQrLoading(false)

      if (result.error) {
        setQrError(result.error)
        return
      }

      if (result.dataUrl) {
        setQrDataUrl(result.dataUrl)
      } else {
        setQrError('A API não retornou um QR Code válido.')
      }
    })()
  }, [])

  const handleSyncWebhook = useCallback(async () => {
    if (webhookSyncing) return

    setErrorToast(null)
    setSuccessToast(null)
    setInfoToast('Sincronizando webhook…')
    setWebhookSyncing(true)

    try {
      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser()

      if (authErr || !user) {
        setInfoToast(null)
        setErrorToast(
          'Não foi possível identificar seu usuário. Faça login novamente.',
        )
        window.setTimeout(() => setErrorToast(null), 7000)
        return
      }

      setCurrentUserId(user.id)
      const result = await syncWebhookForCurrentInstance(user.id)
      setInfoToast(null)

      if (!result.ok) {
        const baseMsg =
          result.error ?? 'Não foi possível sincronizar o webhook com a Evolution.'
        const parts: string[] = [baseMsg]
        if (result.status) {
          parts.push(`(HTTP ${result.status})`)
        }
        if (result.instanceName) {
          parts.push(`Instância: ${result.instanceName}`)
        }
        if (result.pathTried) {
          parts.push(`Endpoint: ${result.pathTried}`)
        }
        setErrorToast(parts.join(' · '))
        window.setTimeout(() => setErrorToast(null), 12000)
        void (async () => {
          setVerifying(true)
          const audit = await verifyEvolutionInstance(user.id)
          setVerifyResult(audit)
          setVerifying(false)
        })()
        return
      }

      const successDetail = result.pathTried
        ? `Webhook sincronizado via ${result.pathTried}.`
        : 'Webhook sincronizado com sucesso!'
      setSuccessToast(successDetail)
      window.setTimeout(() => setSuccessToast(null), 6000)
    } finally {
      setWebhookSyncing(false)
    }
  }, [webhookSyncing])

  const handleTestConnection = useCallback(async () => {
    if (verifying) return
    setVerifying(true)
    setVerifyResult(null)
    setErrorToast(null)
    setSuccessToast(null)

    try {
      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser()

      if (authErr || !user) {
        setVerifying(false)
        setErrorToast(
          'Não foi possível identificar seu usuário. Faça login novamente.',
        )
        window.setTimeout(() => setErrorToast(null), 7000)
        return
      }

      setCurrentUserId(user.id)
      const result = await verifyEvolutionInstance(user.id)
      setVerifyResult(result)
    } finally {
      setVerifying(false)
    }
  }, [verifying])

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {successToast ? (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 shadow-sm ring-1 ring-emerald-100"
          >
            {successToast}
          </div>
        ) : null}
        {errorToast ? (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900 shadow-sm ring-1 ring-rose-100"
          >
            {errorToast}
          </div>
        ) : null}
        {infoToast ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm font-medium text-brand-800 shadow-sm ring-1 ring-brand-100"
          >
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
              aria-hidden
            />
            {infoToast}
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="text-lg font-semibold tracking-tight text-zinc-900">
          WhatsApp (Evolution API)
        </h3>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600">
          Pare o seu número na Evolution: é ele que usamos na Agenda, no CRM e
          nas campanhas com mídia.
        </p>
      </div>

      <div className="max-w-2xl">
        <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600">
          <Radio className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
          Conexão
        </div>

        <div
          className={`mt-2 flex items-center gap-3 rounded-xl border px-4 py-3 ${
            whatsappConnected
              ? 'border-emerald-200 bg-emerald-50/80'
              : 'border-zinc-200 bg-zinc-50/80'
          }`}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            {whatsappConnected ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/40 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-200" />
              </>
            ) : (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400/50 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-rose-200" />
              </>
            )}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-800">
              {whatsappConnected ? 'Conectado' : 'Desconectado'}
            </p>
            {whatsappConnected && whatsappPhone ? (
              <p className="mt-0.5 truncate text-xs font-medium text-emerald-800">
                {whatsappPhone}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-zinc-500">
                {whatsappConnected
                  ? 'Sessão ativa na Evolution API.'
                  : 'Nenhum aparelho pareado no momento.'}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void handleSyncWebhook()}
            disabled={webhookSyncing}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            title="Registra na Evolution a URL do webhook (MESSAGES_UPSERT)."
          >
            <RefreshCcw
              className={`h-4 w-4 ${webhookSyncing ? 'animate-spin' : ''}`}
              aria-hidden
            />
            {webhookSyncing ? 'Sincronizando…' : 'Sincronizar Webhook'}
          </button>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 text-xs text-zinc-600">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <Stethoscope className="h-3.5 w-3.5" aria-hidden />
              Status de Conexão
            </div>

            <dl className="space-y-1.5">
              <div className="flex flex-col gap-0.5">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  Instância
                </dt>
                <dd className="break-all rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 ring-1 ring-zinc-200">
                  {previewInstanceName ?? 'Aguardando login…'}
                </dd>
              </div>

              <div className="flex flex-col gap-0.5">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  Evolution API
                </dt>
                <dd className="break-all rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 ring-1 ring-zinc-200">
                  {evolutionBaseUrl ?? 'VITE_EVOLUTION_URL ausente no .env.local'}
                </dd>
              </div>

              <div className="flex flex-col gap-0.5">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  Webhook (Supabase)
                </dt>
                <dd className="break-all rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 ring-1 ring-zinc-200">
                  {supabaseWebhookUrl ?? 'VITE_SUPABASE_URL ausente no .env.local'}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={verifying}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Stethoscope
                className={`h-3.5 w-3.5 ${verifying ? 'animate-pulse' : ''}`}
                aria-hidden
              />
              {verifying ? 'Testando…' : 'Testar Conexão Real'}
            </button>

            {verifyResult ? (
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                  verifyResult.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : verifyResult.exists === false
                      ? 'border-rose-200 bg-rose-50 text-rose-900'
                      : 'border-amber-200 bg-amber-50 text-amber-900'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold">
                  {verifyResult.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {verifyResult.exists === true
                    ? `Instância encontrada na Evolution${
                        verifyResult.state ? ` (${verifyResult.state})` : ''
                      }.`
                    : verifyResult.exists === false
                      ? 'Instância NÃO encontrada no motor da Evolution.'
                      : 'Não conseguimos auditar a Evolution agora.'}
                </div>

                {verifyResult.error ? (
                  <p className="mt-1 break-words">{verifyResult.error}</p>
                ) : null}

                {verifyResult.webhook ? (
                  <p className="mt-1 break-words">
                    Webhook atual:{' '}
                    <span className="font-mono">
                      {verifyResult.webhook.url ?? '—'}
                    </span>{' '}
                    (enabled={String(verifyResult.webhook.enabled ?? '?')},
                    base64={String(verifyResult.webhook.base64 ?? '?')})
                  </p>
                ) : null}

                {verifyResult.details.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {verifyResult.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-zinc-500">
                O teste confirma se a instância existe no motor da Evolution
                antes de sincronizar o webhook.
              </p>
            )}
          </div>

          {whatsappConnected ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setDisconnectHint(true)
                  window.setTimeout(() => setDisconnectHint(false), 4000)
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900 shadow-sm transition hover:border-rose-300 hover:bg-rose-100"
              >
                Desconectar aparelho
              </button>
              {disconnectHint ? (
                <p className="text-center text-xs text-zinc-500">
                  Em breve: encerramento da instância pela Evolution API.
                </p>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={openConnectFlow}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[0_12px_36px_rgba(106,0,184,0.35)] transition hover:from-brand-500 hover:to-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              <Smartphone className="h-4 w-4 opacity-90" aria-hidden />
              Conectar WhatsApp (QR Code)
            </button>
          )}
        </div>
      </div>

      {qrModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/65 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="evo-qr-modal-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Fechar"
            onClick={closeQrModal}
          />
          <div className="relative w-full max-w-sm rounded-2xl border border-zinc-200/90 bg-white p-8 text-center shadow-2xl ring-1 ring-zinc-100">
            <button
              type="button"
              onClick={closeQrModal}
              className="absolute right-3 top-3 rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Fechar"
            >
              <X className="h-5 w-5" />
            </button>

            {qrLoading ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 ring-1 ring-brand-100">
                  <div className="h-9 w-9 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
                </div>
                <h2
                  id="evo-qr-modal-title"
                  className="mt-5 text-lg font-semibold text-zinc-900"
                >
                  Conectar aparelho
                </h2>
                <p className="mt-2 text-sm text-zinc-600">Carregando QR Code…</p>
                <p className="mt-3 text-xs text-zinc-500">
                  Comunicando com a Evolution API. A conexão será detectada
                  automaticamente após a leitura.
                </p>
              </>
            ) : qrError ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-50 ring-1 ring-rose-100">
                  <QrCode className="h-9 w-9 text-rose-500" aria-hidden />
                </div>
                <h2
                  id="evo-qr-modal-title"
                  className="mt-5 text-lg font-semibold text-zinc-900"
                >
                  Não foi possível conectar
                </h2>
                <div
                  role="alert"
                  className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-left text-sm text-rose-900"
                >
                  {qrError}
                </div>
                <button
                  type="button"
                  onClick={closeQrModal}
                  className="mt-6 w-full rounded-xl border border-zinc-200 bg-white py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
                >
                  Fechar
                </button>
              </>
            ) : qrDataUrl ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600/10 to-emerald-500/10 ring-1 ring-brand-200/50">
                  <QrCode className="h-9 w-9 text-brand-600" aria-hidden />
                </div>
                <h2
                  id="evo-qr-modal-title"
                  className="mt-5 text-lg font-semibold text-zinc-900"
                >
                  Escaneie o QR Code
                </h2>
                <p className="mt-2 text-sm text-zinc-600">
                  No WhatsApp, use Dispositivos conectados e leia a imagem
                  abaixo.
                </p>
                <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-3 shadow-inner ring-1 ring-zinc-100">
                  <img
                    src={qrDataUrl}
                    alt="QR Code para conectar o WhatsApp"
                    className="mx-auto h-auto max-h-64 w-full max-w-[240px] object-contain"
                  />
                </div>
                <button
                  type="button"
                  onClick={closeQrModal}
                  className="mt-6 w-full rounded-xl border border-zinc-200 bg-white py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
                >
                  Fechar
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
