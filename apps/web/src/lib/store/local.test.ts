// Local store (IndexedDB) behaviour. Runs on fake-indexeddb; each test gets
// a fresh database name so state never leaks between tests.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
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
    const next = await store.updateApplication(a.id, { stage: 'oa', company_id: 'evil' } as never)
    expect(next.stage).toBe('oa')
    expect(next.company_id).toBe(a.company_id)
    expect(next.last_activity_at > a.last_activity_at).toBe(true)
    await expect(store.updateApplication('nope', { stage: 'offer' })).rejects.toMatchObject({ status: 404 })
  })

  test('deleteApplication: its events go, pending questions go, leads and history lose the link', async () => {
    const store = fresh()
    const a = await store.addApplication({ name: 'Figma' }, { role: 'APM', stage: 'applied' })
    const b = await store.addApplication({ name: 'Stripe' }, { role: 'PM', stage: 'applied' })
    await store.addPortalEvents([{ type: 'rejection', application_id: a.id }, { type: 'sync', application_id: b.id }])
    const base = {
      kind: 'stage_change' as const, candidate_ids: [], company_name: 'Figma', role: 'APM', status: 'interview', proposed_stage: 'interview',
      previous_stage: 'applied', confidence: 0.9, evidence: { source: 'gmail' }, observation_ids: [], provider: 'agent',
    }
    await store.saveSuggestion({ ...base, id: crypto.randomUUID(), dedupe_key: 'quiet:a', state: 'pending', application_id: a.id, resolved_at: null } as never)
    await store.saveSuggestion({ ...base, id: crypto.randomUUID(), dedupe_key: 'msg:1', state: 'applied', application_id: a.id, resolved_at: new Date().toISOString() } as never)
    await store.saveJobLead({
      id: crypto.randomUUID(), fingerprint: 'url:x', ats_key: null, canonical_url: 'x', company_key: 'figma', title_key: 'apm', company_name: 'Figma',
      title: 'APM', job_url: null, location: null, description: null, deadline: null, sources: [], status: 'applied', application_id: a.id,
      first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    } as never)

    await store.deleteApplication(a.id)
    expect((await store.listApplications()).map((x) => x.id)).toEqual([b.id])
    expect((await store.listPortalEvents(10)).map((e) => e.application_id)).toEqual([b.id])
    const left = await store.listSuggestions()
    expect(left.map((x) => [x.dedupe_key, x.application_id])).toEqual([['msg:1', null]])
    const [lead] = await store.listJobLeads()
    expect([lead.application_id, lead.status]).toEqual([null, 'applied']) // stays out of Leads
    await expect(store.deleteApplication(a.id)).rejects.toThrow(/not found/)
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

describe('application answers', () => {
  test('one row per account, validated, kept across saves and snapshots', async () => {
    const store = fresh()
    expect(await store.getApplicationAnswers()).toBeNull()
    const first = await store.saveApplicationAnswers({ country: ' China ', needs_sponsorship: 'yes', relocate: 'maybe' } as never)
    expect(first.answers).toMatchObject({ country: 'China', needs_sponsorship: 'yes', relocate: null, custom: [] })
    const second = await store.saveApplicationAnswers({ ...first.answers, travel: 'no' })
    expect(second.id).toBe(first.id)
    expect((await store.getApplicationAnswers())?.answers.travel).toBe('no')

    const copy = fresh()
    await copy.replaceWith(await store.exportSnapshot())
    expect((await copy.getApplicationAnswers())?.answers).toMatchObject({ country: 'China', travel: 'no' })
  })
})

describe('pipeline: one interview stage with rounds', () => {
  test('legacy phone/onsite become interview (+ the round they stood for); rounds are validated', async () => {
    const store = fresh()
    const phone = await store.addApplication({ name: 'Acme' }, { role: 'PM', stage: 'phone' as never })
    expect(phone).toMatchObject({ stage: 'interview', interviews: [{ round: null, format: 'remote', interviewers: [] }] })
    const fresh2 = await store.addApplication({ name: 'Acme' }, { role: 'APM', stage: 'applied' })
    expect(fresh2.interviews).toEqual([])

    const moved = await store.updateApplication(fresh2.id, {
      stage: 'interview',
      interviews: [{ round: 4, format: 'remote', interviewers: ['leader', 'boss' as never, 'peer'], at: null, note: null }],
    })
    expect(moved.interviews).toEqual([{ round: 4, format: 'remote', interviewers: ['peer', 'leader'], at: null, note: null }])
    expect((await store.updateApplication(fresh2.id, { stage: 'onsite' as never })).stage).toBe('interview')
    await expect(store.updateApplication(fresh2.id, { stage: 'hired' as never })).rejects.toThrow(/stage/)
    const edited = await store.updateApplication(fresh2.id, { portal_application_url: 'https://jobs.lever.co/acme/1', notes: 'Recruiter: Sam' })
    expect(edited).toMatchObject({ portal_application_url: 'https://jobs.lever.co/acme/1', notes: 'Recruiter: Sam' })
    await expect(store.updateApplication(fresh2.id, { interviews: 'lots' as never })).rejects.toThrow(/interviews/)
  })

  test('older backups restore with interview rounds', async () => {
    const store = fresh()
    const snap = await store.exportSnapshot()
    await store.replaceWith({
      ...snap,
      companies: [{ id: 'c1', name: 'Acme', hue: null, logo_chars: null, sector: null, loc: null, portal_url: null, created_at: '2026-01-01T00:00:00Z' }],
      applications: [{ id: 'a1', company_id: 'c1', role: 'PM', stage: 'onsite', last_activity_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' } as never],
    })
    expect((await store.listApplications())[0]).toMatchObject({ stage: 'interview', interviews: [{ format: 'onsite' }] })
  })
})

test('upgrading a browser database from v4 moves phone/onsite to interview rounds', async () => {
  const name = `landed-upgrade-${++n}`
  // The schema as it was at v4 (same stores as LandedDB's versions 1–4).
  const old = new Dexie(name)
  old.version(1).stores({ companies: 'id, name', applications: 'id, company_id, last_activity_at', resumes: 'id, created_at', portal_connections: 'id, [company_id+provider]', portal_events: 'id, created_at', ai_runs: 'id', meta: 'key' })
  old.version(2).stores({ agent_observations: 'id, created_at, &[connection_id+idempotency_key]' })
  old.version(3).stores({ agent_observations: 'id, created_at, &[connection_id+idempotency_key], processing_status', job_leads: 'id, &fingerprint, status, last_seen_at', status_suggestions: 'id, &dedupe_key, state, created_at' })
  old.version(4).stores({ job_searches: 'id, status, created_at' })
  const base = { company_id: 'c1', user_id: 'local', last_activity_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }
  await old.table('applications').bulkAdd([
    { ...base, id: 'p', role: 'PM', stage: 'phone' },
    { ...base, id: 'o', role: 'APM', stage: 'onsite' },
    { ...base, id: 's', role: 'SWE', stage: 'saved' },
  ])
  await old.table('status_suggestions').add({ id: 'g', dedupe_key: 'k', state: 'accepted', created_at: '2026-01-01T00:00:00Z', proposed_stage: 'onsite', previous_stage: 'phone' })
  old.close()

  const store = createLocalStore(name)
  const apps = Object.fromEntries((await store.listApplications()).map((a) => [a.id, a]))
  expect(apps.p).toMatchObject({ stage: 'interview', interviews: [{ format: 'remote' }] })
  expect(apps.o).toMatchObject({ stage: 'interview', interviews: [{ format: 'onsite' }] })
  expect(apps.s).toMatchObject({ stage: 'saved', interviews: [] })
  expect((await store.listSuggestions())[0]).toMatchObject({ proposed_stage: 'interview', previous_stage: 'interview' })
})

describe('upgrades', () => {
  test('v10: a round added by hand after v9 is numbered with the others, by time', async () => {
    const name = `landed-upgrade-${++n}`
    const old = new Dexie(name)
    old.version(9).stores({
      companies: 'id, name', applications: 'id, company_id, last_activity_at', resumes: 'id, created_at',
      portal_connections: 'id, [company_id+provider]', portal_events: 'id, created_at', ai_runs: 'id', meta: 'key',
      agent_observations: 'id, created_at, &[connection_id+idempotency_key], processing_status',
      job_leads: 'id, &fingerprint, status, last_seen_at', status_suggestions: 'id, &dedupe_key, state, created_at',
      job_searches: 'id, status, created_at', agent_conversations: 'id, updated_at',
    })
    const round = (n: number, at: string) => ({ round: n, format: 'remote', interviewers: [], at, note: null })
    await old.table('applications').add({
      id: 'a1', company_id: 'c1', role: 'PM', stage: 'interview', last_activity_at: '2026-10-14T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
      interviews: [round(2, '2026-09-28T20:00:00.000Z'), round(3, '2026-10-08T20:00:00.000Z'), round(4, '2026-10-18T20:00:00.000Z'), round(3, '2026-09-21T19:00:00.000Z')],
    })
    old.close()
    const [app] = await createLocalStore(name).listApplications()
    expect(app.interviews.map((r) => [r.round, r.at!.slice(5, 10)])).toEqual([[1, '09-21'], [2, '09-28'], [3, '10-08'], [4, '10-18']])
  })

  test('v9: rounds an out-of-order email check numbered backwards are put in time order', async () => {
    const name = `landed-upgrade-${++n}`
    // A database as v8 left it.
    const old = new Dexie(name)
    old.version(8).stores({
      companies: 'id, name', applications: 'id, company_id, last_activity_at', resumes: 'id, created_at',
      portal_connections: 'id, [company_id+provider]', portal_events: 'id, created_at', ai_runs: 'id', meta: 'key',
      agent_observations: 'id, created_at, &[connection_id+idempotency_key], processing_status',
      job_leads: 'id, &fingerprint, status, last_seen_at', status_suggestions: 'id, &dedupe_key, state, created_at',
      job_searches: 'id, status, created_at', agent_conversations: 'id, updated_at',
    })
    const round = (n: number, at: string) => ({ round: n, format: 'remote', interviewers: [], at, note: null })
    await old.table('applications').add({
      id: 'a1', company_id: 'c1', role: 'PM', stage: 'interview', last_activity_at: '2026-10-14T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
      interviews: [round(1, '2026-10-18T20:00:00.000Z'), round(2, '2026-10-08T20:00:00.000Z'), round(3, '2026-09-28T20:00:00.000Z')],
    })
    old.close()
    const store = createLocalStore(name)
    const [app] = await store.listApplications()
    expect(app.interviews.map((r) => [r.round, r.at!.slice(0, 10)])).toEqual([[1, '2026-09-28'], [2, '2026-10-08'], [3, '2026-10-18']])
  })
})
