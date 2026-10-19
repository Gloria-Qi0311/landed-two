// Automation: Landed's recurring agent work, on a schedule. Three of them,
// each "when → what → then":
//   email_check   read new email → update applications
//   job_search    search with the confirmed brief → new jobs in Leads
//   portal_check  look at the candidate portals of applications that went
//                 quiet (user's Chrome, read-only) → ask before updating
// Everything else (how email updates are applied) belongs to one of them. The schedule is account-level (users.automations, /me). The daemon
// on the user's computer runs it (so it works with Landed closed) and keeps
// results on that computer until the browser picks them up (task kind
// `automation_sync`): the browser sends the schedule + the context the tasks
// need and acks what it has stored; the daemon answers with finished results
// and its run log. Plain TS, no dependencies.

export const AUTOMATION_KINDS = ['email_check', 'job_search', 'portal_check'] as const
export type AutomationKind = typeof AUTOMATION_KINDS[number]

/** Every N hours, or at a time of day on some days of the week (0 = Sunday),
 *  in the computer's local time. */
export type Schedule =
  | { kind: 'interval'; hours: number }
  | { kind: 'daily'; time: string; days: number[] }

/** Where Find new jobs looks (job_search only). `agents`: ids of the agents
 *  on the user's computer to search with (claude, codex, an ACP agent…);
 *  each runs the search, and the results are merged. The public sources run
 *  in the browser (apps/web/src/lib/supply.ts); cloud agents pull the task
 *  themselves (get_tasks). */
export type SearchSources = { agents: string[]; job_lists: boolean; company_boards: boolean; cloud_agents: boolean }

/** `quiet_days` (portal_check only): look at an application's portal once
 *  it has had no news for this many days. `sources` (job_search only). */
export type AutomationConfig = { enabled: boolean; schedule: Schedule; quiet_days?: number; sources?: SearchSources }
export type Automations = Record<AutomationKind, AutomationConfig>

export const INTERVAL_HOURS = [1, 2, 4, 8, 12]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS = [1, 2, 3, 4, 5]
export const QUIET_DAY_CHOICES = [7, 14, 21, 30]
/** At most this many portals per run: each one is a few minutes of browsing. */
export const MAX_PORTALS_PER_RUN = 5

/** Claude Code, plus the public sources, which cost no tokens. */
export const DEFAULT_SEARCH_SOURCES: SearchSources = { agents: ['claude'], job_lists: true, company_boards: true, cloud_agents: true }
export const MAX_SEARCH_AGENTS = 6

export const DEFAULT_AUTOMATIONS: Automations = {
  email_check: { enabled: false, schedule: { kind: 'interval', hours: 4 } },
  job_search: { enabled: false, schedule: { kind: 'daily', time: '09:00', days: ALL_DAYS }, sources: DEFAULT_SEARCH_SOURCES },
  portal_check: { enabled: false, schedule: { kind: 'daily', time: '10:00', days: [1] }, quiet_days: 14 },
}

function parseSchedule(raw: unknown, fallback: Schedule): Schedule {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  if (r.kind === 'interval' && typeof r.hours === 'number' && INTERVAL_HOURS.includes(r.hours)) return { kind: 'interval', hours: r.hours }
  if (r.kind === 'daily' && typeof r.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) {
    const days = Array.isArray(r.days) ? ALL_DAYS.filter((d) => (r.days as unknown[]).includes(d)) : ALL_DAYS
    return { kind: 'daily', time: r.time, days: days.length ? days : ALL_DAYS }
  }
  return fallback
}

/** Normalize the account's automation settings (missing → defaults). */
export function parseAutomations(raw: unknown): Automations {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>
  const out = {} as Automations
  for (const kind of AUTOMATION_KINDS) {
    const d = DEFAULT_AUTOMATIONS[kind]
    const x = r[kind]
    out[kind] = { enabled: x?.enabled === true, schedule: parseSchedule(x?.schedule, d.schedule) }
    if (kind === 'portal_check') out[kind].quiet_days = QUIET_DAY_CHOICES.includes(x?.quiet_days as number) ? x!.quiet_days as number : d.quiet_days
    if (kind === 'job_search') out[kind].sources = parseSearchSources(x?.sources)
  }
  return out
}

