// End-to-end processing against a real local store (fake-indexeddb): relay
// delivery → processPending → leads / review queue → user actions.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { acceptSuggestion, addLeadToPipeline, canUndo, dismissLead, processPending, rejectSuggestion, undoSuggestion } from './inbox'
import { createLocalStore, type LocalStore } from './store/local'
import type { DbAgentObservation } from './store/types'

let n = 0
const fresh = () => createLocalStore(`landed-inbox-${++n}`)
const settings = { autoAddApplications: false }

let seq = 0
function observation(type: string, payload: Record<string, unknown>, over: Partial<DbAgentObservation> = {}): DbAgentObservation {
  seq++
  return {
    id: crypto.randomUUID(), user_id: 'server', connection_id: 'conn-muse', idempotency_key: `k-${seq}`,
    schema_version: '0.1', run_id: 'run-1', observation_type: type, observed_at: `2026-10-09T12:00:${String(seq % 60).padStart(2, '0')}Z`,
    payload_json: { payload }, payload_sha256: 'h', processing_status: 'pending', created_at: new Date(Date.now() + seq).toISOString(),
    provider: 'meta_muse', ...over,
  }
}
const gmail = (id: string) => ({ source: 'gmail', message_id: id, sender_domain: 'greenhouse-mail.io', subject: 'Re: your application' })

async function deliver(store: LocalStore, ...rows: DbAgentObservation[]) {
  await store.receiveAgentObservations(rows)
}

describe('processPending', () => {
  test('jobs from two agents become one lead; observations are marked', async () => {
    const store = fresh()
    await deliver(store,
      observation('job_discovered', { title: 'Senior PM', company: 'Acme', job_url: 'https://boards.greenhouse.io/acme/jobs/111' }),
      observation('job_discovered', { title: 'Sr. Product Manager', company: 'Acme, Inc.', job_url: 'https://acme.com/careers?gh_jid=111' }, { connection_id: 'conn-claude', provider: 'claude' }),
      observation('job_discovered', { title: 'Designer', company: 'Figma' }),
    )
    expect(await processPending(store, settings)).toBe(3)
    const leads = await store.listJobLeads()
    expect(leads).toHaveLength(2)
    expect(leads.find((l) => l.company_name === 'Acme')!.sources.map((s) => s.provider)).toEqual(['meta_muse', 'claude'])
    expect(await store.listPendingObservations(10)).toEqual([])
    const all = await store.listAgentObservations(10)
    expect(all.every((o) => o.processing_status === 'processed' && o.processing_result?.lead_id)).toBe(true)
    // running again finds nothing to do
    expect(await processPending(store, settings)).toBe(0)
  })

  test('confident "applied" email auto-applies, logs activity, and can be undone', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Ramp' }, { role: 'Operations Lead', stage: 'saved' })
    await deliver(store, observation('application_status', { status: 'applied', company: 'Ramp', confidence: 0.95, evidence: gmail('m1') }))
    await processPending(store, settings)

    const [moved] = await store.listApplications()
    expect(moved.stage).toBe('applied')
    expect(moved.applied_at).toBeTruthy()
    const [s] = await store.listSuggestions()
    expect(s).toMatchObject({ state: 'auto_applied', previous_stage: 'saved', application_id: app.id })
    const [event] = await store.listPortalEvents(5)
    expect(event).toMatchObject({ type: 'status-change', application_id: app.id, payload_json: { source: 'agent', how: 'auto', from: 'saved', to: 'applied' } })

    expect(canUndo(s)).toBe(true)
    await undoSuggestion(store, s, await store.listApplications())
    expect((await store.listApplications())[0].stage).toBe('saved')
    expect((await store.listSuggestions())[0].state).toBe('undone')
  })

  test('interview needs review; accepting moves the stage, rejecting leaves it', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Ramp' }, { role: 'Ops', stage: 'applied' })
    await store.addApplication({ name: 'Linear' }, { role: 'Engineer', stage: 'applied' })
    await deliver(store,
      observation('application_status', { status: 'interview', company: 'Ramp', confidence: 0.99, evidence: gmail('i1') }),
      observation('application_status', { status: 'rejected', company: 'Linear', confidence: 0.99, evidence: gmail('r1') }),
    )
    await processPending(store, settings)
    expect((await store.listApplications()).map((a) => a.stage)).toEqual(['applied', 'applied'])

    const suggestions = await store.listSuggestions()
    const interview = suggestions.find((s) => s.company_name === 'Ramp')!
    const rejection = suggestions.find((s) => s.company_name === 'Linear')!
    expect(interview).toMatchObject({ state: 'pending', proposed_stage: 'phone' })
    expect((await store.listAgentObservations(5)).every((o) => o.processing_status === 'needs-review')).toBe(true)

    await acceptSuggestion(store, interview, await store.listApplications())
    await rejectSuggestion(store, rejection.id)
    const apps = await store.listApplications()
    expect(apps.find((a) => a.role === 'Ops')!.stage).toBe('phone')
    expect(apps.find((a) => a.role === 'Engineer')!.stage).toBe('applied')
    expect((await store.listSuggestions()).find((s) => s.id === interview.id)).toMatchObject({ state: 'accepted', previous_stage: 'applied' })
  })

  test('ambiguous matches are resolved by the user picking the application', async () => {
    const store = fresh()
    const pm = await store.addApplication({ name: 'Acme' }, { role: 'Product Manager', stage: 'applied' })
    await store.addApplication({ name: 'Acme' }, { role: 'Software Engineer', stage: 'applied' })
    await deliver(store, observation('application_status', { status: 'interview', company: 'Acme', evidence: gmail('a1') }))
    await processPending(store, settings)
    const [s] = await store.listSuggestions()
    expect(s.kind).toBe('ambiguous')
    expect(s.candidate_ids).toHaveLength(2)
    await expect(acceptSuggestion(store, s, await store.listApplications())).rejects.toThrow(/Pick which application/)
    await acceptSuggestion(store, s, await store.listApplications(), pm.id)
    expect((await store.listApplications()).find((a) => a.id === pm.id)!.stage).toBe('phone')
  })

  test('unmatched emails suggest a new application; the setting auto-adds', async () => {
    const store = fresh()
    const email = (id: string) => observation('application_status', { status: 'applied', company: 'Figma', role: 'Designer', confidence: 0.95, evidence: gmail(id) })
    await deliver(store, email('n1'))
    await processPending(store, settings)
    const [s] = await store.listSuggestions()
    expect(s).toMatchObject({ kind: 'new_application', state: 'pending' })
    await acceptSuggestion(store, s, [])
    expect((await store.listApplications()).map((a) => [a.role, a.stage])).toEqual([['Designer', 'applied']])

    const auto = fresh()
    await deliver(auto, email('n2'))
    await processPending(auto, { autoAddApplications: true })
    const [created] = await auto.listApplications()
    expect(created).toMatchObject({ role: 'Designer', stage: 'applied', source: 'Agent (email)' })
    expect((await auto.listSuggestions())[0]).toMatchObject({ state: 'auto_applied', application_id: created.id })
  })

  test('a job already in the pipeline is not listed as new', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Acme' }, { role: 'Product Manager', stage: 'applied' })
    await deliver(store, observation('job_discovered', { title: 'PM', company: 'Acme Inc.' }))
    await processPending(store, settings)
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'already_applied' })
  })
})

