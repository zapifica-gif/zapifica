/**
 * Cliente HTTP para Evolution API (instância + QR Code + envio).
 * Variáveis no browser: VITE_EVOLUTION_URL e VITE_EVOLUTION_GLOBAL_KEY.
 * No servidor (worker/Edge): passe `EvolutionHttpConfig` explicitamente.
 */

export type CreateInstanceQrResult = {
  dataUrl: string | null
  error: string | null
  instanceName?: string
}

export type ConnectionStatusResult = {
  connected: boolean
  state: string | null
  phone: string | null
  error: string | null
}

export type EvolutionHttpConfig = {
  baseUrl: string
  apiKey: string
}

export type SendEvolutionResult = {
  ok: boolean
  error: string | null
  /** `key.id` na resposta da Evolution, quando disponível */
  messageId: string | null
}

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '')
}

function evolutionConfigFromVite(): EvolutionHttpConfig | null {
  const baseUrl = trimBaseUrl(import.meta.env.VITE_EVOLUTION_URL?.trim() ?? '')
  const apiKey = import.meta.env.VITE_EVOLUTION_GLOBAL_KEY?.trim() ?? ''
  if (!baseUrl || !apiKey) return null
  return { baseUrl, apiKey }
}

function resolveConfig(
  explicit?: EvolutionHttpConfig | null,
): EvolutionHttpConfig | null {
  if (explicit?.baseUrl && explicit?.apiKey) {
    return { baseUrl: trimBaseUrl(explicit.baseUrl), apiKey: explicit.apiKey }
  }
  return evolutionConfigFromVite()
}

export function instanceNameFromUserId(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9-]/g, '_')
  return `zapifica_${safe}`.slice(0, 80)
}

/**
 * Monta a URL pública da nossa Edge Function que recebe eventos da Evolution.
 * Ex.: https://<ref>.supabase.co/functions/v1/evolution-whatsapp-webhook
 */
export function evolutionWebhookUrl(supabaseUrl: string): string {
  const base = supabaseUrl.replace(/\/+$/, '')
  return `${base}/functions/v1/evolution-whatsapp-webhook`
}

function evolutionWebhookUrlFromVite(): string | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
  if (!url) return null
  return evolutionWebhookUrl(url)
}

/** Eventos que queremos escutar — por enquanto, apenas mensagens recebidas. */
export const EVOLUTION_WEBHOOK_EVENTS = ['MESSAGES_UPSERT'] as const

/** URL da Evolution lida do .env (útil para o painel de status). */
export function getEvolutionBaseUrl(): string | null {
  return resolveConfig()?.baseUrl ?? null
}

/** URL pública do nosso webhook no Supabase (para mostrar na tela). */
export function getEvolutionWebhookUrl(): string | null {
  return evolutionWebhookUrlFromVite()
}

export type SetInstanceWebhookResult = {
  ok: boolean
  error: string | null
  status: number
  /** Caminho que efetivamente respondeu (`/webhook/set/...` ou `/v1/webhook/set/...`). */
  pathTried: string | null
  /** Resposta crua da Evolution (útil para diagnóstico). */
  response: unknown
}

/**
 * Registra (ou atualiza) o webhook de uma instância existente na Evolution.
 *
 * O motor é caprichoso: dependendo da versão, ele aceita o payload aninhado em
 * `{ webhook: {...} }`, ou achatado, ou em paths diferentes. Para sobreviver a
 * todas as variações conhecidas, esta função tenta uma combinação cruzada de:
 *
 *   • Endpoints (em ordem):
 *       1. `POST /webhook/set/{instance}`
 *       2. `POST /v1/webhook/set/{instance}`              (deploys antigos)
 *       3. `POST /instance/setWebhook/{instance}`         (fork legacy)
 *       4. `POST /v1/instance/setWebhook/{instance}`
 *
 *   • Formatos: payload **aninhado** (`{ webhook: {...} }`) e **achatado**.
 *
 * E manda TODAS as variações possíveis de chave de mídia ao mesmo tempo:
 * `base64`, `webhookBase64`, `base64Mime`, `webhookBase64Mime` — a Evolution
 * ignora as que não conhece e aciona a que reconhecer.
 *
 * Sempre loga no console do navegador o que está sendo enviado e o que cada
 * tentativa devolveu, facilitando o diagnóstico ao vivo.
 */
