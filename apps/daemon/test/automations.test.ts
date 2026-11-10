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

test('a re-read asked for while a check is running runs right after it, with the context sent since (never dropped)', async () => {
  resetAutomationsForTests()
  const calls: { input: Record<string, unknown> }[] = []
  let release: () => void = () => {}
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    runTask: async (task, emit) => {
      calls.push(task)
      // The first check is still reading when the import asks to re-read.
      if (calls.length === 1) await new Promise<void>((r) => { release = r })
      emit({ type: 'done', text: '', findings: [] })
    },
  })
  sync({ run_now: ['email_check'] })
  await settle()
  assert.equal(calls.length, 1)
  // The import: its applications in the context, and a re-read 30 days back.
  const imported = { ...context, applications: [...context.applications, { company: 'Bluefin Analytics', role: 'Product Analyst', stage: 'applied' }] }
  sync({ context: imported, run_now: ['email_check'], email_rescan_days: 10 })
  sync({ context: imported, run_now: ['email_check'], email_rescan_days: 30 })
  await settle()
  assert.equal(calls.length, 1, 'not two checks at once')
  release()
  await settle()
  assert.equal(calls.length, 2, 'the re-read runs right after, once')
  const back = (Date.now() - Date.parse(String(calls[1].input.since))) / 86_400_000
  assert.ok(back > 29.9 && back < 30.1, 'as far back as the further request')
  assert.deepEqual((calls[1].input.applications as { company: string }[]).map((a) => a.company), ['Figma', 'Bluefin Analytics'], 'with the imported applications')
  await settle()
  assert.equal(calls.length, 2, 'and nothing more after it')
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

test('Find new jobs searches with each agent chosen on the Workflow page that is here, one after another', async () => {
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
    job_search: { ...automations.job_search, enabled: true, sources: { agents, job_lists: true, company_boards: true } },
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

  // Every agent unticked: a schedule does nothing here. An explicit Run now
  // without a one-time executor reports the problem instead of disappearing.
  calls.length = 0
  const logged = sync({ automations: search([]), context: withBrief }).runs.length
  sync({ automations: search([]), context: withBrief, run_now: ['job_search'] })
  await settle()
  assert.deepEqual(calls, [], 'not the first that can')
  const none = sync({ automations: search([]), context: withBrief })
  assert.equal(none.runs.length, logged + 1)
  assert.equal(none.runs[0].status, 'error')
  assert.match(String(none.runs[0].error), /Run now couldn't start/)

  // The button can grant a computer agent a one-time run without changing
  // the empty recurring schedule selection.
  sync({ automations: search([]), context: withBrief, run_now: ['job_search'], run_now_agents: { job_search: ['codex'] } })
  await settle()
  assert.deepEqual(calls, ['codex'])
})

test('Check email is read by the agent ticked here; none ticked means nobody reads it', async () => {
  resetAutomationsForTests()
  const calls: string[] = []
  setupAutomations({
    runtimeId: 'rt-a', log: () => {},
    agentsFor: (kind) => (kind === 'email_check' ? [{ id: 'claude', label: 'Claude Code' }] : []),
    runTask: async (task, emit) => { calls.push(task.agent); emit({ type: 'done', text: '', findings: [] }) },
  })
  const readBy = (agents: string[]) => ({ ...automations, email_check: { ...automations.email_check, readers: { agents } } })
  sync({ automations: readBy(['claude']), run_now: ['email_check'] })
  await settle()
  assert.deepEqual(calls, ['claude'])
  calls.length = 0
  const logged = sync({ automations: readBy([]) }).runs.length
  sync({ automations: readBy([]), run_now: ['email_check'] })
  await settle()
  assert.deepEqual(calls, [], 'not the first that can')
  const missing = sync({ automations: readBy([]) })
  assert.equal(missing.runs.length, logged + 1)
  assert.match(String(missing.runs[0].error), /Run now couldn't start/)

  sync({ automations: readBy([]), run_now: ['email_check'], run_now_agents: { email_check: ['claude'] } })
  await settle()
  assert.deepEqual(calls, ['claude'], 'a one-time explicit reader works without changing the schedule')
})

test('a page waiting for a connector makes every computer look again, and hears what they reach', () => {
  resetAutomationsForTests()
  let rechecks = 0
  setupAutomations({
    runtimeId: 'rt-b', log: () => {}, runTask: async () => {},
    recheck: () => { rechecks++ },
    abilities: () => ({ mail: 'confirming', checking: true, checked_at: null }),
  })
  const out = sync({ runtime_id: 'rt-a', recheck: true }) // rt-b doesn't run the schedule, and still looks
  assert.equal(rechecks, 1)
  assert.deepEqual(out.abilities, { mail: 'confirming', checking: true, checked_at: null })
  sync({ runtime_id: 'rt-a' })
  assert.equal(rechecks, 1, 'only when asked')
})
