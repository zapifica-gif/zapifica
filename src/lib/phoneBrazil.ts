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
  if (digits.startsWith('55') && digits.length >= 12) {
    return preferBrazilMobileNineDigit(digits)
  }
  if (digits.length === 10 || digits.length === 11) {
    return preferBrazilMobileNineDigit(`55${digits}`)
  }
  if (digits.length >= 12) return preferBrazilMobileNineDigit(digits)
  return null
}

/**
 * Normaliza variações clássicas do Brasil para reduzir clonagem de contatos.
 * Ex.: "551199990000" (DDD + 8) vira "5511999990000" (DDD + 9 + 8) quando faz sentido.
 * Regra conservadora: só injeta o 9º dígito quando o 1º dígito do número (após DDD)
 * sugere celular (6/7/8/9).
 */
export function preferBrazilMobileNineDigit(fullDigits: string): string {
  const d = fullDigits.replace(/\D/g, '')
  if (!d.startsWith('55')) return d
  // 12 = 55 + DDD(2) + 8 dígitos (formato antigo / sem 9)
  if (d.length !== 12) return d
  const ddd = d.slice(2, 4)
  const rest8 = d.slice(4)
  if (ddd.length !== 2 || rest8.length !== 8) return d
  const first = rest8[0] ?? ''
  if (!'6789'.includes(first)) return d
  return `55${ddd}9${rest8}`
}
