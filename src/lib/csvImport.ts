/**
 * Importação de CSV (nome/telefone) compartilhada entre Extrator e Base de Contatos.
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
    'nome_empresa',
    'nome',
    'title',
    'name',
    'titulo',
    'empresa',
    'displayname',
    'username',
  ]
  for (const c of order) {
    if (headers.includes(c)) return c
  }
  return headers.find((h) => h && h.length > 0) ?? null
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

export const CSV_TEMPLATE = 'nome,telefone\n"Maria Silva",48999998888\n"João Souza",+55 11 91234-5678\n'
