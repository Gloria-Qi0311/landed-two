// An application Landed learned about outside the pipeline (a confirmation
// page the extension saw): matching it against what Landed has, and adding it.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import type { ReportedApplication } from '@landed/schema/reported-application'
import { addReportedApplication, isForward, matchReported } from './inbox'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-reported-${++n}`)

describe('adding them', () => {
  const r = (over: Partial<ReportedApplication> = {}): ReportedApplication => ({
    company: 'Blorp Inc', role: 'Backend Engineer', stage: 'applied' as const, applied_on: '2026-10-13', job_url: null, location: 'Seattle, WA', note: 'Req R-20417', ...over,
  })

  test('new → added as applied on that day; then it shows as already there', async () => {
    const store = fresh()
    const app = await addReportedApplication(store, r())
    expect(app).toMatchObject({ role: 'Backend Engineer', stage: 'applied', applied_at: '2026-10-13T12:00:00.000Z', location: 'Seattle, WA', notes: 'Req R-20417' })
    const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
    expect(matchReported(r(), apps, companies, [])).toMatchObject({ kind: 'existing', forward: false })
    // Another role at the same company is another application.
    expect(matchReported(r({ role: 'Product Designer' }), apps, companies, [])).toEqual({ kind: 'new' })
    await addReportedApplication(store, r())
    expect(await store.listApplications()).toHaveLength(1) // adding twice doesn't duplicate
  })

  test("Chinese names: another company is another application; one list's rows stay apart", async () => {
    const store = fresh()
    await store.addApplication({ name: '美团' }, { role: 'AI产品经理岗', stage: 'oa' })
    const tx = r({ company: '腾讯', role: 'AI产品经理' })
    const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
    expect(matchReported(tx, apps, companies, [])).toEqual({ kind: 'new' }) // used to say "already in Applications"
    expect(matchReported(r({ company: '美团', role: 'AI产品经理岗' }), apps, companies, [])).toMatchObject({ kind: 'existing', company: '美团' })

    // "Add all": 产品管培生（上海） and （广东省） are two applications.
    await addReportedApplication(store, r({ company: '拼多多', role: '产品管培生（上海）' }))
    await addReportedApplication(store, r({ company: '拼多多', role: '产品管培生（广东省）' }))
    expect((await store.listApplications()).map((a) => a.role).sort()).toEqual(['AI产品经理岗', '产品管培生（上海）', '产品管培生（广东省）'])
  })

  test('already there at an earlier stage → moved along, not duplicated', async () => {
    const store = fresh()
    await store.addApplication({ name: 'Blorp Inc' }, { role: 'Backend Engineer, Payments', stage: 'saved' })
    const app = await addReportedApplication(store, r({ role: 'Backend Engineer, Payments' }))
    expect(app.stage).toBe('applied')
    expect(await store.listApplications()).toHaveLength(1)
    expect([isForward('interview', 'applied'), isForward('applied', 'rejected'), isForward('ghosted', 'interview')]).toEqual([false, true, true])
  })

  test('a matching lead goes into the pipeline instead of a second copy', async () => {
    const store = fresh()
    await store.saveJobLead({
      id: crypto.randomUUID(), fingerprint: 'job:blorp', ats_key: null, canonical_url: null, company_key: 'blorp', title_key: 'backend engineer',
      company_name: 'Blorp Inc', title: 'Backend Engineer', job_url: 'https://jobs.example/blorp/1', location: null, description: null, deadline: null,
      sources: [], status: 'new', application_id: null, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    } as never)
    const [apps, companies, leads] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobLeads()])
    expect(matchReported(r(), apps, companies, leads).kind).toBe('lead')
    const app = await addReportedApplication(store, r())
    expect(app).toMatchObject({ stage: 'applied', portal_application_url: 'https://jobs.example/blorp/1', applied_at: '2026-10-13T12:00:00.000Z' })
    const [lead] = await store.listJobLeads()
    expect([lead.status, lead.application_id]).toEqual(['saved', app.id])
  })
})
