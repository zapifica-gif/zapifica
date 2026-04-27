// ============================================================================
// Superadmin: criar novo cliente (tenant) sem deslogar o admin.
//
// Entrada JSON:
//   { email, password, company_name, company_logo_url }
//
// Regras:
// - verify_jwt = true (config.toml)
// - Só superadmin pode chamar (checado via user_profiles.role)
// - Usa SERVICE_ROLE para criar user + atualizar user_profiles
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization')?.trim() ?? ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return jsonResponse({ error: 'Server misconfigured' }, 500)
  }

  const token = bearer(req)
  if (!token) {
    return jsonResponse({ error: 'Missing bearer token' }, 401)
  }

  // Autentica caller via JWT (anon key) e checa role=superadmin via service role
  const supabaseAuth = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const {
    data: { user },
    error: userErr,
  } = await supabaseAuth.auth.getUser()
  if (userErr || !user) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: callerProfile, error: profErr } = await admin
    .from('user_profiles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (profErr) {
    return jsonResponse({ error: profErr.message }, 500)
  }
  if ((callerProfile as { role?: string } | null)?.role !== 'superadmin') {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const b = asRecord(body) ?? {}
  const email = str(b.email).toLowerCase()
  const password = str(b.password)
  const companyName = str(b.company_name)
  const companyLogoUrl = str(b.company_logo_url)

  if (!email || !password) {
    return jsonResponse({ error: 'email e password são obrigatórios' }, 400)
  }

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (created.error || !created.data?.user) {
    return jsonResponse(
      { error: created.error?.message ?? 'Falha ao criar usuário' },
      500,
    )
  }

  const newUid = created.data.user.id

  const { error: upErr } = await admin
    .from('user_profiles')
    .update({
      company_name: companyName || null,
      company_logo_url: companyLogoUrl || null,
      role: 'client',
    })
    .eq('user_id', newUid)

  if (upErr) {
    return jsonResponse(
      { error: `Usuário criado, mas falha ao atualizar perfil: ${upErr.message}`, user_id: newUid },
      500,
    )
  }

  return jsonResponse({ ok: true, user_id: newUid })
})