/** Stored search sources → valid ones; missing → the defaults. */
export function parseSearchSources(raw: unknown): SearchSources {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SEARCH_SOURCES, agents: [...DEFAULT_SEARCH_SOURCES.agents] }
  const r = raw as Record<string, unknown>
  const agents = Array.isArray(r.agents)
    ? [...new Set(r.agents.filter((a): a is string => typeof a === 'string' && /^[a-z0-9][a-z0-9:._-]{0,39}$/.test(a)))].slice(0, MAX_SEARCH_AGENTS)
    : [...DEFAULT_SEARCH_SOURCES.agents]
  const flag = (k: keyof Omit<SearchSources, 'agents'>) => (typeof r[k] === 'boolean' ? r[k] as boolean : DEFAULT_SEARCH_SOURCES[k])
  return { agents, job_lists: flag('job_lists'), company_boards: flag('company_boards'), cloud_agents: flag('cloud_agents') }
}

/** The agents here a search runs with: the chosen ones that are here, else
 *  the first that can search (so a computer without the chosen agents still
 *  searches). Shared by the daemon's schedule and the browser's Run now. */
export function pickSearchAgents<A extends { id: string }>(available: A[], sources: SearchSources | undefined): A[] {
  const chosen = available.filter((a) => (sources ?? DEFAULT_SEARCH_SOURCES).agents.includes(a.id))
  return chosen.length ? chosen : available.slice(0, 1)
}

/** When a schedule next fires after the last run (local time). Never run → now. */
export function nextRun(schedule: Schedule, lastRunAt: string | null | undefined, now = new Date()): Date {
  const last = lastRunAt && !Number.isNaN(Date.parse(lastRunAt)) ? new Date(lastRunAt) : null
  if (schedule.kind === 'interval') {
    return last ? new Date(last.getTime() + schedule.hours * 3_600_000) : now
  }
  const [h, m] = schedule.time.split(':').map(Number)
  // The first scheduled moment after the last run — in the past if a run was
  // missed (it catches up once) — or after now if it has never run.
  const from = last ?? now
  for (let i = 0; i <= 8; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m)
    if (day > from && schedule.days.includes(day.getDay())) return day
  }
  return new Date(from.getTime() + 7 * 86_400_000)
}

export function isDue(schedule: Schedule, lastRunAt: string | null | undefined, now = new Date()): boolean {
  return nextRun(schedule, lastRunAt, now).getTime() <= now.getTime()
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function describeSchedule(s: Schedule): string {
  if (s.kind === 'interval') return s.hours === 1 ? 'Every hour' : `Every ${s.hours} hours`
  const days = s.days.length === 7 ? 'Every day' : s.days.join() === WEEKDAYS.join() ? 'Weekdays' : s.days.map((d) => DAY_NAMES[d]).join(', ')
  return `${days} at ${s.time}`
}

/** The applications a portal check looks at now: no news for `quietDays`
 *  and not looked at in that time either, longest-quiet first, at most
 *  MAX_PORTALS_PER_RUN. */
export function pickQuietPortals(apps: PortalApp[], quietDays: number, lastChecked: Record<string, string>, now = Date.now()): PortalApp[] {
  const cutoff = now - quietDays * 86_400_000
  return apps
    .filter((a) => Date.parse(a.last_signal_at) <= cutoff && !(Date.parse(lastChecked[a.id] ?? '') > cutoff))
    .sort((a, b) => Date.parse(a.last_signal_at) - Date.parse(b.last_signal_at))
    .slice(0, MAX_PORTALS_PER_RUN)
}

// ── the sync task (browser ⇄ daemon) ──────────────────────────────────────

/** An in-progress application with a portal link, and its last sign of life. */
export type PortalApp = { id: string; company: string; role: string; stage: string; url: string; last_signal_at: string }

export type SyncContext = {
  /** for email checks: the applications Landed knows, and where to start reading */
  applications: { company: string; role: string; stage: string }[]
  email_since: string | null
  /** for job searches: the confirmed brief (packages/schema/src/search-brief.ts) */
  brief: unknown | null
  search_id: string | null
  /** for portal checks: candidates (the daemon picks the quiet ones at run time) */
  portal_apps: PortalApp[]
}

export type SyncInput = {
  /** the computer that runs the schedule (others only keep the settings) */
  runtime_id: string
  automations: Automations
  context: SyncContext
  /** run these now, schedule or not */
  run_now: AutomationKind[]
  /** results the browser has stored — the daemon can drop them */
  ack: string[]
  /** with run_now email_check: read this many days back instead of from the last check */
  email_rescan_days: number | null
}

export const RESCAN_DAYS = [7, 30]

export type AutomationResult = {
  id: string
  kind: AutomationKind
  started_at: string
  finished_at: string
  summary: string
  findings?: unknown[]
  jobs?: unknown[]
  /** portal checks: what each portal showed, and which application each ref was */
  results?: unknown[]
  items?: { ref: string; application_id: string; company: string }[]
}

export type AutomationRun = {
  id: string
  kind: AutomationKind
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'error'
  /** e.g. "12 emails about applications", "18 jobs" */
  summary: string | null
  error: string | null
}

export type SyncOutput = {
  results: AutomationResult[]
  runs: AutomationRun[]
  /** per kind: when it last ran successfully, and when it runs next */
  state: Partial<Record<AutomationKind, { last_success_at: string | null; next_run_at: string | null; running: boolean }>>
}

const UUID = /^[0-9a-f-]{36}$/i
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
const isKind = (v: unknown): v is AutomationKind => (AUTOMATION_KINDS as readonly unknown[]).includes(v)

export function parseSyncInput(raw: unknown): SyncInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.runtime_id !== 'string' || !UUID.test(r.runtime_id)) return null
  const c = (r.context && typeof r.context === 'object' ? r.context : {}) as Record<string, unknown>
  const STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']
  const applications = (Array.isArray(c.applications) ? c.applications : []).slice(0, 300)
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({ company: str(a.company, 120).trim(), role: str(a.role, 200).trim(), stage: String(a.stage) }))
    .filter((a) => a.company && a.role && STAGES.includes(a.stage))
  return {
    runtime_id: r.runtime_id,
    automations: parseAutomations(r.automations),
    context: {
      applications,
      email_since: iso(c.email_since),
      brief: c.brief && typeof c.brief === 'object' ? c.brief : null,
      search_id: typeof c.search_id === 'string' && UUID.test(c.search_id) ? c.search_id : null,
      portal_apps: (Array.isArray(c.portal_apps) ? c.portal_apps : []).slice(0, 100)
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({
          id: String(a.id), company: str(a.company, 120).trim(), role: str(a.role, 200).trim(), stage: String(a.stage),
          url: str(a.url, 2000).trim(), last_signal_at: iso(a.last_signal_at) ?? '',
        }))
        .filter((a) => UUID.test(a.id) && a.company && a.role && STAGES.includes(a.stage) && /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(a.url) && a.last_signal_at),
    },
    run_now: (Array.isArray(r.run_now) ? r.run_now : []).filter(isKind),
    ack: (Array.isArray(r.ack) ? r.ack : []).filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 200),
    email_rescan_days: RESCAN_DAYS.includes(r.email_rescan_days as number) ? r.email_rescan_days as number : null,
  }
}

