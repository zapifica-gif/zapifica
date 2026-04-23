/**
 * Canoniza número BR para o formato que a Evolution API espera (dígitos puros com DDI 55).
 * Aceita variações com/sem máscara, com ou sem 55, e também JIDs (@g.us).
 * Retorna null se for impossível extrair algo razoável.
 */
export function toEvolutionDigits(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  if (t.includes('@g.us')) return t
  const core = t.includes('@') ? (t.split('@')[0] ?? '') : t
  const digits = core.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('55') && digits.length >= 12) return digits
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  if (digits.length >= 12) return digits
  return null
}
