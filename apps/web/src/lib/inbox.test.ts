// End-to-end inbox flows against a real local store (fake-indexeddb): found
// jobs and email checks → leads / review queue → user actions.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import {
  acceptSuggestion, addLeadToPipeline, approveLeads, canUndo, dismissLead, ingestEmailFindings, flagQuietApplications, ingestFoundJobs, openPanelQuestions, quietDays,
  recordApplyClick, rejectSuggestion, settleQuestions, undoApprovals, undoSuggestion,
} from './inbox'
import { createLocalStore, type LocalStore } from './store/local'
import type { FoundJob } from '@landed/schema/search-brief'

let n = 0
const fresh = () => createLocalStore(`landed-inbox-${++n}`)
const settings = { autoApply: true } // the default

let seq = 0
/** Jobs an agent on the user's computer found, ingested as one run. */
async function found(store: LocalStore, ...jobs: (Pick<FoundJob, 'title' | 'company'> & Partial<FoundJob>)[]) {
  seq++
  await ingestFoundJobs(store, jobs.map((j) => ({
    job_url: null, location: null, posted: null, deadline: null, salary: null, sponsorship: null, why: null, ...j,
  })), { run_id: `run-${seq}`, runtime_id: 'rt-1', agent: 'claude' })
}
const gmail = (id: string) => ({ source: 'gmail', message_id: id, sender_domain: 'greenhouse-mail.io', subject: 'Re: your application' })

