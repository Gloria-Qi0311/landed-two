// Local store (IndexedDB) behaviour. Runs on fake-indexeddb; each test gets
// a fresh database name so state never leaks between tests.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { createLocalStore } from './local'
import { BACKUP_FORMAT, snapshotRowCount } from './types'

let n = 0
const fresh = () => createLocalStore(`landed-test-${++n}`)

describe('applications + companies', () => {
  test('addApplication finds-or-creates the company and fills defaults', async () => {
    const store = fresh()
    const a = await store.addApplication({ name: 'Stripe', hue: 250, logo_chars: 'St' }, { role: 'PM' })
    const b = await store.addApplication({ name: ' Stripe ' }, { role: 'Senior PM', stage: 'applied' })
    expect(b.company_id).toBe(a.company_id)
    expect(a).toMatchObject({ stage: 'saved', referral: false, starred: false, notes: null, user_id: 'local' })
    expect(await store.listCompanies()).toHaveLength(1)
    const list = await store.listApplications()
    expect(list.map((r) => r.role)).toEqual(['Senior PM', 'PM'])
  })

  test('rejects values the server would reject', async () => {
    const store = fresh()
    await expect(store.addApplication({ name: 'X' }, { role: 'r', stage: 'bogus' })).rejects.toThrow(/stage/)
    await expect(store.addApplication({ name: '' }, { role: 'r' })).rejects.toThrow(/company name/)
    await expect(store.addApplication({ name: 'X', logo_chars: 'XYZ' }, { role: 'r' })).rejects.toThrow(/logo_chars/)
    expect(await store.isEmpty()).toBe(true)
  })

  test('updateApplication whitelists fields and bumps last_activity_at', async () => {
    const store = fresh()
    const a = await store.addApplication({ name: 'Figma' }, { role: 'Designer', last_activity_at: '2020-01-01T00:00:00.000Z' })
    const next = await store.updateApplication(a.id, { stage: 'onsite', company_id: 'evil' } as never)
    expect(next.stage).toBe('onsite')
    expect(next.company_id).toBe(a.company_id)
    expect(next.last_activity_at > a.last_activity_at).toBe(true)
    await expect(store.updateApplication('nope', { stage: 'offer' })).rejects.toMatchObject({ status: 404 })
  })

  test('importDemo maps applications to companies by name', async () => {
    const store = fresh()
    const res = await store.importDemo({
      companies: [{ name: 'Linear' }, { name: 'Ramp' }],
      applications: [
        { company_name: 'Linear', role: 'Eng' },
        { company_name: 'Ramp', role: 'Ops', starred: true },
        { company_name: 'Unknown', role: 'skipped' },
      ],
    })
    expect(res).toEqual({ companies: 2, applications: 2 })
  })
})

describe('resumes', () => {
  test('at most one current resume', async () => {
    const store = fresh()
    const a = await store.addResume({ name: 'A', parsed_json: null, set_current: true })
    await store.addResume({ name: 'B', parsed_json: null, set_current: true })
    const current = async () => (await store.listResumes()).filter((r) => r.is_current).map((r) => r.name)
    expect(await current()).toEqual(['B'])
    await store.setCurrentResume(a.id)
    expect(await current()).toEqual(['A'])
    expect((await store.updateResume(a.id, { name: 'A2' })).name).toBe('A2')
    await store.deleteResume(a.id)
    expect(await current()).toEqual([])
  })
})

describe('portal sync', () => {
  test('connection upsert is keyed on (company, provider)', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Ramp' }, { role: 'Ops' })
    const one = await store.upsertPortalConnection({ company_id: app.company_id, provider: 'greenhouse' })
    const two = await store.upsertPortalConnection({ company_id: app.company_id, provider: 'greenhouse', status: 'expired' })
    expect(two.id).toBe(one.id)
    expect(two.status).toBe('expired')
    expect(await store.listPortalConnections()).toHaveLength(1)
    await expect(store.upsertPortalConnection({ company_id: 'missing', provider: 'lever' })).rejects.toThrow(/company_id/)
  })

  test('events are stored, ordered newest first, and emitted live', async () => {
    const store = fresh()
    const seen: string[] = []
    const off = store.subscribePortalEvents((row) => seen.push(row.type))
    await store.addPortalEvents([{ type: 'sync' }, { type: 'rejection', payload_json: { company: 'X' } }])
    off()
    await store.addPortalEvents([{ type: 'expired' }])
    expect(seen).toEqual(['sync', 'rejection'])
    expect((await store.listPortalEvents(10)).map((e) => e.type)[0]).toBe('expired')
    await expect(store.addPortalEvents([{ type: 'nope' as never }])).rejects.toThrow(/type/)
    await expect(store.addPortalEvents([{ type: 'sync', application_id: 'missing' }])).rejects.toThrow(/application_id/)
  })
})

