// End-to-end processing against a real local store (fake-indexeddb): relay
// delivery → processPending → leads / review queue → user actions.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import {
  acceptSuggestion, addLeadToPipeline, canUndo, dismissLead, ingestEmailFindings, flagQuietApplications, ingestFoundJobs, ingestPortalResults, openPanelQuestions, processPending, quietDays,
  recordApplyClick, rejectSuggestion, settleQuestions, undoSuggestion,
} from './inbox'
import { createLocalStore, type LocalStore } from './store/local'
import type { DbAgentObservation } from './store/types'

let n = 0
const fresh = () => createLocalStore(`landed-inbox-${++n}`)
const settings = { autoApply: true } // the default
const manual = { autoApply: false }

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

  test('automatic mode: a confident interview email moves the card, and undo moves it back', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Ramp' }, { role: 'Ops', stage: 'applied' })
    await deliver(store, observation('application_status', { status: 'interview', company: 'Ramp', confidence: 0.9, evidence: gmail('auto-i') }))
    await processPending(store, settings)
    expect((await store.listApplications())[0].stage).toBe('phone')
    const [s] = await store.listSuggestions()
    expect(s).toMatchObject({ state: 'auto_applied', previous_stage: 'applied', proposed_stage: 'phone', application_id: app.id })
    await undoSuggestion(store, s, await store.listApplications())
    expect((await store.listApplications())[0].stage).toBe('applied')
  })

  test('automatic mode: recruiter replies are just noted', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Ramp' }, { role: 'Ops', stage: 'applied' })
    await deliver(store, observation('application_status', { status: 'recruiter_response', company: 'Ramp', evidence: gmail('rr') }))
    await processPending(store, settings)
    expect((await store.listSuggestions())[0]).toMatchObject({ kind: 'note', state: 'auto_applied' })
    expect((await store.listAgentObservations(5))[0].processing_status).toBe('processed')
  })

  test('manual mode: interview needs review; accepting moves the stage, rejecting leaves it', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Ramp' }, { role: 'Ops', stage: 'applied' })
    await store.addApplication({ name: 'Linear' }, { role: 'Engineer', stage: 'applied' })
    await deliver(store,
      observation('application_status', { status: 'interview', company: 'Ramp', confidence: 0.99, evidence: gmail('i1') }),
      observation('application_status', { status: 'rejected', company: 'Linear', confidence: 0.99, evidence: gmail('r1') }),
    )
    await processPending(store, manual)
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

  test('unmatched emails: manual mode suggests a new application, automatic mode adds it', async () => {
    const store = fresh()
    const email = (id: string) => observation('application_status', { status: 'applied', company: 'Figma', role: 'Designer', confidence: 0.95, evidence: gmail(id) })
    await deliver(store, email('n1'))
    await processPending(store, manual)
    const [s] = await store.listSuggestions()
    expect(s).toMatchObject({ kind: 'new_application', state: 'pending' })
    await acceptSuggestion(store, s, [])
    expect((await store.listApplications()).map((a) => [a.role, a.stage])).toEqual([['Designer', 'applied']])

    const auto = fresh()
    await deliver(auto, email('n2'))
    await processPending(auto, settings)
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

describe('ingestFoundJobs (search runs on the user\'s computer)', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    company: 'Acme AI', title: 'Associate Product Manager', job_url: 'https://jobs.ashbyhq.com/acme/1b2c3d4e-0000-4000-8000-000000000001',
    location: 'San Francisco, CA', posted: '3 days ago', salary: '$130k–$150k', sponsorship: 'Sponsors H-1B', why: 'New grad APM on an AI product',
    ...over,
  })
  const source = (run: string) => ({ run_id: run, runtime_id: 'rt-1', agent: 'claude' })

  test('new jobs become leads with the details; re-ingesting a run is a no-op', async () => {
    const store = fresh()
    const jobs = [job(), job({ company: 'Globex', title: 'PM, New Grad', job_url: 'https://boards.greenhouse.io/globex/jobs/42' })]
    expect(await ingestFoundJobs(store, jobs, source('run-a'))).toEqual({ found: 2, added: 2, merged: 0, already_applied: 0 })
    const leads = await store.listJobLeads()
    expect(leads).toHaveLength(2)
    const acme = leads.find((l) => l.company_name === 'Acme AI')!
    expect(acme.status).toBe('new')
    expect(acme.description).toContain('Sponsorship: Sponsors H-1B')
    expect(acme.sources[0]).toMatchObject({ connection_id: 'runtime:rt-1', provider: 'claude', observation_id: 'run-a:0' })

    expect(await ingestFoundJobs(store, jobs, source('run-a'))).toMatchObject({ added: 0, merged: 2 })
    expect((await store.listJobLeads())[0].sources).toHaveLength(1)
  })

  test('a later run finding the same job merges; jobs already in the pipeline are marked', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [job()], source('run-a'))
    await store.addApplication({ name: 'Globex' }, { role: 'PM, New Grad', stage: 'applied', portal_application_url: 'https://boards.greenhouse.io/globex/jobs/42' })
    const second = await ingestFoundJobs(store, [job(), job({ company: 'Globex', title: 'PM, New Grad', job_url: 'https://boards.greenhouse.io/globex/jobs/42' })], source('run-b'))
    expect(second).toEqual({ found: 2, added: 0, merged: 1, already_applied: 1 })
    const leads = await store.listJobLeads()
    expect(leads.find((l) => l.company_name === 'Acme AI')!.sources).toHaveLength(2)
    expect(leads.find((l) => l.company_name === 'Globex')!.status).toBe('already_applied')
  })
})

