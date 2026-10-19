// Hard filters on Leads, through the real local store.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { emptyResume } from '@landed/schema'
import { EMPTY_ANSWERS } from '@landed/schema/application-answers'
import { PUT_BACK } from '@landed/supply'
import { ingestFoundJobs } from './inbox'
import { putBack, screenLeads, screenedOut } from './screen'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-screen-${++n}`)

// Made-up companies; descriptions as the sources would give them.
async function seed(store: ReturnType<typeof fresh>) {
  const job = (company: string, title: string, why: string | null, sponsorship: string | null = null) => ({
    company, title, job_url: `https://jobs.example.com/${encodeURIComponent(company)}/1`, location: 'Seattle, WA', posted: null,
    deadline: null, salary: null, sponsorship, why,
  })
  await ingestFoundJobs(store, [
    job('Northwind Robotics', 'Software Engineer', 'We are unable to sponsor employment visas for this role.'),
    job('Lumen Labs', 'Software Engineer, New Grad', 'For candidates graduating between December 2025 and June 2026.'),
    job('Aurora Bio', 'Software Engineer', null, 'U.S. Citizenship is Required'), // a SimplifyJobs label
    job('Kestrel Finance', 'Software Engineer', 'We sponsor visas.'),
  ], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
  return Object.fromEntries((await store.listJobLeads()).map((l) => [l.company_name, l]))
}

const byCompany = async (store: ReturnType<typeof fresh>) => Object.fromEntries((await store.listJobLeads()).map((l) => [l.company_name, l]))

describe('screenLeads', () => {
  test('needs sponsorship and graduates May 2025: three are screened out, with their reasons', async () => {
    const store = fresh()
    await seed(store)
    await store.saveApplicationAnswers({ ...EMPTY_ANSWERS, needs_sponsorship: 'yes', work_authorized: 'yes' })
    // No master yet: the current resume is read.
    await store.addResume({ name: 'My resume', set_current: true, parsed_json: { ...emptyResume(), education: [{ ...emptyResume().education[0], school: 'State University', degree: 'BS', major: 'CS', gpa: '', start_date: '2021-09', end_date: '2025-05', location: '', description: '' }] } })

    expect(await screenLeads(store)).toBe(4)
    const leads = await byCompany(store)
    expect(leads['Northwind Robotics'].screen).toEqual({ pass: false, reasons: ["Says it doesn't sponsor visas; you need sponsorship"] })
    expect(leads['Lumen Labs'].screen).toEqual({ pass: false, reasons: ['Wants graduates Dec 2025 – Jun 2026; you graduate May 2025'] })
    expect(leads['Aurora Bio'].screen).toEqual({ pass: false, reasons: ['Requires US citizenship or a security clearance; you need sponsorship'] })
    expect(leads['Kestrel Finance'].screen).toEqual({ pass: true, reasons: [] })
    expect(Object.values(leads).filter(screenedOut)).toHaveLength(3)
    // Nothing changed: nothing written.
    expect(await screenLeads(store)).toBe(0)
  })

  test('answers change → screened again; a lead put back stays back; nothing is deleted', async () => {
    const store = fresh()
    const seeded = await seed(store)
    const saved = await store.saveApplicationAnswers({ ...EMPTY_ANSWERS, needs_sponsorship: 'yes' })
    await screenLeads(store)
    await putBack(store, seeded['Aurora Bio'])

    await store.saveApplicationAnswers({ ...saved.answers, needs_sponsorship: 'no' })
    await screenLeads(store)
    const leads = await byCompany(store)
    expect(leads['Northwind Robotics'].screen).toEqual({ pass: true, reasons: [] })
    expect(leads['Aurora Bio'].screen).toEqual({ pass: true, reasons: [PUT_BACK] })

    await store.saveApplicationAnswers({ ...saved.answers, needs_sponsorship: 'yes' })
    await screenLeads(store)
    expect((await byCompany(store))['Aurora Bio'].screen).toEqual({ pass: true, reasons: [PUT_BACK] })
    expect(await store.listJobLeads()).toHaveLength(4)
  })

  test('no resume and no answers: nothing to screen with, nothing hidden', async () => {
    const store = fresh()
    await seed(store)
    expect(await screenLeads(store)).toBe(0)
    expect((await store.listJobLeads()).every((l) => l.screen === null)).toBe(true)
  })

  test('only candidates are screened: approved, dismissed and closed leads are left as they are', async () => {
    const store = fresh()
    const seeded = await seed(store)
    await store.updateJobLead(seeded['Northwind Robotics'].id, { status: 'dismissed' })
    await store.updateJobLead(seeded['Aurora Bio'].id, { closed_at: '2026-10-17T00:00:00Z' })
    await store.saveApplicationAnswers({ ...EMPTY_ANSWERS, needs_sponsorship: 'yes' })
    await screenLeads(store)
    const leads = await byCompany(store)
    expect(leads['Northwind Robotics'].screen).toBeNull()
    expect(leads['Aurora Bio'].screen).toBeNull()
  })
})
