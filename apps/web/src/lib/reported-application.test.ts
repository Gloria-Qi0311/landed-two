// Applications shown to the agent in a screenshot: the reply block, matching
// against what Landed has, and adding with a click.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { parseChatHistory, parseChatImages, parseConversation } from '@landed/schema/conversation'
import { extractApplications, parseReportedApplications } from '@landed/schema/reported-application'
import { addReportedApplication, isForward, matchReported } from './inbox'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-reported-${++n}`)

const reply = (json: string) => `Got it — Blorp Inc, Backend Engineer.\n\n\`\`\`landed-applications\n${json}\n\`\`\`\n`

describe('the reply block', () => {
  test('parsed out of the reply; the text stays readable; half-streamed is "drafting"', () => {
    const r = extractApplications(reply('{"applications":[{"company":"Blorp Inc","role":"Backend Engineer, Payments","stage":"applied","applied_on":"2026-10-13","job_url":null,"location":"Seattle, WA","note":"Req R-20417"}]}'))
    expect(r.text).toBe('Got it — Blorp Inc, Backend Engineer.')
    expect(r.applications).toEqual([{ company: 'Blorp Inc', role: 'Backend Engineer, Payments', stage: 'applied', applied_on: '2026-10-13', job_url: null, location: 'Seattle, WA', note: 'Req R-20417' }])
    expect(extractApplications('Reading it…\n```landed-applications\n{"applica').drafting).toBe(true)
    expect(extractApplications('no block here').applications).toEqual([])
  })

  test('untrusted: needs company + role, known stages, real dates, http links; deduped; bounded', () => {
    const out = parseReportedApplications({ applications: [
      { company: 'A', role: 'PM', stage: 'hired', applied_on: '2026-02-30', job_url: 'javascript:alert(1)' },
      { company: 'A', role: 'PM' },
      { company: '', role: 'x' },
      { company: 'B', role: 'SWE', stage: 'interview', job_url: 'https://jobs.example/b/1' },
      ...Array.from({ length: 30 }, (_, i) => ({ company: `C${i}`, role: 'R' })),
    ] })
    expect(out[0]).toMatchObject({ company: 'A', stage: 'applied', applied_on: null, job_url: null })
    expect(out[1]).toMatchObject({ company: 'B', stage: 'interview', job_url: 'https://jobs.example/b/1' })
    expect(out).toHaveLength(20)
  })
})

describe('screenshots in the chat', () => {
  const png = btoa('not really a png, but base64')
  test('task images: known types, base64, at most 4', () => {
    expect(parseChatImages([{ type: 'image/png', data_base64: png }, { type: 'application/pdf', data_base64: png }, { type: 'image/jpeg', data_base64: 'not base64!' }])).toEqual([{ type: 'image/png', data_base64: png }])
    expect(parseChatImages(Array.from({ length: 6 }, () => ({ type: 'image/png', data_base64: png })))).toHaveLength(4)
    expect(parseChatImages([{ type: 'image/png', data_base64: 'A'.repeat(4_000_004) }])).toEqual([])
  })

  test('the conversation keeps only small previews, and history mentions them', () => {
    const thumb = `data:image/jpeg;base64,${png}`
    const conv = parseConversation({ id: crypto.randomUUID(), turns: [{ role: 'user', text: '', images: [{ name: 'a.png', thumb }, { name: 'huge', thumb: `data:image/jpeg;base64,${'A'.repeat(50_000)}` }] }] })
    expect(conv!.turns[0].images).toEqual([{ name: 'a.png', thumb }])
    expect(parseChatHistory(conv!.turns)).toEqual([{ role: 'user', text: '[attached a screenshot]' }])
  })
})

describe('adding them', () => {
  const r = (over: Partial<ReturnType<typeof parseReportedApplications>[number]> = {}) => ({
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