describe('ingestEmailFindings (email checks on the user\'s computer)', () => {
  const source = (run: string) => ({ run_id: run, runtime_id: 'rt-1', agent: 'claude', mail: 'Gmail' })
  const mail = (id: string, over: Record<string, unknown> = {}) => ({
    company: 'Figma', role: 'Associate Product Manager', status: 'assessment' as const, confidence: 0.95, job_url: null,
    evidence: { message_id: id, sender_domain: 'figma.com', subject: 'Your Figma online assessment', received_at: '2026-10-10T09:00:00.000Z' },
    ...over,
  })

  test('confident emails move applications (OA too) and are undoable; re-reading changes nothing', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Figma' }, { role: 'Associate Product Manager', stage: 'applied' })
    const first = await ingestEmailFindings(store, [mail('m1'), mail('m2', { company: 'Stripe', status: 'applied', role: 'PM New Grad' })], source('run-a'), settings)
    expect(first).toMatchObject({ found: 2, updated: 1, added: 1 })
    const apps = await store.listApplications()
    expect(apps.find((a) => a.role === 'Associate Product Manager')!.stage).toBe('oa')
    expect(apps.find((a) => a.role === 'PM New Grad')!.stage).toBe('applied')
    const s = (await store.listSuggestions()).find((x) => x.proposed_stage === 'oa')!
    expect(s.evidence).toMatchObject({ source: 'gmail', message_id: 'm1' })
    expect(canUndo(s)).toBe(true)

    const again = await ingestEmailFindings(store, [mail('m1'), mail('m2', { company: 'Stripe', status: 'applied', role: 'PM New Grad' })], source('run-b'), settings)
    expect(again).toMatchObject({ updated: 0, added: 0, unchanged: 2 })
    expect(await store.listApplications()).toHaveLength(2)
  })

  test('unsure or ambiguous emails wait for the user; ids missing → stable fallback key', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Figma' }, { role: 'APM', stage: 'applied' })
    const noId = mail('', { confidence: 0.5, evidence: { sender_domain: 'figma.com', subject: 'Next steps', received_at: '2026-10-10T09:00:00.000Z' } })
    expect(await ingestEmailFindings(store, [noId], source('run-a'), settings)).toMatchObject({ needs_input: 1 })
    expect(await ingestEmailFindings(store, [noId], source('run-b'), settings)).toMatchObject({ needs_input: 0, unchanged: 1 })
    expect((await store.listSuggestions()).filter((x) => x.state === 'pending')).toHaveLength(1)
  })
})