export async function setInstanceWebhook(
  cfg: EvolutionHttpConfig,
  instanceName: string,
  webhookTargetUrl: string,
  events: readonly string[] = EVOLUTION_WEBHOOK_EVENTS,
): Promise<SetInstanceWebhookResult> {
  // Chaves agressivas de mídia: mandamos todas para cobrir qualquer versão.
  const mediaFlags = {
    base64: true,
    webhookBase64: true,
    base64Mime: true,
    webhookBase64Mime: true,
  } as const

  console.log('[Zapifica] Enviando chaves de mídia:', {
    base64: true,
    webhookBase64: true,
    base64Mime: true,
    webhookBase64Mime: true,
  })

  const flatPayload = {
    enabled: true,
    url: webhookTargetUrl,
    webhookByEvents: false,
    ...mediaFlags,
    events: [...events],
  }
  const wrappedPayload = { webhook: { ...flatPayload } }

  const safeInstance = encodeURIComponent(instanceName)
  const candidatePaths = [
    `/webhook/set/${safeInstance}`,
    `/v1/webhook/set/${safeInstance}`,
    // Forks/legacies que usam o caminho de instância:
    `/instance/setWebhook/${safeInstance}`,
    `/v1/instance/setWebhook/${safeInstance}`,
  ] as const

  type Attempt = {
    path: string
    payloadShape: 'wrapped' | 'flat'
    payload: unknown
  }

  const attempts: Attempt[] = candidatePaths.flatMap((path) => [
    { path, payloadShape: 'wrapped', payload: wrappedPayload },
    { path, payloadShape: 'flat', payload: flatPayload },
  ])

  let lastFailure: {
    path: string
    payloadShape: Attempt['payloadShape']
    status: number
    data: unknown
  } | null = null

  for (const attempt of attempts) {
    const res = await evolutionFetch(cfg, attempt.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attempt.payload),
    })

    console.log('[Zapifica][setInstanceWebhook] tentativa', {
      instance: instanceName,
      path: attempt.path,
      payloadShape: attempt.payloadShape,
      status: res.status,
      ok: res.ok,
      response: res.data,
    })

    if (res.ok) {
      console.log('[Zapifica][setInstanceWebhook] sucesso', {
        instance: instanceName,
        path: attempt.path,
        payloadShape: attempt.payloadShape,
        webhookUrl: webhookTargetUrl,
        mediaFlags,
      })
      return {
        ok: true,
        error: null,
        status: res.status,
        pathTried: attempt.path,
        response: res.data,
      }
    }

    lastFailure = {
      path: attempt.path,
      payloadShape: attempt.payloadShape,
      status: res.status,
      data: res.data,
    }

    // 401/403 (autenticação) não vai melhorar mudando path/forma — sai já.
    if (res.status === 401 || res.status === 403) {
      break
    }
  }

  if (!lastFailure) {
    return {
      ok: false,
      error: 'Nenhuma resposta válida da Evolution API.',
      status: 0,
      pathTried: null,
      response: null,
    }
  }

  const baseError = formatHttpError(lastFailure.status, lastFailure.data)
  let error = baseError
  if (lastFailure.status === 404) {
    error = `Instância "${instanceName}" não encontrada na Evolution (HTTP 404). Verifique se o WhatsApp já foi pareado.`
  } else if (lastFailure.status === 401 || lastFailure.status === 403) {
    error = `Evolution recusou a chamada (HTTP ${lastFailure.status}). Confirme VITE_EVOLUTION_GLOBAL_KEY.`
  }

  console.warn('[Zapifica][setInstanceWebhook] falhou', {
    instance: instanceName,
    lastPath: lastFailure.path,
    payloadShape: lastFailure.payloadShape,
    status: lastFailure.status,
    response: lastFailure.data,
    resolvedError: error,
  })

  return {
    ok: false,
    error,
    status: lastFailure.status,
    pathTried: lastFailure.path,
    response: lastFailure.data,
  }
}

