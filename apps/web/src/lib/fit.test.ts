// Fit scores and the Leads order, through the real local store.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { emptyResume } from '@landed/schema'
import { UNRANKED } from '@landed/supply'
import { ingestFoundJobs } from './inbox'
import { byPriority, rankOf, scoreLeads } from './fit'
import { createLocalStore } from './store/local'
import type { DbJobLead } from './store/types'

let n = 0
const fresh = () => createLocalStore(`landed-fit-${++n}`)
const now = new Date(2026, 9, 18, 12)
const brief = {
  summary: 'x', roles: ['Software Engineer'], seniority: 'new grad', locations: ['Seattle'], remote: 'any' as const, needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null,
}
const job = (company: string, title: string, location: string, deadline: string | null = null) => ({
  company, title, job_url: `https://jobs.example.com/${encodeURIComponent(company + title)}`, location, posted: null, deadline, salary: null, sponsorship: null, why: null,
})

describe('scoreLeads', () => {
  test('scores candidates against the active search and the resume; writes only what changed', async () => {
    const store = fresh()
    await store.addJobSearch(brief)
    await store.addResume({ name: 'Mine', set_current: true, parsed_json: { ...emptyResume(), skills: ['Python', 'SQL'] } })
    await ingestFoundJobs(store, [
      job('Northwind Robotics', 'Software Engineer', 'Seattle, WA'),
      job('Lumen Labs', 'Account Executive', 'Austin, TX'),
    ], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    expect(await scoreLeads(store, now)).toBe(2)
    const leads = Object.fromEntries((await store.listJobLeads()).map((l) => [l.company_name, l]))
    expect(leads['Northwind Robotics'].fit).toEqual({ score: 1, reasons: ['Title matches "Software Engineer"', 'In Seattle, WA', 'Level fits new grad'] })
    expect(leads['Lumen Labs'].fit!.score).toBeLessThan(0.3)
    expect(await scoreLeads(store, now)).toBe(0)
  })

  test('no search yet: nothing to score with', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [job('Northwind Robotics', 'Software Engineer', 'Seattle, WA')], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    expect(await scoreLeads(store, now)).toBe(0)
    expect((await store.listJobLeads())[0].fit).toBeNull()
  })
})

describe('the Leads order', () => {
  const lead = (over: Partial<DbJobLead>) => ({ deadline: null, posted_at: null, closed_at: null, screen: null, fit: null, ...over }) as DbJobLead
  const order = (items: Parameters<typeof rankOf>[0][], leadFor: (id: string) => DbJobLead | undefined = () => undefined) =>
    items.map((item) => ({ item, rank: rankOf(item, leadFor, now) })).sort((a, b) => byPriority(a.rank, b.rank)).map(({ item }) => item.lead?.title ?? item.app!.id)

  test('a good fit due soon first; fit counts more than urgency; past deadlines last', () => {
    expect(order([
      { lead: lead({ title: 'far, good', fit: { score: 0.9, reasons: [] }, deadline: '2026-12-15' }) },
      { lead: lead({ title: 'expired', fit: { score: 1, reasons: [] }, deadline: '2026-10-10' }) },
      { lead: lead({ title: 'soon, good', fit: { score: 0.9, reasons: [] }, deadline: '2026-10-21' }) },
      { lead: lead({ title: 'soon, poor', fit: { score: 0.3, reasons: [] }, deadline: '2026-10-21' }) },
    ])).toEqual(['soon, good', 'far, good', 'soon, poor', 'expired'])
    expect(rankOf({ lead: lead({ title: 'x', deadline: '2026-10-10' }) }, () => undefined, now).priority).toBe(UNRANKED)
  })

  test('a saved application ranks by the lead it came from, else by its deadline as an unscored lead', () => {
    const from = lead({ title: 'its lead', fit: { score: 0.95, reasons: [] } })
    expect(order([
      { app: { id: 'added by hand', deadline: '2026-10-20' } },
      { app: { id: 'from a lead', deadline: '2026-10-20' } },
      { lead: lead({ title: 'unscored lead', deadline: '2026-11-30' }) },
    ], (id) => (id === 'from a lead' ? from : undefined))).toEqual(['from a lead', 'added by hand', 'unscored lead'])
  })
})
