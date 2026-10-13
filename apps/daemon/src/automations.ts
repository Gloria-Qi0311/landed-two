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
  AUTOMATION_KINDS, isDue, nextRun,
  type AutomationKind, type AutomationResult, type AutomationRun, type Automations, type SyncContext, type SyncInput, type SyncOutput,
} from '@landed/schema/automation'
import { home } from './config.ts'
import type { Task, TaskEvent } from './agents.ts'

type State = {
  /** the computer that runs the schedule */
  runtime_id: string | null
  automations: Automations | null
  context: SyncContext | null
  last_success: Partial<Record<AutomationKind, string>>
  /** set when a run fails; cleared on success (failures retry after RETRY_MS) */
  last_failure: Partial<Record<AutomationKind, string>>
  outbox: AutomationResult[]
  runs: AutomationRun[]
}

const RETRY_MS = 30 * 60_000
const MAX_OUTBOX = 50
const MAX_RUNS = 30
const FIRST_EMAIL_LOOKBACK_MS = 30 * 86_400_000
const EMAIL_OVERLAP_MS = 3_600_000

const file = () => join(home(), 'automations.json')
const empty = (): State => ({ runtime_id: null, automations: null, context: null, last_success: {}, last_failure: {}, outbox: [], runs: [] })

function load(): State {
  try {
    return existsSync(file()) ? { ...empty(), ...JSON.parse(readFileSync(file(), 'utf8')) } : empty()
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
let log: (msg: string) => void = () => {}
const running = new Set<AutomationKind>()

/** Wire up (cli.ts): this computer's runtime id (from hello), how to run a task, logging. */
export function setupAutomations(opts: { runtimeId: string; runTask: typeof runTaskFn; log: (msg: string) => void }) {
  myRuntimeId = opts.runtimeId
  runTaskFn = opts.runTask
  log = opts.log
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
  st.automations = input.automations
  st.context = input.context
  save()
  if (input.runtime_id === myRuntimeId) for (const kind of input.run_now) void runAutomation(kind)
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

function inputFor(kind: AutomationKind, ctx: SyncContext, st: State): Record<string, unknown> | string {
  if (kind === 'email_check') {
    const last = st.last_success.email_check
    const since = last ? new Date(Date.parse(last) - EMAIL_OVERLAP_MS) : ctx.email_since ? new Date(ctx.email_since) : new Date(Date.now() - FIRST_EMAIL_LOOKBACK_MS)
    return { since: since.toISOString(), applications: ctx.applications }
  }
  if (!ctx.brief || !ctx.search_id) return 'No search direction yet — confirm one with your agent first.'
  return { brief: ctx.brief, search_id: ctx.search_id }
}

async function runAutomation(kind: AutomationKind) {
  const st = s()
  if (running.has(kind) || !st.context || !runTaskFn) return
  const id = randomUUID()
  const started = new Date().toISOString()
  const run: AutomationRun = { id, kind, started_at: started, finished_at: null, status: 'running', summary: null, error: null }
  st.runs = [run, ...st.runs].slice(0, MAX_RUNS)
  const input = inputFor(kind, st.context, st)
  if (typeof input === 'string') {
    Object.assign(run, { status: 'error', error: input, finished_at: started })
    st.last_failure[kind] = started
    save()
    return
  }
  running.add(kind)
  save()
  log(`automation: ${kind} started`)
  let end: TaskEvent | null = null
  try {
    await runTaskFn({ id, agent: 'claude', kind, input }, (e) => { if (e.type === 'done' || e.type === 'error') end = e })
  } finally {
    running.delete(kind)
  }
  const finished = new Date().toISOString()
  run.finished_at = finished
  const e = end as TaskEvent | null
  const payload = e?.type === 'done' ? (kind === 'email_check' ? e.findings : e.jobs) : undefined
  if (e?.type === 'done' && Array.isArray(payload)) {
    st.last_success[kind] = started
    delete st.last_failure[kind]
    st.outbox.push({ id, kind, started_at: started, finished_at: finished, summary: e.text, ...(kind === 'email_check' ? { findings: payload } : { jobs: payload }) })
    run.status = 'ok'
    run.summary = kind === 'email_check'
      ? `${payload.length} application email${payload.length === 1 ? '' : 's'}`
      : `${payload.length} job${payload.length === 1 ? '' : 's'}`
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
  running.clear()
}