describe('lead actions', () => {
  test('add to pipeline links the lead; dismiss hides it from new', async () => {
    const store = fresh()
    await found(store, { title: 'PM, AI', company: 'Anthropic', job_url: 'https://example.com/jobs/1', location: 'San Francisco, CA' }, { title: 'Designer', company: 'Figma' })
    const [a, b] = (await store.listJobLeads()).sort((x, y) => x.company_name.localeCompare(y.company_name))
    const app = await addLeadToPipeline(store, a, 'applied')
    expect(app).toMatchObject({ role: 'PM, AI', stage: 'applied', location: 'San Francisco, CA', portal_application_url: 'https://example.com/jobs/1', source: 'Agent (claude)' })
    await dismissLead(store, b.id)
    const leads = await store.listJobLeads()
    expect(leads.find((l) => l.id === a.id)).toMatchObject({ status: 'saved', application_id: app.id })
    expect(leads.find((l) => l.id === b.id)!.status).toBe('dismissed')

    // the same job reported again later merges into the dismissed lead and stays dismissed
    await found(store, { title: 'Designer', company: 'Figma', location: 'Remote' })
    expect((await store.listJobLeads()).filter((l) => l.company_name === 'Figma')).toEqual([
      expect.objectContaining({ status: 'dismissed', location: 'Remote' }),
    ])
  })

  test('approve N saves each for later; undo puts them back as leads', async () => {
    const store = fresh()
    await found(store, { title: 'Software Engineer, New Grad', company: 'Northwind Robotics', job_url: 'https://jobs.lever.co/northwindrobotics/1' }, { title: 'Software Engineer, Platform', company: 'Northwind Robotics', job_url: 'https://jobs.lever.co/northwindrobotics/2' }, { title: 'Data Engineer', company: 'Bluefin Analytics' })
    const leads = (await store.listJobLeads()).sort((x, y) => x.title.localeCompare(y.title))
    const picked = leads.filter((l) => l.company_name === 'Northwind Robotics')
    const { approved: approvals, failed } = await approveLeads(store, picked)

    expect(approvals).toHaveLength(2)
    expect(failed).toEqual([])
    const apps = await store.listApplications()
    expect(apps.map((a) => [a.role, a.stage]).sort()).toEqual([['Software Engineer, New Grad', 'saved'], ['Software Engineer, Platform', 'saved']])
    // two leads at a new company make one company
    expect((await store.listCompanies()).filter((c) => c.name === 'Northwind Robotics')).toHaveLength(1)
    for (const a of approvals) {
      expect((await store.listJobLeads()).find((l) => l.id === a.lead_id)).toMatchObject({ status: 'saved', application_id: a.application_id })
    }

    // Undo: the applications go, the leads are leads again; the other lead is untouched.
    expect(await undoApprovals(store, approvals)).toBe(2)
    expect(await store.listApplications()).toEqual([])
    const after = await store.listJobLeads()
    expect(after.map((l) => [l.title, l.status, l.application_id]).sort()).toEqual([
      ['Data Engineer', 'new', null], ['Software Engineer, New Grad', 'new', null], ['Software Engineer, Platform', 'new', null],
    ])
  })

  test("undo leaves an approval the user has moved on from (applied since)", async () => {
    const store = fresh()
    await found(store, { title: 'Backend Engineer', company: 'Kestrel Pay' }, { title: 'Frontend Engineer', company: 'Kestrel Pay' })
    const { approved: approvals } = await approveLeads(store, await store.listJobLeads())
    await store.updateApplication(approvals[0].application_id, { stage: 'applied' })

    expect(await undoApprovals(store, approvals)).toBe(1)
    const apps = await store.listApplications()
    expect(apps.map((a) => a.id)).toEqual([approvals[0].application_id])
    const leads = await store.listJobLeads()
    expect(leads.find((l) => l.id === approvals[0].lead_id)).toMatchObject({ status: 'saved', application_id: approvals[0].application_id })
    expect(leads.find((l) => l.id === approvals[1].lead_id)).toMatchObject({ status: 'new', application_id: null })
  })

  test('one approval that fails doesn\'t stop the rest, and those done are undoable', async () => {
    const store = fresh()
    await found(store, { title: 'Backend Engineer', company: 'Kestrel Pay' }, { title: 'Data Engineer', company: 'Bluefin Analytics' }, { title: 'Mobile Engineer', company: 'Northwind Robotics' })
    const leads = (await store.listJobLeads()).sort((x, y) => x.title.localeCompare(y.title))
    const flaky: typeof store = Object.create(store)
    flaky.addApplication = (company, app) => (app.role === 'Data Engineer' ? Promise.reject(new Error('offline')) : store.addApplication(company, app))

    const { approved, failed } = await approveLeads(flaky, leads)
    expect(failed).toEqual([leads.find((l) => l.title === 'Data Engineer')!.id])
    expect(approved).toHaveLength(2)
    expect((await store.listApplications()).map((a) => a.role).sort()).toEqual(['Backend Engineer', 'Mobile Engineer'])
    expect(await undoApprovals(store, approved)).toBe(2)
    expect(await store.listApplications()).toEqual([])
  })

  test('leads and suggestions travel in snapshots', async () => {
    const a = fresh()
    await found(a, { title: 'PM', company: 'Acme' })
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
    location: 'San Francisco, CA', posted: '3 days ago', deadline: null as string | null, salary: '$130k–$150k', sponsorship: 'Sponsors H-1B', why: 'New grad APM on an AI product',
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
    interview_at: null as string | null, interview_format: null as 'onsite' | 'remote' | null,
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

  test('an interview invitation with a time adds a round to the application', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Figma' }, { role: 'Associate Product Manager', stage: 'oa' })
    await ingestEmailFindings(store, [mail('inv-1', { status: 'interview', interview_at: '2026-10-20T14:00:00-07:00', interview_format: 'remote' })], source('run-i'), settings)
    const [app] = await store.listApplications()
    expect(app.stage).toBe('interview')
    expect(app.interviews).toEqual([{ round: 1, format: 'remote', interviewers: [], at: '2026-10-20T21:00:00.000Z', note: null }])
    await ingestEmailFindings(store, [mail('inv-2', { status: 'interview', interview_at: '2026-10-27T10:00:00-07:00', interview_format: 'onsite' })], source('run-j'), settings)
    expect((await store.listApplications())[0].interviews.map((r) => [r.round, r.format])).toEqual([[1, 'remote'], [2, 'onsite']])
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
    location: 'SF', posted: null, deadline: 'Oct 21, 2026 5pm PT', salary: null, sponsorship: null, why: null,
  }], { run_id: 'run-s', runtime_id: 'rt-1', agent: 'claude' }).then(async () => (await store.listJobLeads())[0])
  const open = async (store: LocalStore) => {
    const [s, l, a, c] = await Promise.all([store.listSuggestions(), store.listJobLeads(), store.listApplications(), store.listCompanies()])
    return openPanelQuestions(s, l, a.map((x) => ({ ...x })), c)
  }

  test('opening a lead asks once; "yes" adds that lead as Applied', async () => {
    const store = fresh()
    const l = await lead(store)
    expect(l.deadline).toBe('2026-10-21')
    expect(await recordApplyClick(store, { kind: 'lead', lead: l })).not.toBeNull()
    expect(await recordApplyClick(store, { kind: 'lead', lead: l })).toBeNull()
    const [q] = await open(store)
    expect(q).toMatchObject({ company_name: 'Figma', state: 'pending', evidence: { source: 'click' } })
    await acceptSuggestion(store, q, await store.listApplications())
    const apps = await store.listApplications()
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({ stage: 'applied', portal_application_url: 'https://job-boards.greenhouse.io/figma/jobs/6180116004', deadline: '2026-10-21' })
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
      interview_at: null, interview_format: null,
      evidence: { message_id: 'm-applied', sender_domain: 'greenhouse-mail.io', subject: 'Thanks for applying to Figma' },
    }], { run_id: 'run-e', runtime_id: 'rt-1', agent: 'claude', mail: 'Gmail' }, settings)
    expect(await open(store)).toHaveLength(0)
    const [app] = await store.listApplications()
    expect((await store.listJobLeads())[0]).toMatchObject({ status: 'saved', application_id: app.id })
    expect((await store.listSuggestions()).find((s) => s.dedupe_key.startsWith('click:'))).toMatchObject({ state: 'accepted', application_id: app.id })
    expect(await settleQuestions(store)).toBe(0)
  })
})

describe('no news for three weeks → ask', () => {
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
    const b = await store.addApplication({ name: 'Stripe' }, { role: 'PM', stage: 'interview', last_activity_at: ago(25) })
    await flagQuietApplications(store, now)
    const qa = (await quietOf(store)).find((q) => q.application_id === a.id)!
    await acceptSuggestion(store, qa, await store.listApplications())
    expect((await store.listApplications()).find((x) => x.id === a.id)!.stage).toBe('ghosted')
    expect(canUndo((await store.listSuggestions()).find((s) => s.id === qa.id)!)).toBe(true)

    await store.updateApplication(b.id, { notes: 'Recruiter pinged me' }) // news
    expect(await settleQuestions(store)).toBe(1)
    expect((await quietOf(store)).find((q) => q.application_id === b.id)!.state).toBe('rejected')
  })
})