export type SyncWebhookResult = {
  ok: boolean
  error: string | null
  /** URL que o webhook passou a apontar (útil pra mostrar no toast). */
  webhookUrl: string | null
  instanceName: string | null
  /** Caminho que respondeu na Evolution (`/webhook/set/...` ou `/v1/...`). */
  pathTried: string | null
  /** Resposta crua da Evolution para diagnóstico. */
  response: unknown
  /** Status HTTP da última tentativa. */
  status: number
}

/**
 * Atalho pra ser usado no navegador: pega URL da Evolution, Global Key e URL
 * do Supabase a partir das variáveis VITE_* e aplica o webhook na instância
 * do usuário logado (`zapifica_<userId>`).
 */
export async function syncWebhookForCurrentInstance(
  userId: string,
): Promise<SyncWebhookResult> {
  const cfg = resolveConfig()
  if (!cfg) {
    return {
      ok: false,
      error:
        'Configure VITE_EVOLUTION_URL e VITE_EVOLUTION_GLOBAL_KEY no arquivo .env.local.',
      webhookUrl: null,
      instanceName: null,
      pathTried: null,
      response: null,
      status: 0,
    }
  }

  const webhookTargetUrl = evolutionWebhookUrlFromVite()
  if (!webhookTargetUrl) {
    return {
      ok: false,
      error:
        'VITE_SUPABASE_URL ausente. Não consegui montar a URL do webhook do Supabase.',
      webhookUrl: null,
      instanceName: null,
      pathTried: null,
      response: null,
      status: 0,
    }
  }

  const instanceName = instanceNameFromUserId(userId)

  try {
    const result = await setInstanceWebhook(cfg, instanceName, webhookTargetUrl)
    return {
      ok: result.ok,
      error: result.error,
      webhookUrl: webhookTargetUrl,
      instanceName,
      pathTried: result.pathTried,
      response: result.response,
      status: result.status,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'Failed to fetch') {
      return {
        ok: false,
        error:
          'Não foi possível contatar a Evolution API (rede ou CORS). Verifique VITE_EVOLUTION_URL.',
        webhookUrl: webhookTargetUrl,
        instanceName,
        pathTried: null,
        response: null,
        status: 0,
      }
    }
    return {
      ok: false,
      error: msg || 'Erro inesperado ao sincronizar o webhook.',
      webhookUrl: webhookTargetUrl,
      instanceName,
      pathTried: null,
      response: null,
      status: 0,
    }
  }
}

// ---------------------------------------------------------------------------
// Verificação real da instância (auditoria)
// ---------------------------------------------------------------------------

export type EvolutionWebhookSummary = {
  url: string | null
  enabled: boolean | null
  base64: boolean | null
  events: string[] | null
  pathTried: string | null
  raw: unknown
}

export type VerifyInstanceResult = {
  /** Tudo encontrado e instância existe na Evolution. */
  ok: boolean
  /** O nome que o sistema está tentando usar (zapifica_<userId>). */
  instanceName: string
  /** URL da Evolution que está sendo consultada (do `.env`). */
  baseUrl: string | null
  /** URL do webhook que esperamos que esteja registrada. */
  expectedWebhookUrl: string | null
  /** True quando a instância existe no motor (fetchInstances ou connectionState). */
  exists: boolean | null
  /** Estado bruto da conexão (open/close/connecting/qr...). */
  state: string | null
  /** Conveniência: state em ('open','connected','ready','online'). */
  connected: boolean
  /** Telefone associado, quando a Evolution devolve. */
  phone: string | null
  /** Webhook configurado hoje na instância (se conseguimos ler). */
  webhook: EvolutionWebhookSummary | null
  /** Mensagem de erro consolidada quando algo falha. */
  error: string | null
  /** Lista de notas/avisos para diagnóstico no painel. */
  details: string[]
}

