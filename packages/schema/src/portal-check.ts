// Portal check — the fallback when email is silent: the user's own agent
// looks at candidate portals (Workday, LinkedIn, Handshake, …) in the user's
// Chrome, read-only, and reports the status each one shows. Shared by the
// server (validates `portal_check` tasks and results) and the web app (maps
// results back to applications). Plain TS, no dependencies.

// Same statuses as email-check.ts (kept standalone: the server imports these
// files directly with Node's type stripping).
const EMAIL_STATUSES = ['applied', 'recruiter_response', 'assessment', 'interview', 'rejected', 'offer', 'other'] as const
type EmailFindingStatus = typeof EMAIL_STATUSES[number]

/** One application to look up. `ref` is a short label ("1", "2", …) so
 *  Landed's ids never leave the browser. */
export type PortalCheckItem = { ref: string; company: string; role: string; stage: string; url: string }

export type PortalOutcome = 'status_found' | 'login_required' | 'not_found' | 'error'

export type PortalResult = {
  ref: string
  outcome: PortalOutcome
  /** Landed's reading of the portal status; null unless status_found. */
  status: EmailFindingStatus | null
  /** The status exactly as the portal shows it, e.g. "No longer under consideration". */
  status_text: string | null
  confidence: number | null
  page_url: string | null
  note: string | null
}

export const MAX_PORTAL_ITEMS = 5
const OUTCOMES: PortalOutcome[] = ['status_found', 'login_required', 'not_found', 'error']
const STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function httpUrl(v: unknown): string | null {
  const t = text(v, 2000)
  return t && /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(t) ? t : null
}

export function parsePortalCheckInput(raw: unknown): { items: PortalCheckItem[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const list = (raw as Record<string, unknown>).items
  if (!Array.isArray(list)) return null
  const items: PortalCheckItem[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    const ref = text(r.ref, 8)
    const company = text(r.company, 120)
    const role = text(r.role, 200)
    const url = httpUrl(r.url)
    if (!ref || !company || !role || !url || typeof r.stage !== 'string' || !STAGES.includes(r.stage)) continue
    if (items.some((i) => i.ref === ref)) continue
    items.push({ ref, company, role, stage: r.stage, url })
    if (items.length >= MAX_PORTAL_ITEMS) break
  }
  return items.length ? { items } : null
}

export function parsePortalResults(raw: unknown): PortalResult[] {
  if (!Array.isArray(raw)) return []
  const out: PortalResult[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    const ref = text(r.ref, 8)
    const outcome = r.outcome as PortalOutcome
    if (!ref || !OUTCOMES.includes(outcome) || out.some((o) => o.ref === ref)) continue
    const status = outcome === 'status_found' && EMAIL_STATUSES.includes(r.status as EmailFindingStatus) ? (r.status as EmailFindingStatus) : null
    out.push({
      ref,
      outcome: outcome === 'status_found' && !status ? 'not_found' : outcome,
      status,
      status_text: text(r.status_text, 200),
      confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : null,
      page_url: httpUrl(r.page_url),
      note: text(r.note, 400),
    })
    if (out.length >= MAX_PORTAL_ITEMS) break
  }
  return out
}
