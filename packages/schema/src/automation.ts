// Automation: Landed's recurring agent work, on a schedule — checking email
// for application updates and searching for new jobs with the confirmed
// brief. The schedule is account-level (users.automations, /me). The daemon
// on the user's computer runs it (so it works with Landed closed) and keeps
// results on that computer until the browser picks them up (task kind
// `automation_sync`): the browser sends the schedule + the context the tasks
// need and acks what it has stored; the daemon answers with finished results
// and its run log. Plain TS, no dependencies.

export const AUTOMATION_KINDS = ['email_check', 'job_search'] as const
export type AutomationKind = typeof AUTOMATION_KINDS[number]

/** Every N hours, or at a time of day on some days of the week (0 = Sunday),
 *  in the computer's local time. */
export type Schedule =
  | { kind: 'interval'; hours: number }
  | { kind: 'daily'; time: string; days: number[] }

export type AutomationConfig = { enabled: boolean; schedule: Schedule }
export type Automations = Record<AutomationKind, AutomationConfig>

export const INTERVAL_HOURS = [1, 2, 4, 8, 12]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS = [1, 2, 3, 4, 5]

export const DEFAULT_AUTOMATIONS: Automations = {
  email_check: { enabled: false, schedule: { kind: 'interval', hours: 4 } },
  job_search: { enabled: false, schedule: { kind: 'daily', time: '09:00', days: ALL_DAYS } },
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
  }
  return out
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

// ── the sync task (browser ⇄ daemon) ──────────────────────────────────────

export type SyncContext = {
  /** for email checks: the applications Landed knows, and where to start reading */
  applications: { company: string; role: string; stage: string }[]
  email_since: string | null
  /** for job searches: the confirmed brief (packages/schema/src/search-brief.ts) */
  brief: unknown | null
  search_id: string | null
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
}

export type AutomationResult = {
  id: string
  kind: AutomationKind
  started_at: string
  finished_at: string
  summary: string
  findings?: unknown[]
  jobs?: unknown[]
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
    },
    run_now: (Array.isArray(r.run_now) ? r.run_now : []).filter(isKind),
    ack: (Array.isArray(r.ack) ? r.ack : []).filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 200),
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
