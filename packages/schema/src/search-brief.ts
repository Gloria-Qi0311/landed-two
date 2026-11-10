// Job search brief — what the user wants next, set in Workflow → Find new
// jobs — and the jobs a search run reports back. Shared by the web app
// (stores it), the server (validates
// `job_search` tasks and their results) and indirectly the daemon (turns the
// brief into a search prompt). Plain TS, no dependencies: the server runs it
// with Node's type stripping.

export type RemotePreference = 'remote' | 'hybrid' | 'onsite' | 'any'

export type SearchBrief = {
  /** One or two sentences, in the user's language. */
  summary: string
  /** Job titles as postings write them, e.g. "Associate Product Manager". */
  roles: string[]
  /** "new grad", "senior", … */
  seniority: string | null
  /** Empty = anywhere. */
  locations: string[]
  remote: RemotePreference
  /** Needs visa sponsorship; null = didn't say. */
  needs_sponsorship: boolean | null
  salary_min: string | null
  industries: string[]
  include_companies: string[]
  exclude_companies: string[]
  notes: string | null
}

/** One job a search run found. */
export type FoundJob = {
  company: string
  title: string
  job_url: string | null
  location: string | null
  posted: string | null
  /** apply-by date as the agent gave it; the processor normalizes it (parseDeadline) */
  deadline: string | null
  salary: string | null
  sponsorship: string | null
  /** Why it fits the brief, one sentence. */
  why: string | null
}

const REMOTE: RemotePreference[] = ['remote', 'hybrid', 'onsite', 'any']
const MAX_LIST = 15
export const MAX_FOUND_JOBS = 60

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function list(v: unknown, max = 120): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const t = text(item, max)
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
    if (out.length >= MAX_LIST) break
  }
  return out
}

/** Validate and bound a brief from an untrusted source (the agent's reply, a
 *  request body). Null unless it says at least which roles to look for. */
export function parseBrief(raw: unknown): SearchBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const roles = list(r.roles)
  if (roles.length === 0) return null
  const locations = list(r.locations)
  const remote = REMOTE.includes(r.remote as RemotePreference) ? (r.remote as RemotePreference) : 'any'
  return {
    summary: text(r.summary, 400) ?? `${roles.join(', ')}${locations.length ? ` · ${locations.join(', ')}` : ''}`,
    roles,
    seniority: text(r.seniority, 80),
    locations,
    remote,
    needs_sponsorship: typeof r.needs_sponsorship === 'boolean' ? r.needs_sponsorship : null,
    salary_min: text(r.salary_min, 80),
    industries: list(r.industries),
    include_companies: list(r.include_companies),
    exclude_companies: list(r.exclude_companies),
    notes: text(r.notes, 1000),
  }
}

/** http(s) links only — never javascript:, data:, file: … */
function httpUrl(v: unknown): string | null {
  const t = text(v, 2000)
  return t && /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(t) ? t : null
}

/** Validate a search run's results: drops entries without company + title,
 *  non-http links and duplicates; at most MAX_FOUND_JOBS. */
export function parseFoundJobs(raw: unknown): FoundJob[] {
  if (!Array.isArray(raw)) return []
  const out: FoundJob[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const j = item as Record<string, unknown>
    const company = text(j.company, 120)
    const title = text(j.title, 200)
    if (!company || !title) continue
    const job_url = httpUrl(j.job_url)
    const key = job_url ?? `${company}|${title}|${text(j.location, 120) ?? ''}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      company, title, job_url,
      location: text(j.location, 120),
      posted: text(j.posted, 60),
      deadline: text(j.deadline, 80),
      salary: text(j.salary, 120),
      sponsorship: text(j.sponsorship, 200),
      why: text(j.why, 400),
    })
    if (out.length >= MAX_FOUND_JOBS) break
  }
  return out
}

/** A found job's extra details as one description (a lead's text). */
export function describeFoundJob(j: FoundJob): string | null {
  const parts = [j.why, j.salary && `Salary: ${j.salary}`, j.sponsorship && `Sponsorship: ${j.sponsorship}`, j.posted && `Posted: ${j.posted}`]
  const text = parts.filter(Boolean).join('\n')
  return text || null
}
