/**
 * Worker local: lê a fila `scheduled_messages` e dispara pela Evolution API.
 *
 * Rode com:
 *   npm run worker          (loop infinito, tick a cada 30s)
 *   npm run worker -- once  (executa um único tick e sai)
 *
 * Precisa de uma variável `CHAVE_MESTRA_ZAPIFICA` no ambiente (= service_role
 * do Supabase novo) para fazer bypass de RLS, além das mesmas variáveis VITE_*
 * que o app usa. Ele carrega `.env.local` automaticamente (Node 20+).
 *
 * Este script é para TESTE LOCAL. Em produção, a Edge Function em
 * `supabase/functions/process-scheduled-messages` faz o mesmo trabalho e é
 * disparada por pg_cron (ver README ao final da minha resposta no chat).
 */

import {
  checkAndSendScheduledMessages,
  createSupabaseComChaveMestraZapifica,
} from '../src/services/worker'
import type { EvolutionHttpConfig } from '../src/services/evolution'

function envOrThrow(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) {
    throw new Error(
      `Variável ${key} ausente. Garanta que está no .env.local (ou exportada no terminal).`,
    )
  }
  return v
}

function loadConfig(): { supabaseUrl: string; evolution: EvolutionHttpConfig } {
  const supabaseUrl = envOrThrow('VITE_SUPABASE_URL')
  const evolution: EvolutionHttpConfig = {
    baseUrl: envOrThrow('VITE_EVOLUTION_URL'),
    apiKey: envOrThrow('VITE_EVOLUTION_GLOBAL_KEY'),
  }

  // O worker original lê de CHAVE_MESTRA_ZAPIFICA (mesmo nome da Edge Function).
  // Para reaproveitar seu .env.local, que tem SUPABASE_SERVICE_ROLE_KEY,
  // fazemos o bridge aqui se o nome canônico não estiver presente.
  if (!process.env.CHAVE_MESTRA_ZAPIFICA?.trim()) {
    const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
    if (!fallback) {
      throw new Error(
        'Defina CHAVE_MESTRA_ZAPIFICA ou SUPABASE_SERVICE_ROLE_KEY no .env.local.',
      )
    }
    process.env.CHAVE_MESTRA_ZAPIFICA = fallback
  }

  return { supabaseUrl, evolution }
}

async function tick(
  supabaseUrl: string,
  evolution: EvolutionHttpConfig,
): Promise<void> {
  const supabase = createSupabaseComChaveMestraZapifica(supabaseUrl)
  const summary = await checkAndSendScheduledMessages({ supabase, evolution })
  const stamp = new Date().toISOString()
  console.log(
    `[worker ${stamp}] processed=${summary.processed} skipped=${summary.skipped}`,
  )
}

async function main(): Promise<void> {
  const { supabaseUrl, evolution } = loadConfig()
  const mode = process.argv[2] === 'once' ? 'once' : 'loop'

  if (mode === 'once') {
    await tick(supabaseUrl, evolution)
    return
  }

  console.log('[worker] iniciando loop — tick a cada 30s. Ctrl+C para parar.')
  let running = true
  const stop = () => {
    running = false
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (running) {
    try {
      await tick(supabaseUrl, evolution)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[worker] erro no tick:', msg)
    }
    await new Promise((r) => setTimeout(r, 30_000))
  }

  console.log('[worker] encerrado.')
}

void main()
