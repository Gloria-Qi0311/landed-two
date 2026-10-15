import { createHash, randomBytes } from 'node:crypto'

const CODE_BYTES = 10
const CODE_RE = /^LND[0-9A-F]{20}$/

/** Human-readable 80-bit recovery codes. Raw codes are shown once only. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const value = randomBytes(CODE_BYTES).toString('hex').toUpperCase()
    return `LND-${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}-${value.slice(15, 20)}`
  })
}

export function normalizeRecoveryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, '')
  return CODE_RE.test(normalized) ? normalized : null
}

export function hashRecoveryCode(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode).digest('hex')
}
