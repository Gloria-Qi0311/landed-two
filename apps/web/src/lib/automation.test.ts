// Automation: schedule math, sync validation, and the browser's sync round
// (the computer is mocked: it answers with a finished email check).
import 'fake-indexeddb/auto'
import { describe, expect, test, vi } from 'vitest'
import { describeSchedule, isDue, nextRun, parseAutomations, parseSyncInput, parseSyncOutput } from '@landed/schema/automation'
import { createLocalStore } from './store/local'

const syncs: Record<string, unknown>[] = []
let answer: unknown = null
vi.mock('../hooks/runtimes', () => ({
  canRun: (a: { kinds?: string[] }, kind: string) => (a.kinds ?? ['chat']).includes(kind),
  startJob: async (_rt: string, _agent: string, _kind: string, input: Record<string, unknown>) => { syncs.push(input); return 'job-1' },
  followJob: (_id: string, onEvent: (e: unknown) => void) => { setTimeout(() => onEvent({ type: 'done', text: '', output: answer }), 0); return () => {} },
}))
const { designate, syncAutomations, syncTargets, useAutomationSync } = await import('./automation-sync')

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
    expect(parseAutomations({ email_check: { enabled: true, schedule: { kind: 'interval', hours: 3 } } }).email_check)
      .toEqual({ enabled: true, schedule: { kind: 'interval', hours: 4 } }) // 3h isn't offered → default
    expect(parseAutomations(null).job_search.enabled).toBe(false)
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
      context: async () => ({ applications: [], email_since: null, brief: null, search_id: null }),
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
