// Automation on this computer: Landed's recurring agent work (email checks,
// job searches) on the schedule the user set — so it runs with Landed
// closed. Results wait here (~/.landed/automations.json) until the browser
// syncs (task `automation_sync`): it acks what it stored, and the daemon
// drops those. Only the computer the browser names runs the schedule, so
// two daemons never double up. Shapes + schedule math:
// packages/schema/src/automation.ts.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTOMATION_KINDS, isDue, nextRun, parseAutomations, pickQuietPortals,
  type AutomationKind, type AutomationResult, type AutomationRun, type Automations, type SyncContext, type SyncInput, type SyncOutput,
} from '@landed/schema/automation'
import { home } from './config.ts'
import type { Task, TaskEvent } from './agents.ts'

type State = {
  /** the pairing this state belongs to (this computer's runtime id): a new
   *  pairing — another account or server — starts from nothing, so it
   *  neither continues the old account's email window nor gets its results */
  owner: string | null
  /** the computer that runs the schedule */
  runtime_id: string | null
  automations: Automations | null
  context: SyncContext | null
  last_success: Partial<Record<AutomationKind, string>>
  /** set when a run fails; cleared on success (failures retry after RETRY_MS) */
  last_failure: Partial<Record<AutomationKind, string>>
  outbox: AutomationResult[]
  runs: AutomationRun[]
  /** application id → when a portal check last looked at it */
  portal_checked: Record<string, string>
}

const RETRY_MS = 30 * 60_000
const MAX_OUTBOX = 50
const MAX_RUNS = 30
const FIRST_EMAIL_LOOKBACK_MS = 30 * 86_400_000
const EMAIL_OVERLAP_MS = 3_600_000

const file = () => join(home(), 'automations.json')
const empty = (): State => ({ owner: null, runtime_id: null, automations: null, context: null, last_success: {}, last_failure: {}, outbox: [], runs: [], portal_checked: {} })

function load(): State {
  try {
    const st: State = existsSync(file()) ? { ...empty(), ...JSON.parse(readFileSync(file(), 'utf8')) } : empty()
    // Saved by an older daemon: fill in automations added since.
    if (st.automations) st.automations = parseAutomations(st.automations)
    return st
  } catch {
    return empty()
  }
}

let state: State | null = null
const s = () => (state ??= load())
function save() {
  writeFileSync(file(), JSON.stringify(s(), null, 2), { mode: 0o600 })
  chmodSync(file(), 0o600) // it holds the user's application list
}

let myRuntimeId: string | null = null
let runTaskFn: ((task: Task, emit: (e: TaskEvent) => void) => Promise<void>) | null = null
let pickAgent: (kind: AutomationKind) => string | null = () => 'claude'
let log: (msg: string) => void = () => {}
const running = new Set<AutomationKind>()

/** Wire up (cli.ts): this computer's runtime id (from hello), how to run a
 *  task and with which agent here, logging. */
export function setupAutomations(opts: {
  runtimeId: string; runTask: typeof runTaskFn; log: (msg: string) => void; pickAgent?: (kind: AutomationKind) => string | null
}) {
  myRuntimeId = opts.runtimeId
  runTaskFn = opts.runTask
  log = opts.log
  if (opts.pickAgent) pickAgent = opts.pickAgent
  const st = s()
  if (st.owner !== opts.runtimeId) {
    if (st.owner) {
      log('automation: this computer was paired again — starting the schedule fresh')
      state = empty()
    }
    s().owner = opts.runtimeId
    save()
  }
}

function output(): SyncOutput {
  const st = s()
  const out: SyncOutput = { results: st.outbox.slice(0, 10), runs: st.runs.slice(0, 20), state: {} }
  for (const kind of AUTOMATION_KINDS) {
    const a = st.automations?.[kind]
    out.state[kind] = {
      last_success_at: st.last_success[kind] ?? null,
      next_run_at: a?.enabled && st.runtime_id === myRuntimeId ? nextRun(a.schedule, st.last_success[kind]).toISOString() : null,
      running: running.has(kind),
    }
  }
  return out
}

/** The browser's sync: new settings + context in, finished results out. */
export function handleSync(input: SyncInput): SyncOutput {
  const st = s()
  st.outbox = st.outbox.filter((r) => !input.ack.includes(r.id))
  st.runtime_id = input.runtime_id
  st.automations = parseAutomations(input.automations)
  st.context = input.context
  save()
  if (input.runtime_id === myRuntimeId) {
    for (const kind of input.run_now) void runAutomation(kind, kind === 'email_check' && input.email_rescan_days ? { rescanDays: input.email_rescan_days } : {})
  }
  return output()
}

/** Called every minute: start whatever is due. */
export function tick() {
  const st = s()
  if (!st.automations || !st.context || st.runtime_id !== myRuntimeId) return
  for (const kind of AUTOMATION_KINDS) {
    const a = st.automations[kind]
    if (!a.enabled || running.has(kind) || !isDue(a.schedule, st.last_success[kind])) continue
    const failed = st.last_failure[kind]
    if (failed && Date.now() - Date.parse(failed) < RETRY_MS) continue
    if (st.outbox.length >= MAX_OUTBOX) continue // nobody has picked results up in a long while
    void runAutomation(kind)
  }
}

