/**
 * Importação de CSV para a base de contatos (`public.leads`):
 * colunas esperadas pelo modelo — nome, telefone, email, cargo, empresa, cidade, endereco, tag.
 * Telefone normalizado (DDI 55); merge por telefone com variantes BR (com/sem 9º dígito).
 */

export function normalizeCsvHeader(raw: string): string {
  return raw.replace(/["\r\n\uFEFF]/g, '').trim().toLowerCase()
}

export function cleanCsvCellValue(raw: string): string {
  let t = raw.replace(/["\r\n\uFEFF]/g, '').trim()
  t = t.replace(/^"+|"+$/g, '')
  return t.trim()
}

export function parseSimpleCsv(
  text: string,
): { headers: string[]; rows: Record<string, string>[] } {
  const cleaned = text.replace(/^\uFEFF/g, '')
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    const next = cleaned[i + 1]
    if (ch === '"' && inQuotes && next === '"') {
      current += '"'
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++
      lines.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.length) lines.push(current)
  if (lines.length === 0) return { headers: [], rows: [] }

  const splitCsvLine = (line: string): string[] => {
    const out: string[] = []
    let cell = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const next = line[i + 1]
      if (ch === '"' && q && next === '"') {
        cell += '"'
        i++
        continue
      }
      if (ch === '"') {
        q = !q
        continue
      }
      if (ch === ',' && !q) {
        out.push(cell)
        cell = ''
        continue
      }
      cell += ch
    }
    out.push(cell)
    return out
  }

  const firstLine = lines[0].replace(/^\uFEFF/, '')
  const rawHeaderCells = splitCsvLine(firstLine)
  const headers = rawHeaderCells.map((h) => normalizeCsvHeader(h))
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.replace(/^\uFEFF/, '').trim()) continue
    const values = splitCsvLine(raw)
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      if (!h) return
      obj[h] = cleanCsvCellValue(values[idx] ?? '')
    })
    rows.push(obj)
  }
  return { headers, rows }
}

export function findPhoneColumn(headers: string[]): string | null {
  const exact = new Set([
    'telefone',
    'phone',
    'whatsapp',
    'celular',
    'mobile',
    'telefone celular',
  ])
  for (const h of headers) {
    if (h && exact.has(h)) return h
  }
  const needIncludes = [
    'telefone celular',
    'telefone',
    'whatsapp',
    'celular',
    'mobile',
    'phone',
  ]
  for (const part of needIncludes) {
    const found = headers.find((h) => h && h.includes(part))
    if (found) return found
  }
  return null
}

export function findNameColumn(headers: string[]): string | null {
  const order = [
    'nome',
    'title',
    'name',
    'titulo',
    'nome_empresa',
    'displayname',
    'username',
  ]
  for (const c of order) {
    if (headers.includes(c)) return c
  }
  return headers.find((h) => h && h.length > 0) ?? null
}

/** Primeira coluna cujo cabeçalho normalizado coincide com algum alias (lista de sinônimos). */
export function findColumnByAliases(headers: string[], aliases: string[]): string | null {
  const normAliases = aliases.map((a) => normalizeCsvHeader(a)).filter(Boolean)
  const headerSet = new Set(headers.filter(Boolean))
  for (const key of normAliases) {
    if (headerSet.has(key)) return key
  }
  for (const h of headers) {
    if (!h) continue
    for (const key of normAliases) {
      if (key && (h === key || h.includes(key))) return h
    }
  }
  return null
}

export function findEmailColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['email', 'e-mail', 'mail', 'e_mail'])
}

export function findCargoColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['cargo', 'job', 'job_title', 'titulo', 'titulo_profissional'])
}

export function findEmpresaColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['empresa', 'company', 'company_name', 'organizacao', 'organização'])
}

export function findCidadeColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['cidade', 'city', 'municipio', 'município'])
}

export function findEnderecoColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['endereco', 'endereço', 'address', 'address_line', 'logradouro'])
}

export function findTagColumn(headers: string[]): string | null {
  return findColumnByAliases(headers, ['tag', 'etiqueta', 'label', 'marcador'])
}

export function phoneDigitsForLead(raw: string | null | undefined): string | null {
  if (!raw) return null
  const d = raw.replace(/\D/g, '')
  if (d.length < 10) return null
  if (d.startsWith('55') && d.length >= 12) return d
  if (d.length === 10 || d.length === 11) return `55${d}`
  if (d.length >= 12) return d
  return null
}

/** Igual ao webhook Evolution: alterna 9º dígito BR após DDD. */
function brazilAlternateNationalNine(national: string): string | null {
  const n = national.replace(/\D/g, '')
  if (n.length === 11 && n[2] === '9') {
    const ddd = n.slice(0, 2)
    const rest = n.slice(3)
    if (rest.length === 8) return ddd + rest
  }
  if (n.length === 10) {
    const ddd = n.slice(0, 2)
    const rest = n.slice(2)
    if (rest.length === 8) return ddd + '9' + rest
  }
  return null
}

/** Todas as formas equivalentes do mesmo número (Evolution × CSV × 9º dígito). */
export function allCanonicalPhoneKeys(fullDigits: string): string[] {
  const d = fullDigits.replace(/\D/g, '')
  if (!d) return []
  const out = new Set<string>([d])
  if (d.startsWith('55') && d.length >= 12) {
    const nat = d.slice(2)
    const alt = brazilAlternateNationalNine(nat)
    if (alt) out.add(`55${alt}`)
  }
  return [...out]
}

export function buildPhoneToLeadIdMap(rows: { id: string; phone: string | null }[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of rows) {
    const p = r.phone
    if (!p) continue
    for (const k of allCanonicalPhoneKeys(p)) {
      if (!m.has(k)) m.set(k, r.id)
    }
  }
  return m
}

export function findLeadIdForNormalizedPhone(
  lookup: Map<string, string>,
  normalizedPhone: string,
): string | undefined {
  for (const k of allCanonicalPhoneKeys(normalizedPhone)) {
    const id = lookup.get(k)
    if (id) return id
  }
  return undefined
}

/** Modelo para download — colunas na ordem acordada. */
export const CSV_TEMPLATE = [
  'nome,telefone,email,cargo,empresa,cidade,endereco,tag',
  '"Maria Silva",48999998888,maria@loja.com.br,Gerente,ACME LTDA,São Paulo,"Av. Brasil, 100 - sala 2",lista-vendas',
  '"João Souza","+55 11 91234-5678",,Vendedor,,Curitiba,,',
].join('\n')