describe('"did you apply?" after opening a posting', () => {
  const lead = (store: LocalStore) => ingestFoundJobs(store, [{
    company: 'Figma', title: 'Associate Product Manager', job_url: 'https://job-boards.greenhouse.io/figma/jobs/6180116004',
    location: 'SF', posted: null, salary: null, sponsorship: null, why: null,
  }], { run_id: 'run-s', runtime_id: 'rt-1', agent: 'claude' }).then(async () => (await store.listJobLeads())[0])
  const open = async (store: LocalStore) => {
    const [s, l, a, c] = await Promise.all([store.listSuggestions(), store.listJobLeads(), store.listApplications(), store.listCompanies()])
    return openPanelQuestions(s, l, a.map((x) => ({ ...x })), c)
  }

  test('opening a lead asks once; "yes" adds that lead as Applied', async () => {
    const store = fresh()
    const l = await lead(store)
    expect(await recordApplyClick(store, { kind: 'lead', lead: l })).not.toBeNull()
    expect(await recordApplyClick(store, { kind: 'lead', lead: l })).toBeNull()
    const [q] = await open(store)
    expect(q).toMatchObject({ company_name: 'Figma', state: 'pending', evidence: { source: 'click' } })
    await acceptSuggestion(store, q, await store.listApplications())
    const apps = await store.listApplications()
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({ stage: 'applied', portal_application_url: 'https://job-boards.greenhouse.io/figma/jobs/6180116004' })
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'saved', application_id: apps[0].id })
    expect(await open(store)).toHaveLength(0)
  })

  test('"not yet" asks again on the next open; saved applications ask too', async () => {
    const store = fresh()
    const app = await store.addApplication({ name: 'Stripe' }, { role: 'PM New Grad', stage: 'saved' })
    const q = (await recordApplyClick(store, { kind: 'application', id: app.id, role: app.role, stage: app.stage, company_name: 'Stripe' }))!
    await rejectSuggestion(store, q.id)
    expect(await open(store)).toHaveLength(0)
    expect(await recordApplyClick(store, { kind: 'application', id: app.id, role: app.role, stage: app.stage, company_name: 'Stripe' })).toMatchObject({ id: q.id, state: 'pending' })
    await acceptSuggestion(store, (await open(store))[0], await store.listApplications())
    expect((await store.listApplications())[0].stage).toBe('applied')
    expect(await recordApplyClick(store, { kind: 'application', id: app.id, role: app.role, stage: 'applied', company_name: 'Stripe' })).toBeNull()
  })

  test('an "application received" email answers the question by itself and links the lead', async () => {
    const store = fresh()
    const l = await lead(store)
    await recordApplyClick(store, { kind: 'lead', lead: l })
    await ingestEmailFindings(store, [{
      company: 'Figma', role: 'Associate Product Manager', status: 'applied', confidence: 0.95, job_url: null,
      evidence: { message_id: 'm-applied', sender_domain: 'greenhouse-mail.io', subject: 'Thanks for applying to Figma' },
    }], { run_id: 'run-e', runtime_id: 'rt-1', agent: 'claude', mail: 'Gmail' }, settings)
    expect(await open(store)).toHaveLength(0)
    const [app] = await store.listApplications()
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'saved', application_id: app.id })
    expect((await store.listSuggestions()).find((s) => s.dedupe_key.startsWith('click:'))).toMatchObject({ state: 'accepted', application_id: app.id })
    expect(await settleQuestions(store)).toBe(0)
  })
})

