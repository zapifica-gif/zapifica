/**
 * Registra o webhook da Edge Function `evolution-whatsapp-webhook` em uma ou
 * mais instâncias da Evolution API.
 *
 * Uso:
 *   npx tsx scripts/set-webhook.ts                 # aplica em TODAS as instâncias
 *   npx tsx scripts/set-webhook.ts <instance_name> # aplica apenas na instância
 *
 * Variáveis usadas do .env.local:
 *   VITE_SUPABASE_URL            (para montar a URL do webhook)
 *   VITE_EVOLUTION_URL           (base da Evolution API)
 *   VITE_EVOLUTION_GLOBAL_KEY    (apikey global no header)
 *
 * Opcional:
 *   EVOLUTION_WEBHOOK_URL        (sobrescreve a URL final do webhook, se quiser
 *                                 apontar para outro ambiente)
 */

import {
  EVOLUTION_WEBHOOK_EVENTS,
  evolutionWebhookUrl,
  setInstanceWebhook,
  type EvolutionHttpConfig,
} from '../src/services/evolution'

function envOrThrow(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) {
    throw new Error(
      `Variável ${key} ausente. Garanta que está no .env.local ou exportada no terminal.`,
    )
  }
  return v
}

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '')
}

type EvolutionInstanceSummary = {
  name: string
  connectionStatus: string | null
}

function extractInstanceName(entry: unknown): EvolutionInstanceSummary | null {
  if (!entry || typeof entry !== 'object') return null
  const root = entry as Record<string, unknown>
  // formato novo (v2): { name, connectionStatus, ... }
  if (typeof root.name === 'string' && root.name) {
    return {
      name: root.name,
      connectionStatus:
        typeof root.connectionStatus === 'string' ? root.connectionStatus : null,
    }
  }
  // formato aninhado: { instance: { instanceName | name, state, status } }
  const inst = root.instance
  if (inst && typeof inst === 'object') {
    const o = inst as Record<string, unknown>
    const name =
      (typeof o.instanceName === 'string' && o.instanceName) ||
      (typeof o.name === 'string' && o.name) ||
      ''
    if (name) {
      const status =
        (typeof o.connectionStatus === 'string' && o.connectionStatus) ||
        (typeof o.status === 'string' && o.status) ||
        (typeof o.state === 'string' && o.state) ||
        null
      return { name, connectionStatus: status }
    }
  }
  return null
}

async function fetchInstances(
  cfg: EvolutionHttpConfig,
): Promise<EvolutionInstanceSummary[]> {
  const url = `${cfg.baseUrl}/instance/fetchInstances`
  const res = await fetch(url, {
    method: 'GET',
    headers: { apikey: cfg.apiKey, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `Falha ao listar instâncias (HTTP ${res.status}). Resposta: ${text.slice(0, 300)}`,
    )
  }
  let data: unknown = null
  try {
    data = JSON.parse(text) as unknown
  } catch {
    throw new Error(`Resposta não-JSON do /instance/fetchInstances: ${text.slice(0, 300)}`)
  }
  const list = Array.isArray(data) ? data : []
  return list
    .map((e) => extractInstanceName(e))
    .filter((x): x is EvolutionInstanceSummary => Boolean(x))
}

async function main(): Promise<void> {
  const supabaseUrl = envOrThrow('VITE_SUPABASE_URL')
  const cfg: EvolutionHttpConfig = {
    baseUrl: trimBaseUrl(envOrThrow('VITE_EVOLUTION_URL')),
    apiKey: envOrThrow('VITE_EVOLUTION_GLOBAL_KEY'),
  }

  const webhookTargetUrl =
    process.env.EVOLUTION_WEBHOOK_URL?.trim() || evolutionWebhookUrl(supabaseUrl)

  const argInstance = process.argv[2]?.trim() || ''
  const targets: EvolutionInstanceSummary[] = []

  if (argInstance) {
    targets.push({ name: argInstance, connectionStatus: null })
  } else {
    console.log('[set-webhook] nenhum nome informado — listando instâncias...')
    const all = await fetchInstances(cfg)
    if (all.length === 0) {
      console.error(
        '[set-webhook] nenhuma instância encontrada na Evolution. Crie uma primeiro pelo app.',
      )
      process.exit(1)
    }
    targets.push(...all)
  }

  console.log(`[set-webhook] webhook alvo: ${webhookTargetUrl}`)
  console.log(
    `[set-webhook] eventos: ${EVOLUTION_WEBHOOK_EVENTS.join(', ')}`,
  )
  console.log(
    `[set-webhook] aplicando em ${targets.length} instância(s): ${targets
      .map((t) => t.name)
      .join(', ')}`,
  )

  let okCount = 0
  let failCount = 0
  for (const t of targets) {
    const result = await setInstanceWebhook(cfg, t.name, webhookTargetUrl)
    if (result.ok) {
      okCount++
      console.log(
        `  ok  → ${t.name}${t.connectionStatus ? ` (status: ${t.connectionStatus})` : ''}`,
      )
    } else {
      failCount++
      console.error(
        `  fail → ${t.name} (HTTP ${result.status}): ${result.error ?? 'erro desconhecido'}`,
      )
    }
  }

  console.log(`[set-webhook] concluído. sucesso=${okCount} falha=${failCount}`)
  if (failCount > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('[set-webhook] erro fatal:', msg)
  process.exit(1)
})