function pickWebhookFields(payload: unknown): EvolutionWebhookSummary | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const node =
    root.webhook && typeof root.webhook === 'object'
      ? (root.webhook as Record<string, unknown>)
      : root

  const url = typeof node.url === 'string' ? node.url : null
  const enabled = typeof node.enabled === 'boolean' ? node.enabled : null
  // Considera base64 ATIVO se QUALQUER uma das chaves conhecidas estiver true.
  const candidateKeys = [
    'webhookBase64',
    'base64',
    'webhookBase64Mime',
    'base64Mime',
  ] as const
  const truthyMatches = candidateKeys.filter(
    (k) => node[k] === true,
  ) as string[]
  const explicitlyFalse = candidateKeys.some((k) => node[k] === false)
  const base64: boolean | null =
    truthyMatches.length > 0 ? true : explicitlyFalse ? false : null
  const events = Array.isArray(node.events)
    ? (node.events.filter((e) => typeof e === 'string') as string[])
    : null

  return {
    url,
    enabled,
    base64,
    events,
    pathTried: null,
    raw: payload,
  }
}

async function evolutionFetchWithFallback(
  cfg: EvolutionHttpConfig,
  paths: readonly string[],
  init: RequestInit & { parseJson?: boolean } = {},
): Promise<{
  ok: boolean
  status: number
  data: unknown
  pathTried: string | null
}> {
  let lastResult: { ok: boolean; status: number; data: unknown } | null = null
  let lastPath: string | null = null

  for (const path of paths) {
    const res = await evolutionFetch(cfg, path, init)
    lastResult = res
    lastPath = path
    if (res.ok) {
      return { ...res, pathTried: path }
    }
    if (res.status !== 404) {
      // 401/403/500 não vão melhorar mudando o prefixo; sai já.
      return { ...res, pathTried: path }
    }
  }

  return lastResult
    ? { ...lastResult, pathTried: lastPath }
    : { ok: false, status: 0, data: null, pathTried: null }
}

/**
 * Faz uma auditoria real da instância: verifica se ela existe na Evolution,
 * qual o estado da conexão e qual webhook está registrado hoje. Útil para o
 * botão "Testar Conexão Real" do painel de status.
 */
