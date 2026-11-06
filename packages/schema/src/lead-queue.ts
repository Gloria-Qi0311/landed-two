// The apply queue's fields on a job lead (docs/leads-model.md): what the
// supply track knows about a candidate job. Shared by the web app (both
// stores), the server and packages/supply, so a value is valid in the same
// way everywhere. Plain TS, no dependencies (the server runs it with Node's
// type stripping).
//
//   posted_at  "YYYY-MM-DD"  when the source says the job was posted
//   closed_at  ISO time      when the posting disappeared from its source
//   screen     {pass, reasons}  hard filters (graduation date, sponsorship,
//                               citizenship / clearance)
//   fit        {score, reasons} match against the master resume, score 0–1
//   dedupe     {same_as, checked, by, at, reason}  a duplicate the rules
//              couldn't decide, as the user's own agent judged it (#146)
//
// Every field is optional (null). Priority is computed when shown, never
// stored (packages/supply → priority).

export type LeadScreen = { pass: boolean; reasons: string[] }
export type LeadFit = { score: number; reasons: string[] }
/** `same_as`: the lead this one is the same job as, hidden from Leads while
 *  set (Split clears it; the lead is never deleted). `checked`: the leads it
 *  was already compared with, whatever the answer, so a pair is asked once.
 *  `by`: who judged ("Claude Code"); `reason`: why, for "same". */
export type LeadDedupe = { same_as: string | null; checked: string[]; by: string; at: string; reason: string | null }

export type LeadQueueFields = {
  posted_at: string | null
  closed_at: string | null
  screen: LeadScreen | null
  fit: LeadFit | null
  dedupe: LeadDedupe | null
}

export const LEAD_QUEUE_FIELDS = ['posted_at', 'closed_at', 'screen', 'fit', 'dedupe'] as const

export const MAX_REASONS = 10
/** Years a posting or closing date may have: a source that sends seconds
 *  where ms are expected lands in 1970 and is rejected, not stored. */
const MIN_YEAR = 2000
const MAX_YEAR = 2100
const inRange = (year: number) => year >= MIN_YEAR && year <= MAX_YEAR
export const MAX_REASON_LENGTH = 300

/** A posting date: an ISO date or time (its own calendar day), or epoch ms
 *  (Lever's createdAt) → "YYYY-MM-DD", in 2000–2100. Anything else → null. */
export function parsePostedAt(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    const d = new Date(raw)
    return inRange(d.getUTCFullYear()) ? d.toISOString().slice(0, 10) : null
  }
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]]
    const date = new Date(Date.UTC(y, mo - 1, d))
    if (!inRange(y) || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
    return `${m[1]}-${m[2]}-${m[3]}`
  }
  // "Oct 5, 2026": Date reads it as local midnight, so take the local day
  // (UTC's could be the day before, east of Greenwich).
  const ms = Date.parse(t)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  if (!inRange(d.getFullYear())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A moment (ISO string, epoch ms or Date) → ISO time, in 2000–2100.
 *  Anything else → null. */
export function parseClosedAt(raw: unknown): string | null {
  const ms = raw instanceof Date ? raw.getTime()
    : typeof raw === 'number' ? raw
      : typeof raw === 'string' && raw.trim() ? Date.parse(raw.trim())
        : NaN
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return inRange(d.getUTCFullYear()) ? d.toISOString() : null
}

function parseReasons(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const reasons: string[] = []
  for (const r of raw) {
    if (typeof r !== 'string') return null
    const t = r.replace(/\s+/g, ' ').trim()
    if (t) reasons.push(t.slice(0, MAX_REASON_LENGTH))
  }
  return reasons.slice(0, MAX_REASONS)
}

/** `{pass: boolean, reasons: string[]}` → itself, cleaned; else null. */
export function parseScreen(raw: unknown): LeadScreen | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const reasons = parseReasons(r.reasons ?? [])
  if (typeof r.pass !== 'boolean' || !reasons) return null
  return { pass: r.pass, reasons }
}

/** `{score: 0–1, reasons: string[]}` → itself, cleaned; else null. */
export function parseFit(raw: unknown): LeadFit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const reasons = parseReasons(r.reasons ?? [])
  if (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 1 || !reasons) return null
  return { score: r.score, reasons }
}

const LEAD_ID = /^[A-Za-z0-9-]{1,64}$/
/** The newest this many compared leads are kept. */
export const MAX_DEDUPE_CHECKED = 50

/** `{same_as, checked, by, at, reason}` → itself, cleaned; else null. */
export function parseDedupe(raw: unknown): LeadDedupe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const same = r.same_as === null || r.same_as === undefined ? null : typeof r.same_as === 'string' && LEAD_ID.test(r.same_as) ? r.same_as : undefined
  const by = typeof r.by === 'string' ? r.by.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  const at = parseClosedAt(r.at)
  if (same === undefined || !Array.isArray(r.checked) || !by || !at) return null
  const checked = [...new Set(r.checked.filter((id): id is string => typeof id === 'string' && LEAD_ID.test(id)))].slice(-MAX_DEDUPE_CHECKED)
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH) : null
  return { same_as: same, checked, by, at, reason }
}

const PARSERS = { posted_at: parsePostedAt, closed_at: parseClosedAt, screen: parseScreen, fit: parseFit, dedupe: parseDedupe } as const

export type LeadQueueError = { field: typeof LEAD_QUEUE_FIELDS[number]; message: string }

const MESSAGES: Record<typeof LEAD_QUEUE_FIELDS[number], string> = {
  posted_at: 'posted_at must be a date',
  closed_at: 'closed_at must be a time',
  screen: 'screen must be {pass: boolean, reasons: string[]}',
  fit: 'fit must be {score: 0–1, reasons: string[]}',
  dedupe: 'dedupe must be {same_as, checked: string[], by, at, reason}',
}

/** The queue fields present in `input` (undefined = not given), validated:
 *  null clears, anything else must parse. Returns the cleaned values or the
 *  first invalid field. Used by every write path (both stores, the server). */
export function readLeadQueueFields(input: Record<string, unknown>):
  { ok: true; fields: Partial<LeadQueueFields> } | { ok: false; error: LeadQueueError } {
  const fields: Partial<LeadQueueFields> = {}
  for (const field of LEAD_QUEUE_FIELDS) {
    const raw = input[field]
    if (raw === undefined) continue
    if (raw === null || raw === '') {
      fields[field] = null
      continue
    }
    const value = PARSERS[field](raw)
    if (value === null) return { ok: false, error: { field, message: MESSAGES[field] } }
    ;(fields as Record<string, unknown>)[field] = value
  }
  return { ok: true, fields }
}

/** For old backups and uploads: every field present, invalid ones null. */
export function leadQueueDefaults(input: Record<string, unknown>): LeadQueueFields {
  return {
    posted_at: parsePostedAt(input.posted_at),
    closed_at: parseClosedAt(input.closed_at),
    screen: parseScreen(input.screen),
    fit: parseFit(input.fit),
    dedupe: parseDedupe(input.dedupe),
  }
}