type Planned =
  | { input: Record<string, unknown>; items?: AutomationResult['items'] }
  | { error: string }
  /** nothing to do this time (not a failure) */
  | { skip: string }

type RunOptions = { rescanDays?: number }

function inputFor(kind: AutomationKind, ctx: SyncContext, st: State, opts: RunOptions = {}): Planned {
  if (kind === 'email_check') {
    // From where the last check started (an hour of overlap), so windows
    // never leave a gap; or further back when the user asks to re-read.
    const last = st.last_success.email_check
    const since = opts.rescanDays ? new Date(Date.now() - opts.rescanDays * 86_400_000)
      : last ? new Date(Date.parse(last) - EMAIL_OVERLAP_MS)
      : ctx.email_since ? new Date(ctx.email_since) : new Date(Date.now() - FIRST_EMAIL_LOOKBACK_MS)
    return { input: { since: since.toISOString(), applications: ctx.applications } }
  }
  if (kind === 'portal_check') {
    const quiet = st.automations?.portal_check.quiet_days ?? 14
    const picked = pickQuietPortals(ctx.portal_apps ?? [], quiet, st.portal_checked ?? {})
    if (picked.length === 0) return { skip: `No application with a portal link has gone ${quiet} days without news.` }
    // The agent sees refs, never application ids.
    const items = picked.map((a, i) => ({ ref: String(i + 1), application_id: a.id, company: a.company }))
    return { input: { items: picked.map((a, i) => ({ ref: String(i + 1), company: a.company, role: a.role, stage: a.stage, url: a.url })) }, items }
  }
  if (!ctx.brief || !ctx.search_id) return { error: 'No search direction yet — confirm one with your agent first.' }
  return { input: { brief: ctx.brief, search_id: ctx.search_id } }
}

const PAYLOAD: Record<AutomationKind, 'findings' | 'jobs' | 'results'> = { email_check: 'findings', job_search: 'jobs', portal_check: 'results' }

/** "Oct 13, 1:20 PM" in this computer's time zone (the user's). */
const localTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function describeRun(kind: AutomationKind, n: number, input: Record<string, unknown>) {
  const s = n === 1 ? '' : 's'
  if (kind === 'email_check') return `${n} application email${s} since ${localTime(String(input.since))}`
  if (kind === 'portal_check') return `${n} portal${s} checked`
  return `${n} job${s}`
}

async function runAutomation(kind: AutomationKind, opts: RunOptions = {}) {
  const st = s()
  if (running.has(kind) || !st.context || !runTaskFn) return
  const id = randomUUID()
  const started = new Date().toISOString()
  const run: AutomationRun = { id, kind, started_at: started, finished_at: null, status: 'running', summary: null, error: null }
  st.runs = [run, ...st.runs].slice(0, MAX_RUNS)
  const agent = pickAgent(kind)
  const plan: Planned = agent ? inputFor(kind, st.context, st, opts) : {
    error: kind === 'email_check' ? 'No agent on this computer can read your email (Claude Code with a Gmail connector can).'
      : kind === 'portal_check' ? "No agent on this computer can use Chrome (Claude Code with Claude in Chrome can)."
      : 'No agent on this computer can search for jobs.',
  }
  if ('error' in plan) {
    Object.assign(run, { status: 'error', error: plan.error, finished_at: started })
    st.last_failure[kind] = started
    save()
    return
  }
  if ('skip' in plan) {
    // Nothing to look at is a successful run: the schedule moves on.
    Object.assign(run, { status: 'ok', summary: plan.skip, finished_at: started })
    st.last_success[kind] = started
    delete st.last_failure[kind]
    save()
    return
  }
  const input = plan.input
  running.add(kind)
  save()
  log(`automation: ${kind} started`)
  let end: TaskEvent | null = null
  try {
    await runTaskFn({ id, agent: agent!, kind, input }, (e) => { if (e.type === 'done' || e.type === 'error') end = e })
  } finally {
    running.delete(kind)
  }
  const finished = new Date().toISOString()
  run.finished_at = finished
  const e = end as TaskEvent | null
  const payload = e?.type === 'done' ? e[PAYLOAD[kind]] : undefined
  if (e?.type === 'done' && Array.isArray(payload)) {
    st.last_success[kind] = started
    delete st.last_failure[kind]
    st.outbox.push({ id, kind, started_at: started, finished_at: finished, summary: e.text, [PAYLOAD[kind]]: payload, ...(plan.items ? { items: plan.items } : {}) })
    for (const item of plan.items ?? []) (st.portal_checked ??= {})[item.application_id] = finished
    run.status = 'ok'
    run.summary = describeRun(kind, kind === 'portal_check' ? plan.items?.length ?? payload.length : payload.length, input)
  } else {
    st.last_failure[kind] = finished
    run.status = 'error'
    run.error = e?.type === 'error' ? e.message : 'The agent finished without results.'
  }
  save()
  log(`automation: ${kind} ${run.status}${run.summary ? ` — ${run.summary}` : run.error ? ` — ${run.error}` : ''}`)
}

/** For tests: forget everything, on disk too. */
export function resetAutomationsForTests() {
  rmSync(file(), { force: true })
  state = null
  myRuntimeId = null
  pickAgent = () => 'claude'
  running.clear()
}
