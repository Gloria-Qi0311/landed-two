// Applications the user shows their agent in the chat — a screenshot of a
// "thanks for applying" page, an "applied jobs" list, a portal status. Some
// sites send no confirmation email, so this is how those get into Landed.
// The agent reads them and ends its reply with a ```landed-applications
// block; the Agent page shows it as a card, and the user adds them with one
// click (apps/web/src/components/reported-applications.tsx). The agent
// never adds anything itself. Plain TS, no dependencies.

export const APPLICATIONS_FENCE = 'landed-applications'
export const REPORTED_STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected'] as const
export type ReportedStage = typeof REPORTED_STAGES[number]

export type ReportedApplication = {
  company: string
  role: string
  stage: ReportedStage
  /** YYYY-MM-DD, when the screenshot shows it */
  applied_on: string | null
  job_url: string | null
  location: string | null
  note: string | null
}

export const MAX_REPORTED = 20

const text = (v: unknown, max: number) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)

function day(v: unknown): string | null {
  const t = text(v, 10)
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const d = new Date(`${t}T12:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t
}

/** Validate the block's applications: company + role required, a known
 *  stage (default applied), http(s) links only, duplicates dropped. */
export function parseReportedApplications(raw: unknown): ReportedApplication[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { applications?: unknown }).applications) ? (raw as { applications: unknown[] }).applications : []
  const out: ReportedApplication[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const company = text(r.company, 120)
    const role = text(r.role, 200)
    if (!company || !role) continue
    const key = `${company}|${role}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const url = text(r.job_url, 2000)
    out.push({
      company, role,
      stage: (REPORTED_STAGES as readonly unknown[]).includes(r.stage) ? r.stage as ReportedStage : 'applied',
      applied_on: day(r.applied_on),
      job_url: url && /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(url) ? url : null,
      location: text(r.location, 120),
      note: text(r.note, 500),
    })
    if (out.length >= MAX_REPORTED) break
  }
  return out
}

/** Split an agent reply into the visible text and the applications it
 *  reports. `drafting` = the block has started but not finished streaming. */
export function extractApplications(reply: string): { text: string; applications: ReportedApplication[]; drafting: boolean } {
  const start = reply.search(new RegExp('```' + APPLICATIONS_FENCE + '[^\\n]*\\n'))
  if (start === -1) return { text: reply, applications: [], drafting: false }
  const bodyStart = reply.indexOf('\n', start) + 1
  const end = reply.indexOf('```', bodyStart)
  const before = reply.slice(0, start).trimEnd()
  if (end === -1) return { text: before, applications: [], drafting: true }
  const after = reply.slice(end + 3).trim()
  let applications: ReportedApplication[] = []
  try {
    applications = parseReportedApplications(JSON.parse(reply.slice(bodyStart, end)))
  } catch {
    applications = []
  }
  return { text: after ? `${before}\n\n${after}` : before, applications, drafting: false }
}
