import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.LANDED_HOME = mkdtempSync(join(tmpdir(), 'landed-auto-'))
const { handleSync, resetAutomationsForTests, setupAutomations, tick } = await import('../src/automations.ts')

const automations = {
  email_check: { enabled: true, schedule: { kind: 'interval' as const, hours: 4 } },
  job_search: { enabled: false, schedule: { kind: 'daily' as const, time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
}
const context = { applications: [{ company: 'Figma', role: 'APM', stage: 'applied' }], email_since: '2026-10-01T00:00:00.000Z', brief: null, search_id: null }
const sync = (over: Record<string, unknown> = {}) => handleSync({ runtime_id: 'rt-a', automations, context, run_now: [], ack: [], ...over } as never)
const settle = () => new Promise((r) => setTimeout(r, 30))

test('runs what is due on the named computer, keeps results until acked', async () => {
  resetAutomationsForTests()
  const calls: { kind: string; input: Record<string, unknown> }[] = []
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    runTask: async (task, emit) => { calls.push(task); emit({ type: 'done', text: '2 updates', findings: [{ company: 'Figma', status: 'interview' }, { company: 'Stripe', status: 'applied' }] }) },
  })
  const first = sync()
  assert.ok(first.state.email_check?.next_run_at, 'never ran → due now')
  assert.equal(first.state.job_search?.next_run_at, null, 'disabled')
  tick()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'email_check')
  assert.equal(calls[0].input.since, '2026-10-01T00:00:00.000Z', 'first run reads from where the browser left off')
  tick()
  await settle()
  assert.equal(calls.length, 1, 'not due again for 4 hours')

  const out = sync()
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].findings?.length, 2)
  assert.equal(out.runs[0].status, 'ok')
  assert.match(out.runs[0].summary ?? '', /^2 application emails since \w{3} \d+, \d+:\d\d [AP]M$/) // the window read, in local time
  assert.ok(Date.parse(out.state.email_check!.next_run_at!) - Date.now() > 3.9 * 3_600_000)
  assert.equal(sync({ ack: [out.results[0].id] }).results.length, 0, 'acked results are dropped')
  assert.equal(statSync(join(process.env.LANDED_HOME!, 'automations.json')).mode & 0o777, 0o600)
})

test('another computer only keeps the settings; failures retry later; "run now" runs at once', async () => {
  resetAutomationsForTests()
  let fail = true
  const calls: string[] = []
  setupAutomations({
    runtimeId: 'rt-b', log: () => {},
    runTask: async (task, emit) => { calls.push(task.kind); emit(fail ? { type: 'error', message: "couldn't load Gmail" } : { type: 'done', text: '', jobs: [{ company: 'Acme', title: 'APM' }] }) },
  })
  sync({ runtime_id: 'rt-a' })
  tick()
  await settle()
  assert.equal(calls.length, 0, 'rt-a runs the schedule, not rt-b')

  sync({ runtime_id: 'rt-b', automations: { ...automations, email_check: { ...automations.email_check, enabled: true } } })
  tick()
  await settle()
  assert.deepEqual(calls, ['email_check'])
  tick()
  await settle()
  assert.equal(calls.length, 1, 'a failed run waits 30 minutes before retrying')

  fail = false
  const withBrief = { ...context, brief: { roles: ['APM'] }, search_id: '11111111-2222-4333-8444-555555555555' }
  sync({ runtime_id: 'rt-b', context: withBrief, run_now: ['job_search'] })
  await settle()
  assert.deepEqual(calls, ['email_check', 'job_search'])
  const out = sync({ runtime_id: 'rt-b', context: withBrief })
  assert.equal(out.results.find((r) => r.kind === 'job_search')?.jobs?.length, 1)
  assert.equal(out.runs.find((r) => r.kind === 'email_check')?.status, 'error')
})

test('portal checks: only quiet applications, refs not ids, not again until they are quiet again', async () => {
  resetAutomationsForTests()
  const calls: { kind: string; input: Record<string, unknown> }[] = []
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    runTask: async (task, emit) => { calls.push(task); emit({ type: 'done', text: '', results: [{ ref: '1', outcome: 'status_found', status: 'rejected' }] }) },
  })
  const day = 86_400_000
  const app = (id: string, company: string, daysQuiet: number) => ({
    id, company, role: 'APM', stage: 'applied', url: `https://jobs.example/${company}`, last_signal_at: new Date(Date.now() - daysQuiet * day).toISOString(),
  })
  const quietId = '11111111-1111-4111-8111-111111111111'
  const portalAutomations = {
    ...automations, email_check: { ...automations.email_check, enabled: false },
    portal_check: { enabled: true, schedule: { kind: 'daily' as const, time: '10:00', days: [1] }, quiet_days: 14 },
  }
  const ctx = { ...context, portal_apps: [app(quietId, 'Figma', 20), app('22222222-2222-4222-8222-222222222222', 'Stripe', 3)] }
  sync({ automations: portalAutomations, context: ctx, run_now: ['portal_check'] })
  await settle()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { items: [{ ref: '1', company: 'Figma', role: 'APM', stage: 'applied', url: 'https://jobs.example/Figma' }] })
  const out = sync({ automations: portalAutomations, context: ctx })
  assert.deepEqual(out.results[0].items, [{ ref: '1', application_id: quietId, company: 'Figma' }])
  assert.equal(out.results[0].results?.length, 1)
  assert.equal(out.runs[0].summary, '1 portal checked')

  // Looked at just now: not again this week, and nothing else is quiet.
  sync({ automations: portalAutomations, context: ctx, run_now: ['portal_check'], ack: [out.results[0].id] })
  await settle()
  assert.equal(calls.length, 1)
  const after = sync({ automations: portalAutomations, context: ctx })
  assert.equal(after.runs[0].status, 'ok')
  assert.match(after.runs[0].summary ?? '', /No application/)
  assert.equal(after.results.length, 0)
})

