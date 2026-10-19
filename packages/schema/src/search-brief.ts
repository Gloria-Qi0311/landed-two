// Job search brief — what the user wants next, agreed in the Ask Agent chat —
// and the jobs a search run reports back. Shared by the web app (reads the
// brief out of the agent's reply, stores it), the server (validates
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

/** Where the agent's chat reply carries a brief: a fenced block tagged
 *  `landed-brief` holding the JSON (the chat system prompt asks for it). */
export const BRIEF_FENCE = 'landed-brief'

/** Split an agent reply into the visible text and the brief it proposes.
 *  `drafting` = the block has started but not finished streaming yet. */
/** What the agent suggests about running the search, from the same block:
 *  which agents to search with and how often, when the user said so. The
 *  card shows it; nothing is set until the user saves. */
export type SearchSetup = {
  search_with: string[] | null
  schedule: { kind: 'interval'; hours: number } | { kind: 'daily'; time: string } | null
}

export function parseSearchSetup(raw: unknown): SearchSetup {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const ids = Array.isArray(r.search_with)
    ? [...new Set(r.search_with.filter((a): a is string => typeof a === 'string').map((a) => a.trim().toLowerCase()).filter((a) => /^[a-z0-9][a-z0-9:._-]{0,39}$/.test(a)))].slice(0, 6)
    : []
  const s = typeof r.schedule === 'string' ? r.schedule.trim().toLowerCase() : ''
  const daily = s.match(/^daily\s+([01]\d|2[0-3]):([0-5]\d)$/)
  const every = s.match(/^every\s+(\d{1,2})\s+hours?$/)
  const schedule = daily ? { kind: 'daily' as const, time: `${daily[1]}:${daily[2]}` }
    : every && [1, 2, 4, 8, 12].includes(Number(every[1])) ? { kind: 'interval' as const, hours: Number(every[1]) }
      : null
  return { search_with: ids.length ? ids : null, schedule }
}

export function extractBrief(reply: string): { text: string; brief: SearchBrief | null; setup: SearchSetup | null; drafting: boolean } {
  const start = reply.search(new RegExp('```' + BRIEF_FENCE + '[^\\n]*\\n'))
  if (start === -1) return { text: reply, brief: null, setup: null, drafting: false }
  const bodyStart = reply.indexOf('\n', start) + 1
  const end = reply.indexOf('```', bodyStart)
  const before = reply.slice(0, start).trimEnd()
  if (end === -1) return { text: before, brief: null, setup: null, drafting: true }
  const after = reply.slice(end + 3).trim()
  let brief: SearchBrief | null = null
  let setup: SearchSetup | null = null
  try {
    const raw = JSON.parse(reply.slice(bodyStart, end))
    brief = parseBrief(raw)
    setup = brief ? parseSearchSetup(raw) : null
  } catch {
    brief = null
  }
  return { text: after ? `${before}\n\n${after}` : before, brief, setup, drafting: false }
}