describe('no news for three weeks → ask; portal checks answer', () => {
  const DAY = 86_400_000
  const now = Date.parse('2026-10-12T12:00:00Z')
  const ago = (days: number) => new Date(now - days * DAY).toISOString()
  const quietOf = async (store: LocalStore) => (await store.listSuggestions()).filter((s) => s.dedupe_key.startsWith('quiet:'))

  test('only in-progress applications quiet for 21+ days; one question each; "wait" asks again 21 days later', async () => {
    const store = fresh()
    const old = await store.addApplication({ name: 'Databricks' }, { role: 'APM', stage: 'applied', applied_at: ago(30), last_activity_at: ago(30) })
    await store.addApplication({ name: 'Figma' }, { role: 'APM', stage: 'applied', applied_at: ago(10), last_activity_at: ago(10) })
    await store.addApplication({ name: 'Initech' }, { role: 'PM', stage: 'rejected', last_activity_at: ago(90) })
    await store.addApplication({ name: 'Hooli' }, { role: 'PM', stage: 'saved', last_activity_at: ago(90) })
    expect(await flagQuietApplications(store, now)).toBe(1)
    expect(await flagQuietApplications(store, now)).toBe(0)
    const [q] = await quietOf(store)
    expect(q).toMatchObject({ application_id: old.id, company_name: 'Databricks', proposed_stage: 'ghosted', state: 'pending' })
    expect(quietDays(q, now)).toBe(30)

    await rejectSuggestion(store, q.id) // "Wait"
    expect(await flagQuietApplications(store, now + 5 * DAY)).toBe(0)
    // 22 days on: Databricks is asked again (and Figma has gone quiet too)
    expect(await flagQuietApplications(store, Date.now() + 22 * DAY)).toBe(2)
    expect((await quietOf(store)).find((x) => x.application_id === old.id)).toMatchObject({ id: q.id, state: 'pending' })
  })

  test('"ghosted" moves it (undoably); news since asking closes the question', async () => {
    const store = fresh()
    const a = await store.addApplication({ name: 'Databricks' }, { role: 'APM', stage: 'applied', last_activity_at: ago(30) })
    const b = await store.addApplication({ name: 'Stripe' }, { role: 'PM', stage: 'phone', last_activity_at: ago(25) })
    await flagQuietApplications(store, now)
    const qa = (await quietOf(store)).find((q) => q.application_id === a.id)!
    await acceptSuggestion(store, qa, await store.listApplications())
    expect((await store.listApplications()).find((x) => x.id === a.id)!.stage).toBe('ghosted')
    expect(canUndo((await store.listSuggestions()).find((s) => s.id === qa.id)!)).toBe(true)

    await store.updateApplication(b.id, { notes: 'Recruiter pinged me' }) // news
    expect(await settleQuestions(store)).toBe(1)
    expect((await quietOf(store)).find((q) => q.application_id === b.id)!.state).toBe('rejected')
  })

  test('portal results: changes wait for the user, "still in process" puts the question off, sign-in walls are reported', async () => {
    const store = fresh()
    const url = 'https://databricks.wd1.myworkdayjobs.com/en-US/careers/job/APM_123'
    const a = await store.addApplication({ name: 'Databricks' }, { role: 'APM', stage: 'applied', last_activity_at: ago(30), portal_application_url: url })
    const b = await store.addApplication({ name: 'Stripe' }, { role: 'PM', stage: 'applied', last_activity_at: ago(30) })
    const c = await store.addApplication({ name: 'TikTok' }, { role: 'PM Grad', stage: 'applied', last_activity_at: ago(30) })
    await flagQuietApplications(store, now)
    const items = [{ ref: '1', application_id: a.id }, { ref: '2', application_id: b.id }, { ref: '3', application_id: c.id }]
    const r = await ingestPortalResults(store, items, [
      { ref: '1', outcome: 'status_found', status: 'rejected', status_text: 'No longer under consideration', confidence: 0.95, page_url: url, note: null },
      { ref: '2', outcome: 'status_found', status: 'applied', status_text: 'Under review', confidence: 0.9, page_url: null, note: null },
      { ref: '3', outcome: 'login_required', status: null, status_text: null, confidence: null, page_url: null, note: null },
    ], { run_id: 'job-p', runtime_id: 'rt-1', agent: 'claude' })
    expect(r).toMatchObject({ checked: 3, needs_input: 1, in_process: 1, updated: 0, login_required: ['TikTok'] })
    // nothing changed on its own
    expect((await store.listApplications()).every((x) => x.stage === 'applied')).toBe(true)
    const pending = (await store.listSuggestions()).find((s) => s.evidence?.source === 'portal')!
    expect(pending).toMatchObject({ state: 'pending', proposed_stage: 'rejected', application_id: a.id, evidence: { sender_domain: 'databricks.wd1.myworkdayjobs.com', subject: 'No longer under consideration' } })
    expect((await quietOf(store)).find((q) => q.application_id === b.id)!.state).toBe('rejected')

    // the same reading again changes nothing
    const again = await ingestPortalResults(store, items.slice(0, 1), [
      { ref: '1', outcome: 'status_found', status: 'rejected', status_text: 'No longer under consideration', confidence: 0.95, page_url: url, note: null },
    ], { run_id: 'job-q', runtime_id: 'rt-1', agent: 'claude' })
    expect(again.needs_input).toBe(1)
    expect((await store.listSuggestions()).filter((s) => s.evidence?.source === 'portal')).toHaveLength(1)
  })
})
