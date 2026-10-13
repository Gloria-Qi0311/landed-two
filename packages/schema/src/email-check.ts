// Email check — the user's own agent reads their mailbox (read-only, e.g.
// Claude Code's Gmail connector) and reports what job-application emails
// mean. Shared by the server (validates `email_check` tasks and their
// results) and the web app (feeds findings to the observation processor as
// `application_status` observations). Plain TS, no dependencies: the server
// runs it with Node's type stripping.

export const EMAIL_STATUSES = ['applied', 'recruiter_response', 'assessment', 'interview', 'rejected', 'offer', 'other'] as const
export type EmailFindingStatus = typeof EMAIL_STATUSES[number]

const STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']

/** What the agent is told, besides the date: the applications Landed knows,
 *  so it recognizes companies and roles. No notes, no ids — just enough. */
export type EmailCheckInput = {
  since: string
  applications: { company: string; role: string; stage: string }[]
}

export type EmailFinding = {
  company: string
  role: string | null
  status: EmailFindingStatus
  confidence: number | null
  job_url: string | null
  /** when the interview is, if the email schedules or confirms one (ISO) */
  interview_at: string | null
  interview_format: 'onsite' | 'remote' | null
  evidence: {
    message_id?: string
    thread_id?: string
    sender_domain?: string
    subject?: string
    received_at?: string
    summary?: string
  }
}

export const MAX_EMAIL_APPLICATIONS = 300
export const MAX_EMAIL_FINDINGS = 100
const MAX_LOOKBACK_DAYS = 120

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function iso(v: unknown): string | null {
  const t = text(v, 40)
  return t && !Number.isNaN(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null
}

/** Validate an email_check task's input. `since` is clamped to the last
 *  MAX_LOOKBACK_DAYS; at most MAX_EMAIL_APPLICATIONS applications. */
export function parseEmailCheckInput(raw: unknown, now = Date.now()): EmailCheckInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const since = iso(r.since)
  if (!since) return null
  const earliest = now - MAX_LOOKBACK_DAYS * 86_400_000
  const applications: EmailCheckInput['applications'] = []
  for (const a of Array.isArray(r.applications) ? r.applications : []) {
    if (!a || typeof a !== 'object') continue
    const company = text((a as Record<string, unknown>).company, 120)
    const role = text((a as Record<string, unknown>).role, 200)
    const stage = (a as Record<string, unknown>).stage
    if (!company || !role || typeof stage !== 'string' || !STAGES.includes(stage)) continue
    applications.push({ company, role, stage })
    if (applications.length >= MAX_EMAIL_APPLICATIONS) break
  }
  return { since: new Date(Math.max(Date.parse(since), earliest)).toISOString(), applications }
}

/** Validate what the agent reported: needs company + a known status;
 *  confidence clamped to 0–1; evidence fields bounded; http(s) links only. */
export function parseEmailFindings(raw: unknown): EmailFinding[] {
  if (!Array.isArray(raw)) return []
  const out: EmailFinding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const company = text(f.company, 120)
    const status = f.status as EmailFindingStatus
    if (!company || !EMAIL_STATUSES.includes(status)) continue
    const ev = f.evidence && typeof f.evidence === 'object' ? (f.evidence as Record<string, unknown>) : {}
    const evidence: EmailFinding['evidence'] = {}
    for (const [k, max] of [['message_id', 300], ['thread_id', 300], ['sender_domain', 120], ['subject', 300], ['summary', 400]] as const) {
      const v = text(ev[k], max)
      if (v) evidence[k] = v
    }
    const received = iso(ev.received_at)
    if (received) evidence.received_at = received
    const url = text(f.job_url, 2000)
    const confidence = typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? Math.min(1, Math.max(0, f.confidence)) : null
    out.push({
      company, status, confidence, evidence,
      role: text(f.role, 200),
      job_url: url && /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(url) ? url : null,
      interview_at: status === 'interview' ? iso(f.interview_at) : null,
      interview_format: f.interview_format === 'onsite' || f.interview_format === 'remote' ? f.interview_format : null,
    })
    if (out.length >= MAX_EMAIL_FINDINGS) break
  }
  return out
}
