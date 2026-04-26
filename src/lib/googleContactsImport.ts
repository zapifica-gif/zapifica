/**
 * Google People API (contatos) após OAuth com scope contacts.readonly.
 * Requer o `provider_token` do Google na sessão Supabase, quando disponível.
 */

export type GoogleContactRow = { name: string; phone: string }

const PEOPLE_LIST =
  'https://people.googleapis.com/v1/people/me/connections?personFields=names%2CphoneNumbers&pageSize=1000'

/**
 * Tenta listar conexões do Google e devolve nome + 1 telefone canônico por pessoa
 * (normalizado a dígitos; verificação mínima de tamanho).
 */
export async function fetchGoogleContacts(
  accessToken: string,
): Promise<GoogleContactRow[]> {
  const res = await fetch(PEOPLE_LIST, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(
      `Google People API: HTTP ${res.status} — ${t.slice(0, 200)}`,
    )
  }
  const json = (await res.json()) as {
    connections?: Array<{
      names?: { displayName?: string; unstructuredName?: string }[]
      phoneNumbers?: { value?: string; canonicalForm?: string }[]
    }>
  }
  const out: GoogleContactRow[] = []
  for (const c of json.connections ?? []) {
    const name =
      c.names?.[0]?.displayName?.trim() ||
      c.names?.[0]?.unstructuredName?.trim() ||
      'Sem nome'
    const ph = c.phoneNumbers?.[0]
    const raw = ph?.canonicalForm?.trim() || ph?.value?.trim() || ''
    if (!raw) continue
    const d = raw.replace(/\D/g, '')
    if (d.length < 10) continue
    const phone = d.startsWith('55') && d.length >= 12 ? d : d.length === 10 || d.length === 11 ? `55${d}` : d
    out.push({ name, phone })
  }
  return out
}

/**
 * Tenta obter o access token do Google a partir da sessão atual do Supabase.
 * Disponível logo após `signInWithOAuth` com provider `google` (não após refresh em todos os ambientes).
 */
export function getGoogleProviderToken(session: {
  provider_token?: string | null
} | null): string | null {
  const t = session?.provider_token
  if (t && t.length > 0) return t
  return null
}
