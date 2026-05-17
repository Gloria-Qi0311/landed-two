// Timestamp formatting — UTC at rest, local TZ at render (spec.md §8 #4).
// Use these helpers everywhere we render a timestamp string so the format
// stays consistent (and accidentally-different formats across views never
// confuse the user).

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

const SHORT_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
}

/**
 * Format an ISO 8601 string (stored as UTC) into the user's local TZ.
 * Returns '' for null/undefined/invalid — never throws, never shows "Invalid Date".
 */
export function formatTimestamp(
  iso: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = DEFAULT_OPTS,
): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, opts).format(d)
}

/**
 * Date-only "Apr 23" style format. Useful for activity timeline rows.
 */
export function formatShortDate(iso: string | Date | null | undefined): string {
  return formatTimestamp(iso, SHORT_OPTS)
}

/**
 * Relative time like "2h ago", "3d ago", "just now". For older-than-30-days
 * timestamps, falls back to absolute (formatTimestamp) — relative time loses
 * meaning past that horizon ("5 months ago" is just noise).
 */
export function formatRelative(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''

  const diffMs = d.getTime() - Date.now()
  const absMs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (absMs < 60_000) return rtf.format(Math.round(diffMs / 1000), 'second')
  if (absMs < 3_600_000) return rtf.format(Math.round(diffMs / 60_000), 'minute')
  if (absMs < 86_400_000) return rtf.format(Math.round(diffMs / 3_600_000), 'hour')
  if (absMs < 30 * 86_400_000) return rtf.format(Math.round(diffMs / 86_400_000), 'day')
  return formatTimestamp(d, SHORT_OPTS)
}