test('re-reading: "run now" with email_rescan_days reads that far back once', async () => {
  resetAutomationsForTests()
  const calls: { kind: string; input: Record<string, unknown> }[] = []
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    runTask: async (task, emit) => { calls.push(task); emit({ type: 'done', text: '', findings: [] }) },
  })
  sync({ run_now: ['email_check'] })
  await settle()
  sync({ run_now: ['email_check'], email_rescan_days: 30 })
  await settle()
  assert.equal(calls.length, 2)
  const back = (i: number) => (Date.now() - Date.parse(String(calls[i].input.since))) / 86_400_000
  assert.ok(back(1) > 29.9 && back(1) < 30.1, 'the re-read goes 30 days back')
  sync({ run_now: ['email_check'] })
  await settle()
  assert.ok(back(2) < 1.1, 'and the next check continues from the last one')
})

test('a new pairing starts fresh: no old results, runs or email window', async () => {
  resetAutomationsForTests()
  const calls: { kind: string; input: Record<string, unknown> }[] = []
  const runTask = async (task: { kind: string; input: Record<string, unknown> }, emit: (e: never) => void) => {
    calls.push(task)
    emit({ type: 'done', text: '', findings: [{ company: 'Figma', status: 'interview' }] } as never)
  }
  setupAutomations({ runtimeId: 'rt-a', log: () => {}, runTask: runTask as never })
  sync({ run_now: ['email_check'] })
  await settle()
  assert.equal(sync().results.length, 1, 'a result waits for the old account')

  // Paired to another account (new runtime id): its browser sends its own context.
  setupAutomations({ runtimeId: 'rt-new', log: () => {}, runTask: runTask as never })
  const out = handleSync({ runtime_id: 'rt-new', automations, context: { ...context, email_since: null }, run_now: ['email_check'], ack: [] } as never)
  assert.equal(out.results.length, 0, "the old account's results never reach the new one")
  assert.equal(out.runs.filter((r: { status: string }) => r.status !== 'running').length, 0)
  await settle()
  const back = (Date.now() - Date.parse(String(calls[1].input.since))) / 86_400_000
  assert.ok(back > 29, 'a new account reads 30 days back, not from the old account\'s last check')
})

test('Find new jobs searches with each agent chosen on the Automation page that is here, one after another', async () => {
  resetAutomationsForTests()
  const calls: string[] = []
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    agentsFor: () => [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'gemini', label: 'Gemini CLI' }],
    runTask: async (task, emit) => { calls.push(task.agent); emit({ type: 'done', text: '', jobs: [{ company: 'Acme', title: 'APM' }] }) },
  })
  const withBrief = { ...context, brief: { roles: ['APM'] }, search_id: '11111111-2222-4333-8444-555555555555' }
  const search = (agents: string[]) => ({
    ...automations, email_check: { ...automations.email_check, enabled: false },
    job_search: { ...automations.job_search, enabled: true, sources: { agents, job_lists: true, company_boards: true, cloud_agents: true } },
  })
  sync({ automations: search(['claude', 'codex', 'copilot']), context: withBrief, run_now: ['job_search'] })
  await settle()
  assert.deepEqual(calls, ['claude', 'codex'], 'the chosen ones that are on this computer; copilot is not')
  const out = sync({ automations: search(['claude', 'codex', 'copilot']), context: withBrief })
  assert.equal(out.results.filter((r) => r.kind === 'job_search').length, 2, 'one result per agent; the browser merges them')
  assert.deepEqual(out.runs.filter((r) => r.kind === 'job_search').map((r) => r.summary).sort(), ['1 job · Claude Code', '1 job · Codex'])

  // None of the chosen ones here: the first that can search still does.
  calls.length = 0
  sync({ automations: search(['copilot']), context: withBrief, run_now: ['job_search'] })
  await settle()
  assert.deepEqual(calls, ['claude'])
})

test('a page waiting for a connector makes every computer look again, and hears what they reach', () => {
  resetAutomationsForTests()
  let rechecks = 0
  setupAutomations({
    runtimeId: 'rt-b', log: () => {}, runTask: async () => {},
    recheck: () => { rechecks++ },
    abilities: () => ({ mail: 'confirming', chrome: false, checking: true, checked_at: null }),
  })
  const out = sync({ runtime_id: 'rt-a', recheck: true }) // rt-b doesn't run the schedule, and still looks
  assert.equal(rechecks, 1)
  assert.deepEqual(out.abilities, { mail: 'confirming', chrome: false, checking: true, checked_at: null })
  sync({ runtime_id: 'rt-a' })
  assert.equal(rechecks, 1, 'only when asked')
})