/** Shape-check a sync answer; the payloads inside (findings, jobs) are
 *  validated again by their own parsers when stored. */
export function parseSyncOutput(raw: unknown): SyncOutput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const results = (Array.isArray(r.results) ? r.results : []).slice(0, 50)
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof x.id === 'string' && UUID.test(x.id) && isKind(x.kind))
    .map((x) => ({
      id: x.id as string, kind: x.kind as AutomationKind,
      started_at: iso(x.started_at) ?? new Date().toISOString(), finished_at: iso(x.finished_at) ?? new Date().toISOString(),
      summary: str(x.summary, 1000),
      ...(Array.isArray(x.findings) ? { findings: x.findings.slice(0, 100) } : {}),
      ...(Array.isArray(x.jobs) ? { jobs: x.jobs.slice(0, 60) } : {}),
      ...(Array.isArray(x.results) ? { results: x.results.slice(0, MAX_PORTALS_PER_RUN) } : {}),
      ...(Array.isArray(x.items) ? {
        items: x.items.slice(0, MAX_PORTALS_PER_RUN)
          .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof i.ref === 'string' && typeof i.application_id === 'string' && UUID.test(i.application_id))
          .map((i) => ({ ref: str(i.ref, 8), application_id: i.application_id as string, company: str(i.company, 120) })),
      } : {}),
    }))
  const runs = (Array.isArray(r.runs) ? r.runs : []).slice(0, 30)
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && isKind(x.kind))
    .map((x) => ({
      id: str(x.id, 64), kind: x.kind as AutomationKind,
      started_at: iso(x.started_at) ?? '', finished_at: iso(x.finished_at),
      status: (['running', 'ok', 'error'].includes(x.status as string) ? x.status : 'error') as AutomationRun['status'],
      summary: str(x.summary, 300) || null, error: str(x.error, 500) || null,
    }))
  const st = (r.state && typeof r.state === 'object' ? r.state : {}) as Record<string, Record<string, unknown>>
  const state: SyncOutput['state'] = {}
  for (const kind of AUTOMATION_KINDS) {
    const s = st[kind]
    if (s && typeof s === 'object') state[kind] = { last_success_at: iso(s.last_success_at), next_run_at: iso(s.next_run_at), running: s.running === true }
  }
  return { results, runs, state }
}
