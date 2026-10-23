// Automation: schedule math, sync validation, and the browser's sync round
// (the computer is mocked: it answers with a finished email check).
import 'fake-indexeddb/auto'
import { describe, expect, test, vi } from 'vitest'
import { cloudAgentSearches, DEFAULT_SEARCH_SOURCES, describeSchedule, isDue, nextRun, parseAutomations, parseSyncInput, parseSyncOutput, pickSearchAgents } from '@landed/schema/automation'
import { createLocalStore } from './store/local'

const syncs: Record<string, unknown>[] = []
let answer: unknown = null
vi.mock('../hooks/runtimes', () => ({
  canRun: (a: { kinds?: string[] }, kind: string) => (a.kinds ?? ['chat']).includes(kind),
  startJob: async (_rt: string, _agent: string, _kind: string, input: Record<string, unknown>) => { syncs.push(input); return 'job-1' },
  followJob: (_id: string, onEvent: (e: unknown) => void) => { setTimeout(() => onEvent({ type: 'done', text: '', output: answer }), 0); return () => {} },
}))
const { designate, requestRecheck, syncAutomations, syncTargets, useAutomationSync } = await import('./automation-sync')

describe('schedules', () => {
  const at = (s: string) => new Date(s)
  test('intervals run every N hours; never run → now', () => {
    const s = { kind: 'interval' as const, hours: 4 }
    expect(isDue(s, null)).toBe(true)
    expect(nextRun(s, '2026-10-13T08:00:00.000Z').toISOString()).toBe('2026-10-13T12:00:00.000Z')
    expect(isDue(s, new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe(false)
  })

  test('daily times: the next matching day; a missed run catches up once', () => {
    const weekdays9 = { kind: 'daily' as const, time: '09:00', days: [1, 2, 3, 4, 5] }
    const friday10 = at('2026-10-16T10:00:00') // local time, a Friday
    expect(nextRun(weekdays9, null, friday10).toString()).toBe(at('2026-10-19T09:00:00').toString()) // Monday
    expect(isDue(weekdays9, at('2026-10-14T09:00:00').toISOString(), friday10)).toBe(true) // missed Thu → due
    const monday = { kind: 'daily' as const, time: '07:30', days: [1] }
    expect(nextRun(monday, null, at('2026-10-13T08:00:00')).getDay()).toBe(1) // weekly: next Monday, not "now"
    expect(describeSchedule(weekdays9)).toBe('Weekdays at 09:00')
    expect(describeSchedule({ kind: 'interval', hours: 1 })).toBe('Every hour')
  })

  test('settings and sync payloads are normalized', () => {
    expect(parseAutomations({ email_check: { enabled: true, schedule: { kind: 'interval', hours: 5 } } }).email_check)
      .toEqual({ enabled: true, schedule: { kind: 'interval', hours: 4 }, readers: { agents: ['claude'], cloud_agents: true, cloud_skip: [] } }) // 5h isn't offered → default
    expect(parseAutomations({ job_search: { enabled: true, schedule: { kind: 'interval', hours: 3 } } }).job_search.schedule)
      .toEqual({ kind: 'interval', hours: 3 }) // Agent search every 3 hours
    expect(parseAutomations(null).job_search.enabled).toBe(false)
    expect(parseAutomations(null).auto_apply).toEqual({ enabled: true, max_concurrent: 5, executor: 'extension' })
    expect(parseAutomations({ auto_apply: { enabled: false, max_concurrent: 2 } }).auto_apply)
      .toEqual({ enabled: false, max_concurrent: 2, executor: 'extension' })
    expect(parseAutomations({ auto_apply: { executor: '11111111-2222-4333-8444-555555555555' } }).auto_apply.executor)
      .toBe('11111111-2222-4333-8444-555555555555')
    expect(parseAutomations({ auto_apply: { executor: 'not-an-agent' } }).auto_apply.executor).toBe('extension')
    expect(parseAutomations({ auto_apply: { enabled: true, max_concurrent: 99 } }).auto_apply.max_concurrent).toBe(5)
    expect(parseSyncInput({ runtime_id: 'nope' })).toBeNull()
    const input = parseSyncInput({ runtime_id: '11111111-2222-4333-8444-555555555555', run_now: ['email_check', 'rm -rf'], ack: ['x'], context: { applications: [{ company: 'A', role: 'PM', stage: 'phone' }] } })!
    expect(input.run_now).toEqual(['email_check'])
    expect(input.ack).toEqual([])
    expect(input.context.applications).toEqual([])
    expect(parseSyncOutput({ results: [{ id: 'bad', kind: 'email_check' }], runs: [{ kind: 'job_search', status: 'weird' }] }))
      .toMatchObject({ results: [], runs: [{ status: 'error' }] })
  })
})

describe('the browser side of a sync', () => {
  const runtime = (id: string, kinds: string[], mail: string | null = null) => ({
    id, name: id, online: true, revoked_at: null, last_seen_at: 'x', created_at: 'x', daemon_version: '0.3.0',
    agents: [{ id: 'claude', label: 'Claude Code', version: '1', kinds, mail }],
  })

  test('the computer that can read mail runs the schedule when email checks are on', () => {
    const rts = [runtime('11111111-0000-4000-8000-000000000001', ['automation_sync']), runtime('11111111-0000-4000-8000-000000000002', ['automation_sync', 'email_check'], 'Gmail')]
    const on = parseAutomations({ email_check: { enabled: true } })
    expect(designate(syncTargets(rts as never), on)!.runtime.id).toBe('11111111-0000-4000-8000-000000000002')
    expect(designate(syncTargets(rts as never), parseAutomations({}))!.runtime.id).toBe('11111111-0000-4000-8000-000000000001')
  })

  test('with portal checks on too, the computer that can also use Chrome wins', () => {
    const mailOnly = runtime('11111111-0000-4000-8000-000000000003', ['automation_sync', 'email_check'], 'Gmail')
    const both = runtime('11111111-0000-4000-8000-000000000004', ['automation_sync', 'email_check', 'portal_check'], 'Gmail')
    const on = parseAutomations({ email_check: { enabled: true }, portal_check: { enabled: true } })
    expect(designate(syncTargets([mailOnly, both] as never), on)!.runtime.id).toBe('11111111-0000-4000-8000-000000000004')
  })

  test('a finished portal check asks before changing a stage', async () => {
    const store = createLocalStore('landed-auto-portal')
    await store.addApplication({ name: 'Figma' }, { role: 'APM', stage: 'applied' })
    const [app] = await store.listApplications()
    const rt = runtime('11111111-0000-4000-8000-00000000000b', ['automation_sync', 'portal_check'])
    answer = {
      results: [{ id: '22222222-0000-4000-8000-000000000002', kind: 'portal_check', started_at: '2026-10-13T10:00:00.000Z', finished_at: '2026-10-13T10:05:00.000Z', summary: '1',
        results: [{ ref: '1', outcome: 'status_found', status: 'rejected', status_text: 'Not selected', confidence: 0.9 }],
        items: [{ ref: '1', application_id: app.id, company: 'Figma' }] }],
      runs: [], state: {},
    }
    await syncAutomations({
      store, runtimes: [rt] as never, automations: parseAutomations({ portal_check: { enabled: true } }), settings: { autoApply: true },
      context: async () => ({ applications: [], email_since: null, brief: null, search_id: null, portal_apps: [] }),
      onStored: async () => { answer = { results: [], runs: [], state: {} } },
    })
    expect((await store.listApplications())[0].stage).toBe('applied') // unchanged until the user says so
    expect(useAutomationSync.getState().stored['22222222-0000-4000-8000-000000000002'].text).toBe('1 needs you')
  })

  test('finished email checks are stored through the processor, then acked', async () => {
    const store = createLocalStore('landed-auto-web')
    await store.addApplication({ name: 'Figma' }, { role: 'APM', stage: 'applied' })
    const rt = runtime('11111111-0000-4000-8000-00000000000a', ['automation_sync', 'email_check'], 'Gmail')
    answer = {
      results: [{ id: '22222222-0000-4000-8000-000000000001', kind: 'email_check', started_at: '2026-10-13T09:00:00.000Z', finished_at: '2026-10-13T09:01:00.000Z', summary: '1',
        findings: [{ company: 'Figma', role: 'APM', status: 'interview', confidence: 0.95, job_url: null, interview_at: '2026-10-20T21:00:00Z', interview_format: 'remote', evidence: { message_id: 'm1', sender_domain: 'figma.com', subject: 'Interview' } }] }],
      runs: [{ id: '22222222-0000-4000-8000-000000000001', kind: 'email_check', started_at: '2026-10-13T09:00:00.000Z', finished_at: '2026-10-13T09:01:00.000Z', status: 'ok', summary: '1 application email', error: null }],
      state: {},
    }
    const stored: string[] = []
    await syncAutomations({
      store, runtimes: [rt] as never, automations: parseAutomations({ email_check: { enabled: true } }), settings: { autoApply: true },
      context: async () => ({ applications: [], email_since: null, brief: null, search_id: null, portal_apps: [] }),
      onStored: async (kind) => { stored.push(kind); answer = { results: [], runs: [], state: {} } },
    })
    const [app] = await store.listApplications()
    expect(app.stage).toBe('interview')
    expect(app.interviews[0]).toMatchObject({ format: 'remote', at: '2026-10-20T21:00:00.000Z' })
    expect(stored).toEqual(['email_check'])
    expect(syncs.at(-1)!.ack).toEqual(['22222222-0000-4000-8000-000000000001'])
    expect(useAutomationSync.getState().stored['22222222-0000-4000-8000-000000000001'].text).toBe('1 updated')
  })
})

describe('connectors: look again when the page is waiting', () => {
  const runtime = (id: string, kinds: string[]) => ({
    id, name: id, online: true, revoked_at: null, last_seen_at: 'x', created_at: 'x', daemon_version: '0.3.0',
    agents: [{ id: 'claude', label: 'Claude Code', version: '1', kinds, mail: null }],
  })
  test('a recheck goes to every computer once, and each one\'s abilities are kept', async () => {
    const store = createLocalStore('landed-auto-recheck')
    const a = runtime('11111111-0000-4000-8000-00000000000c', ['automation_sync'])
    const b = runtime('11111111-0000-4000-8000-00000000000d', ['automation_sync'])
    answer = { results: [], runs: [], state: {}, abilities: { mail: 'confirming', chrome: false, checking: true, checked_at: null } }
    const env = {
      store, runtimes: [a, b] as never, automations: parseAutomations({}), settings: { autoApply: true },
      context: async () => ({ applications: [], email_since: null, brief: null, search_id: null, portal_apps: [] }),
      onStored: async () => {},
    }
    requestRecheck(true)
    expect(useAutomationSync.getState().recheckAt).not.toBeNull() // "Checking…" until a computer has looked
    requestRecheck(true) // a moment later (focus + visibilitychange): not asked twice
    const before = syncs.length
    await syncAutomations(env)
    expect(syncs.slice(before).map((x) => x.recheck)).toEqual([true, true])
    expect(useAutomationSync.getState().abilities[a.id]).toEqual({ mail: 'confirming', chrome: false, checking: true, checked_at: null })
    expect(useAutomationSync.getState().abilities[b.id]?.mail).toBe('confirming')
    await syncAutomations(env)
    expect(syncs.slice(-2).map((x) => x.recheck)).toEqual([false, false]) // asked once
  })

  test('sync payloads carry the recheck and the abilities, validated', () => {
    expect(parseSyncInput({ runtime_id: '11111111-0000-4000-8000-00000000000c', recheck: true })?.recheck).toBe(true)
    expect(parseSyncInput({ runtime_id: '11111111-0000-4000-8000-00000000000c', recheck: 'yes' })?.recheck).toBe(false)
    expect(parseSyncOutput({ abilities: { mail: 'everything', chrome: 1, checking: true, checked_at: 'soon' } }).abilities)
      .toEqual({ mail: 'missing', chrome: false, checking: true, checked_at: null })
    expect(parseSyncOutput({}).abilities).toBeUndefined() // an older computer
  })
})

describe('Find new jobs → Search with', () => {
  test('sources: Claude Code and the free sources by default; stored ones validated', () => {
    expect(parseAutomations({}).job_search.sources).toEqual({ agents: ['claude'], job_lists: true, company_boards: true, cloud_agents: true, cloud_skip: [] })
    const chatgpt = '11111111-2222-4333-8444-555555555555'
    expect(parseAutomations({ job_search: { enabled: true, sources: { agents: ['codex', 'gemini', 'codex', 'Bad Id!', 7], job_lists: false, cloud_agents: 'yes', cloud_skip: [chatgpt, chatgpt, 'nope', 3] } } }).job_search.sources)
      .toEqual({ agents: ['codex', 'gemini'], job_lists: false, company_boards: true, cloud_agents: true, cloud_skip: [chatgpt] })
    expect(parseAutomations({ job_search: { enabled: true, sources: { agents: [] } } }).job_search.sources?.agents).toEqual([])
    expect(parseAutomations({ email_check: { enabled: true, sources: { agents: ['x'] } } }).email_check.sources).toBeUndefined()
  })

  test('who searches: the ticked agents that are here, else the first that can', () => {
    const here = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }]
    expect(pickSearchAgents(here, { ...DEFAULT_SEARCH_SOURCES, agents: ['codex', 'claude'] }).map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(pickSearchAgents(here, { ...DEFAULT_SEARCH_SOURCES, agents: ['codex'] }).map((a) => a.id)).toEqual(['codex'])
    expect(pickSearchAgents(here, { ...DEFAULT_SEARCH_SOURCES, agents: ['gemini'] }).map((a) => a.id)).toEqual(['claude'])
    expect(pickSearchAgents([], DEFAULT_SEARCH_SOURCES)).toEqual([])
  })

  test('who reads email: Claude Code and every cloud agent by default; ticked on their own', () => {
    const chatgpt = '11111111-2222-4333-8444-555555555555'
    expect(parseAutomations({}).email_check.readers).toEqual({ agents: ['claude'], cloud_agents: true, cloud_skip: [] })
    expect(parseAutomations({ email_check: { readers: { agents: [], cloud_skip: [chatgpt, 'x'] } } }).email_check.readers)
      .toEqual({ agents: [], cloud_agents: true, cloud_skip: [chatgpt] })
    expect(parseAutomations({ job_search: { enabled: true } }).job_search.readers).toBeUndefined()
  })

  test('every agent unticked is none, not the first that can', () => {
    const here = [{ id: 'claude', label: 'Claude Code' }]
    expect(pickSearchAgents(here, { ...DEFAULT_SEARCH_SOURCES, agents: [] })).toEqual([])
  })

  test('each cloud agent searches unless it was unticked, or all were', () => {
    const chatgpt = '11111111-2222-4333-8444-555555555555'
    const claudeAi = '66666666-7777-4888-9999-000000000000'
    expect(cloudAgentSearches(DEFAULT_SEARCH_SOURCES, chatgpt)).toBe(true)
    expect(cloudAgentSearches({ ...DEFAULT_SEARCH_SOURCES, cloud_skip: [chatgpt] }, chatgpt)).toBe(false)
    expect(cloudAgentSearches({ ...DEFAULT_SEARCH_SOURCES, cloud_skip: [chatgpt] }, claudeAi)).toBe(true)
    expect(cloudAgentSearches({ ...DEFAULT_SEARCH_SOURCES, cloud_agents: false }, claudeAi)).toBe(false)
  })
})