export async function verifyEvolutionInstance(
  userId: string,
): Promise<VerifyInstanceResult> {
  const baseUrl = getEvolutionBaseUrl()
  const expectedWebhookUrl = evolutionWebhookUrlFromVite()
  const instanceName = instanceNameFromUserId(userId)
  const details: string[] = []

  const cfg = resolveConfig()
  if (!cfg) {
    return {
      ok: false,
      instanceName,
      baseUrl,
      expectedWebhookUrl,
      exists: null,
      state: null,
      connected: false,
      phone: null,
      webhook: null,
      error:
        'Configure VITE_EVOLUTION_URL e VITE_EVOLUTION_GLOBAL_KEY no arquivo .env.local.',
      details,
    }
  }

  let exists: boolean | null = null
  let state: string | null = null
  let phone: string | null = null
  let webhook: EvolutionWebhookSummary | null = null
  const errors: string[] = []

  try {
    const fetchInstances = await evolutionFetchWithFallback(
      cfg,
      ['/instance/fetchInstances', '/v1/instance/fetchInstances'],
      { method: 'GET' },
    )

    console.log('[Zapifica][verifyEvolutionInstance] fetchInstances', {
      pathTried: fetchInstances.pathTried,
      status: fetchInstances.status,
      sample: Array.isArray(fetchInstances.data)
        ? `${(fetchInstances.data as unknown[]).length} instância(s)`
        : fetchInstances.data,
    })

    if (fetchInstances.ok && Array.isArray(fetchInstances.data)) {
      const list = fetchInstances.data as unknown[]
      exists = list.some((entry) => {
        if (!entry || typeof entry !== 'object') return false
        const root = entry as Record<string, unknown>
        if (root.name === instanceName) return true
        const inst = root.instance
        if (inst && typeof inst === 'object') {
          const o = inst as Record<string, unknown>
          if (o.instanceName === instanceName || o.name === instanceName) {
            return true
          }
        }
        return false
      })

      if (!exists) {
        details.push(
          `A instância ${instanceName} não apareceu em /instance/fetchInstances. Confira se ela foi criada no motor.`,
        )
      }
    } else if (!fetchInstances.ok) {
      errors.push(
        `fetchInstances HTTP ${fetchInstances.status}: ${formatHttpError(
          fetchInstances.status,
          fetchInstances.data,
        )}`,
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push(`fetchInstances falhou: ${msg}`)
  }

  try {
    const conn = await evolutionFetchWithFallback(
      cfg,
      [
        `/instance/connectionState/${encodeURIComponent(instanceName)}`,
        `/v1/instance/connectionState/${encodeURIComponent(instanceName)}`,
      ],
      { method: 'GET' },
    )

    console.log('[Zapifica][verifyEvolutionInstance] connectionState', {
      pathTried: conn.pathTried,
      status: conn.status,
      response: conn.data,
    })

    if (conn.ok) {
      exists = exists ?? true
      const data = conn.data as Record<string, unknown> | null
      const inst = data?.instance as Record<string, unknown> | undefined
      const stateRaw = inst?.state ?? data?.state
      state = typeof stateRaw === 'string' ? stateRaw : null
      phone = pickPhoneFromPayload(conn.data)
    } else if (conn.status === 404) {
      exists = false
      details.push(
        `connectionState devolveu 404 — instância "${instanceName}" não existe no motor.`,
      )
    } else if (conn.status > 0) {
      errors.push(
        `connectionState HTTP ${conn.status}: ${formatHttpError(conn.status, conn.data)}`,
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push(`connectionState falhou: ${msg}`)
  }

  try {
    const find = await evolutionFetchWithFallback(
      cfg,
      [
        `/webhook/find/${encodeURIComponent(instanceName)}`,
        `/v1/webhook/find/${encodeURIComponent(instanceName)}`,
      ],
      { method: 'GET' },
    )

    console.log('[Zapifica][verifyEvolutionInstance] webhook/find', {
      pathTried: find.pathTried,
      status: find.status,
      response: find.data,
    })

    if (find.ok) {
      const summary = pickWebhookFields(find.data)
      if (summary) {
        webhook = { ...summary, pathTried: find.pathTried }
        if (!webhook.enabled) {
          details.push('Webhook está desativado (enabled=false) na Evolution.')
        }
        if (webhook.base64 === false) {
          details.push(
            'webhookBase64 = false — mídias não vão chegar ao Supabase. Clique em Sincronizar Webhook.',
          )
        }
        if (
          webhook.url &&
          expectedWebhookUrl &&
          webhook.url.replace(/\/+$/, '') !==
            expectedWebhookUrl.replace(/\/+$/, '')
        ) {
          details.push(
            `Webhook aponta para ${webhook.url}, mas o esperado é ${expectedWebhookUrl}. Sincronize de novo.`,
          )
        }
      }
    } else if (find.status === 404) {
      details.push('A instância existe, mas ainda não tem webhook registrado.')
    } else if (find.status > 0) {
      errors.push(
        `webhook/find HTTP ${find.status}: ${formatHttpError(find.status, find.data)}`,
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push(`webhook/find falhou: ${msg}`)
  }

  const connected =
    typeof state === 'string'
      ? ['open', 'connected', 'ready', 'online'].includes(state.toLowerCase())
      : false

  const ok = exists === true && errors.length === 0
  const error = errors.length ? errors.join(' · ') : null

  return {
    ok,
    instanceName,
    baseUrl,
    expectedWebhookUrl,
    exists,
    state,
    connected,
    phone,
    webhook,
    error,
    details,
  }
}

/**
 * Normaliza destino para Evolution: número (apenas dígitos) ou JID de grupo (@g.us).
 */
export function normalizeEvolutionRecipient(
  raw: string,
): { recipient: string } | { error: string } {
  const t = raw.trim()
  if (!t) {
    return { error: 'Destinatário vazio.' }
  }
  if (t.includes('@g.us')) {
    return { recipient: t }
  }
  if (t.includes('@s.whatsapp.net')) {
    const before = t.split('@')[0] ?? ''
    const digits = before.replace(/\D/g, '')
    if (digits.length < 10) {
      return { error: 'JID individual inválido.' }
    }
    return { recipient: digits }
  }
  if (t.includes('@') && !/^\d/.test(t)) {
    return { recipient: t }
  }
  const digits = t.replace(/\D/g, '')
  if (!digits || digits.length < 10) {
    return {
      error:
        'Informe um número válido com DDD e código do país (ex.: 5548999999999) ou um ID de grupo (@g.us).',
    }
  }
  return { recipient: digits }
}

function formatPhoneFromApi(raw: string): string {
  const part = raw.split('@')[0] ?? raw
  const digits = part.replace(/\D/g, '')
  if (digits.length < 10) return raw.trim()
  if (digits.length <= 11) {
    const d = digits
    return d.length === 11
      ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
      : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  }
  return `+${digits}`
}

function pickPhoneFromPayload(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  const inst = root.instance
  const bag =
    inst && typeof inst === 'object' ? (inst as Record<string, unknown>) : root

  const keys = ['number', 'phoneNumber', 'owner', 'wid', 'user', 'phone']
  for (const key of keys) {
    const v = bag[key]
    if (typeof v === 'string' && v.length >= 8) {
      return formatPhoneFromApi(v)
    }
  }
  return null
}

function formatHttpError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const msg = b.message
    if (Array.isArray(msg) && msg.length) {
      return String(msg[0])
    }
    if (typeof b.error === 'string') return b.error
    const resp = b.response as Record<string, unknown> | undefined
    if (resp && Array.isArray(resp.message) && resp.message.length) {
      return String(resp.message[0])
    }
  }
  return `Erro HTTP ${status} na Evolution API.`
}

export function extractEvolutionMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const key = o.key
  if (key && typeof key === 'object') {
    const id = (key as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

async function evolutionFetch(
  cfg: EvolutionHttpConfig,
  path: string,
  init: RequestInit & { parseJson?: boolean } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const { parseJson = true, ...rest } = init
  const res = await fetch(url, {
    ...rest,
    headers: {
      apikey: cfg.apiKey,
      Accept: 'application/json',
      ...(rest.headers as Record<string, string>),
    },
  })

  let data: unknown = null
  if (parseJson) {
    const text = await res.text()
    if (text) {
      try {
        data = JSON.parse(text) as unknown
      } catch {
        data = { raw: text }
      }
    }
  }

  return { ok: res.ok, status: res.status, data }
}

function normalizeQrDataUrl(value: string): string {
  const t = value.trim()
  if (t.startsWith('data:image')) return t
  return `data:image/png;base64,${t}`
}

function extractQrFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const o = payload as Record<string, unknown>

  const direct =
    typeof o.base64 === 'string'
      ? o.base64
      : typeof o.code === 'string'
        ? o.code
        : null

  if (direct && direct.length > 80) {
    return normalizeQrDataUrl(direct)
  }

  const qr = o.qrcode
  if (qr && typeof qr === 'object') {
    const q = qr as Record<string, unknown>
    const b =
      typeof q.base64 === 'string'
        ? q.base64
        : typeof q.code === 'string'
          ? q.code
          : null
    if (b && b.length > 80) return normalizeQrDataUrl(b)
  }

  if (typeof qr === 'string' && qr.length > 80) {
    return normalizeQrDataUrl(qr)
  }

  const inst = o.instance
  if (inst && typeof inst === 'object') {
    return extractQrFromPayload(inst)
  }

  return null
}

export async function checkConnectionStatus(
  userId: string,
): Promise<ConnectionStatusResult> {
  const cfg = resolveConfig()
  if (!cfg) {
    return {
      connected: false,
      state: null,
      phone: null,
      error: null,
    }
  }

  const instanceName = instanceNameFromUserId(userId)

  try {
    const res = await evolutionFetch(
      cfg,
      `/instance/connectionState/${encodeURIComponent(instanceName)}`,
      { method: 'GET' },
    )

    if (res.status === 404) {
      return {
        connected: false,
        state: null,
        phone: null,
        error: null,
      }
    }

    if (!res.ok) {
      return {
        connected: false,
        state: null,
        phone: null,
        error: formatHttpError(res.status, res.data),
      }
    }

    const data = res.data as Record<string, unknown>
    const inst = data.instance as Record<string, unknown> | undefined
    const stateRaw = inst?.state
    const state =
      typeof stateRaw === 'string' ? stateRaw.toLowerCase().trim() : null

    const connected =
      state === 'open' ||
      state === 'connected' ||
      state === 'ready' ||
      state === 'online'

    const phone = pickPhoneFromPayload(res.data)

    return {
      connected,
      state: typeof stateRaw === 'string' ? stateRaw : null,
      phone,
      error: null,
    }
  } catch {
    return {
      connected: false,
      state: null,
      phone: null,
      error: null,
    }
  }
}

export async function sendTextMessage(
  userId: string,
  number: string,
  text: string,
  httpConfig?: EvolutionHttpConfig | null,
): Promise<SendEvolutionResult> {
  return sendTextMessageWithConfig(userId, number, text, resolveConfig(httpConfig))
}

export async function sendTextMessageWithConfig(
  userId: string,
  number: string,
  text: string,
  cfg: EvolutionHttpConfig | null,
): Promise<SendEvolutionResult> {
  if (!cfg) {
    return {
      ok: false,
      error:
        'Configure VITE_EVOLUTION_URL e VITE_EVOLUTION_GLOBAL_KEY (ou credenciais no worker).',
      messageId: null,
    }
  }

  const normalized = normalizeEvolutionRecipient(number)
  if ('error' in normalized) {
    return { ok: false, error: normalized.error, messageId: null }
  }

  const trimmedText = text.trim()
  if (!trimmedText) {
    return { ok: false, error: 'Digite a mensagem a ser enviada.', messageId: null }
  }

  const instanceName = instanceNameFromUserId(userId)

  try {
    const res = await evolutionFetch(
      cfg,
      `/message/sendText/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: normalized.recipient,
          text: trimmedText,
        }),
      },
    )

    if (!res.ok) {
      return {
        ok: false,
        error: formatHttpError(res.status, res.data),
        messageId: null,
      }
    }

    return {
      ok: true,
      error: null,
      messageId: extractEvolutionMessageId(res.data),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'Failed to fetch') {
      return {
        ok: false,
        error:
          'Não foi possível contatar a Evolution API (rede ou CORS). Verifique a URL.',
        messageId: null,
      }
    }
    return {
      ok: false,
      error: msg || 'Erro inesperado ao enviar a mensagem.',
      messageId: null,
    }
  }
}

/**
 * Áudio (URL ou base64) — endpoint de voz/nota da Evolution.
 */
export async function sendAudioMessageWithConfig(
  userId: string,
  recipient: string,
  audio: string,
  cfg: EvolutionHttpConfig | null,
): Promise<SendEvolutionResult> {
  if (!cfg) {
    return {
      ok: false,
      error: 'Credenciais da Evolution não configuradas.',
      messageId: null,
    }
  }
  const normalized = normalizeEvolutionRecipient(recipient)
  if ('error' in normalized) {
    return { ok: false, error: normalized.error, messageId: null }
  }
  const trimmed = audio.trim()
  if (!trimmed) {
    return { ok: false, error: 'Informe a URL ou o base64 do áudio.', messageId: null }
  }

  const instanceName = instanceNameFromUserId(userId)

  try {
    const res = await evolutionFetch(
      cfg,
      `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: normalized.recipient,
          audio: trimmed,
        }),
      },
    )

    if (!res.ok) {
      return {
        ok: false,
        error: formatHttpError(res.status, res.data),
        messageId: null,
      }
    }

    return {
      ok: true,
      error: null,
      messageId: extractEvolutionMessageId(res.data),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: msg || 'Erro ao enviar áudio.',
      messageId: null,
    }
  }
}

/**
 * Imagem (ou mídia) — URL ou base64.
 */
export async function sendImageMessageWithConfig(
  userId: string,
  recipient: string,
  media: string,
  caption: string,
  cfg: EvolutionHttpConfig | null,
): Promise<SendEvolutionResult> {
  if (!cfg) {
    return {
      ok: false,
      error: 'Credenciais da Evolution não configuradas.',
      messageId: null,
    }
  }
  const normalized = normalizeEvolutionRecipient(recipient)
  if ('error' in normalized) {
    return { ok: false, error: normalized.error, messageId: null }
  }
  const trimmed = media.trim()
  if (!trimmed) {
    return { ok: false, error: 'Informe a URL ou o base64 da imagem.', messageId: null }
  }

  const instanceName = instanceNameFromUserId(userId)
  const captionTrim = caption.trim()
  const isData = trimmed.startsWith('data:')
  const mimetype = isData
    ? trimmed.split(';')[0]?.replace('data:', '') || 'image/png'
    : 'image/jpeg'
  const fileName =
    mimetype.includes('png') ? 'imagem.png' : mimetype.includes('webp') ? 'imagem.webp' : 'imagem.jpg'

  try {
    const res = await evolutionFetch(
      cfg,
      `/message/sendMedia/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: normalized.recipient,
          mediatype: 'image',
          mimetype,
          caption: captionTrim || ' ',
          media: trimmed,
          fileName,
        }),
      },
    )

    if (!res.ok) {
      return {
        ok: false,
        error: formatHttpError(res.status, res.data),
        messageId: null,
      }
    }

    return {
      ok: true,
      error: null,
      messageId: extractEvolutionMessageId(res.data),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: msg || 'Erro ao enviar imagem.',
      messageId: null,
    }
  }
}

export async function createInstanceAndGetQr(
  userId: string,
): Promise<CreateInstanceQrResult> {
  const cfg = resolveConfig()
  if (!cfg) {
    return {
      dataUrl: null,
      error:
        'Configure VITE_EVOLUTION_URL e VITE_EVOLUTION_GLOBAL_KEY no arquivo .env.local.',
    }
  }

  const instanceName = instanceNameFromUserId(userId)

  try {
    const tryConnect = async (): Promise<string | null> => {
      const connect = await evolutionFetch(
        cfg,
        `/instance/connect/${encodeURIComponent(instanceName)}`,
        { method: 'GET' },
      )
      if (!connect.ok) {
        return null
      }
      return extractQrFromPayload(connect.data)
    }

    const webhookTargetUrl = evolutionWebhookUrlFromVite()

    const createPayload: Record<string, unknown> = {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    }
    if (webhookTargetUrl) {
      createPayload.webhook = {
        enabled: true,
        url: webhookTargetUrl,
        webhookByEvents: false,
        // Manda TODAS as variações conhecidas de chave de mídia.
        base64: true,
        webhookBase64: true,
        base64Mime: true,
        webhookBase64Mime: true,
        events: [...EVOLUTION_WEBHOOK_EVENTS],
      }
    }

    const create = await evolutionFetch(cfg, '/instance/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createPayload),
    })

    let qr = extractQrFromPayload(create.data)

    const bodyStr = JSON.stringify(create.data).toLowerCase()
    const duplicate =
      !create.ok &&
      (create.status === 403 ||
        create.status === 409 ||
        bodyStr.includes('already') ||
        bodyStr.includes('already in use') ||
        bodyStr.includes('já existe') ||
        bodyStr.includes('already exists'))

    if (!create.ok && !duplicate) {
      return {
        dataUrl: null,
        error: formatHttpError(create.status, create.data),
        instanceName,
      }
    }

    if (webhookTargetUrl) {
      try {
        await setInstanceWebhook(cfg, instanceName, webhookTargetUrl)
      } catch {
        // não bloqueia o fluxo do QR Code
      }
    }

    if (!qr) {
      await new Promise((r) => setTimeout(r, 1200))
      qr = await tryConnect()
    }

    if (!qr) {
      await new Promise((r) => setTimeout(r, 2000))
      qr = await tryConnect()
    }

    if (!qr) {
      return {
        dataUrl: null,
        error:
          'A instância foi criada, mas o QR Code ainda não está disponível. Aguarde alguns segundos e abra de novo.',
        instanceName,
      }
    }

    return { dataUrl: qr, error: null, instanceName }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'Failed to fetch') {
      return {
        dataUrl: null,
        error:
          'Não foi possível contatar a Evolution API (rede, URL ou bloqueio CORS). Verifique VITE_EVOLUTION_URL e as permissões do servidor.',
        instanceName,
      }
    }
    return {
      dataUrl: null,
      error: msg || 'Erro inesperado ao falar com a Evolution API.',
      instanceName,
    }
  }
}