describe('agent observations (relay inbox)', () => {
  const observation = (id: string, key: string) => ({
    id, user_id: 'server-user', connection_id: 'conn-1', idempotency_key: key, schema_version: '0.1',
    run_id: 'run-1', observation_type: 'job_discovered', observed_at: '2026-10-09T12:00:00Z',
    payload_json: { payload: { title: 'PM', company: 'Acme' } }, payload_sha256: 'abc',
    processing_status: 'pending' as const, created_at: '2026-10-09T12:00:01Z', provider: 'meta_muse', display_name: 'Muse',
  })

  test('stores pulled observations once and reports every id as safe to ack', async () => {
    const store = fresh()
    expect(await store.receiveAgentObservations([observation('o1', 'k1'), observation('o2', 'k2')])).toEqual(['o1', 'o2'])
    // a re-delivery (same connection + key) is acked again but not duplicated
    expect(await store.receiveAgentObservations([observation('o1', 'k1')])).toEqual(['o1'])
    const list = await store.listAgentObservations(10)
    expect(list.map((o) => o.id).sort()).toEqual(['o1', 'o2'])
    expect(list[0].provider).toBe('meta_muse')
    expect(list[0].user_id).toBe('local')
  })

  test('observations travel in snapshots', async () => {
    const a = fresh()
    await a.receiveAgentObservations([observation('o1', 'k1')])
    const snap = await a.exportSnapshot()
    expect(snap.agent_observations).toHaveLength(1)
    const b = fresh()
    await b.replaceWith(snap)
    expect((await b.listAgentObservations(10)).map((o) => o.id)).toEqual(['o1'])
    await b.replaceWith({ ...snap, agent_observations: undefined })
    expect(await b.listAgentObservations(10)).toEqual([])
  })
})

describe('snapshots', () => {
  test('export → replaceWith round-trips into another device', async () => {
    const a = fresh()
    const app = await a.addApplication({ name: 'Stripe' }, { role: 'PM', stage: 'phone' })
    await a.addResume({ name: 'CV', parsed_json: { basic: { name: 'Erin' } } as never, set_current: true })
    await a.addPortalEvents([{ type: 'status-change', application_id: app.id }])
    await a.addAiRun({ task: 'jd_breakdown', provider: 'claude', prompt_text: 'p', response_text: 'r', parsed_json: [1], parse_format: 'json' })

    const snap = await a.exportSnapshot()
    expect(snap.format).toBe(BACKUP_FORMAT)
    expect(snapshotRowCount(snap)).toBe(5) // agent_observations: none yet
    expect(snap.applications[0]).not.toHaveProperty('user_id')

    const b = fresh()
    await b.addApplication({ name: 'Old' }, { role: 'replaced' })
    await b.replaceWith(snap)
    expect((await b.listApplications()).map((r) => [r.id, r.role, r.user_id])).toEqual([[app.id, 'PM', 'local']])
    expect(await b.exportSnapshot()).toMatchObject({ applications: snap.applications, resumes: snap.resumes })
  })

  test('clearAll empties the device', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Stripe' }, { role: 'PM' })
    expect(await store.isEmpty()).toBe(false)
    await store.clearAll()
    expect(await store.isEmpty()).toBe(true)
  })

  test('each account gets its own database', async () => {
    const alice = createLocalStore('landed-alice')
    const bob = createLocalStore('landed-bob')
    await alice.addApplication({ name: 'Stripe' }, { role: 'PM' })
    expect(await bob.isEmpty()).toBe(true)
  })
})

describe('job searches', () => {
  const brief = { summary: 'AI PM, US', roles: ['AI Product Manager'], locations: ['United States'], needs_sponsorship: true }

  test('confirming a brief archives the previous one; runs are recorded; snapshots carry them', async () => {
    const store = fresh()
    // @ts-expect-error — untrusted input is validated like the server does
    await expect(store.addJobSearch({ roles: [] })).rejects.toThrow(/role/)
    const first = await store.addJobSearch(brief as never)
    expect(first).toMatchObject({ status: 'active', last_run_at: null })
    expect(first.brief.remote).toBe('any')
    const second = await store.addJobSearch({ ...brief, roles: ['APM'] } as never)
    expect((await store.listJobSearches()).map((s) => [s.id, s.status])).toEqual([[second.id, 'active'], [first.id, 'archived']])

    const ran = await store.updateJobSearch(second.id, {
      last_run_at: '2026-10-11T10:00:00Z',
      last_run_result: { found: 12, added: 9, merged: 2, already_applied: 1, agents: ['Claude Code on Mac'] },
    })
    expect(ran.last_run_result?.added).toBe(9)
    await expect(store.updateJobSearch('nope', { status: 'archived' })).rejects.toThrow(/not found/)

    const snap = await store.exportSnapshot()
    expect(snap.job_searches).toHaveLength(2)
    const copy = fresh()
    await copy.replaceWith(snap)
    expect(await copy.listJobSearches()).toHaveLength(2)
  })
})