describe('lead actions', () => {
  test('add to pipeline links the lead; dismiss hides it from new', async () => {
    const store = fresh()
    await deliver(store,
      observation('job_discovered', { title: 'PM, AI', company: 'Anthropic', job_url: 'https://example.com/jobs/1', location: 'San Francisco, CA' }),
      observation('job_discovered', { title: 'Designer', company: 'Figma' }),
    )
    await processPending(store, settings)
    const [a, b] = (await store.listJobLeads()).sort((x, y) => x.company_name.localeCompare(y.company_name))
    const app = await addLeadToPipeline(store, a, 'applied')
    expect(app).toMatchObject({ role: 'PM, AI', stage: 'applied', location: 'San Francisco, CA', portal_application_url: 'https://example.com/jobs/1', source: 'Agent (meta_muse)' })
    await dismissLead(store, b.id)
    const leads = await store.listJobLeads()
    expect(leads.find((l) => l.id === a.id)).toMatchObject({ status: 'saved', application_id: app.id })
    expect(leads.find((l) => l.id === b.id)!.status).toBe('dismissed')

    // the same job reported again later merges into the dismissed lead and stays dismissed
    await deliver(store, observation('job_discovered', { title: 'Designer', company: 'Figma', location: 'Remote' }))
    await processPending(store, settings)
    expect((await store.listJobLeads()).filter((l) => l.company_name === 'Figma')).toEqual([
      expect.objectContaining({ status: 'dismissed', location: 'Remote' }),
    ])
  })

  test('leads and suggestions travel in snapshots', async () => {
    const a = fresh()
    await deliver(a, observation('job_discovered', { title: 'PM', company: 'Acme' }))
    await processPending(a, settings)
    const snap = await a.exportSnapshot()
    expect(snap.job_leads).toHaveLength(1)
    const b = fresh()
    await b.replaceWith(snap)
    expect(await b.listJobLeads()).toHaveLength(1)
  })
})
