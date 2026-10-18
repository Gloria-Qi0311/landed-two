// SimplifyJobs lists → Leads, through the real local store and processor.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import { SIMPLIFY_LISTS } from '@landed/supply'
import { ingestFoundJobs } from './inbox'
import { createLocalStore } from './store/local'
import { refreshSimplify } from './supply'

let n = 0
const fresh = () => createLocalStore(`landed-supply-${++n}`)
const now = new Date(2026, 9, 18, 12)
const sec = (iso: string) => Date.parse(iso) / 1000

const brief: SearchBrief = {
  summary: 'New grad software roles in Seattle', roles: ['Software Engineer'], seniority: 'new grad', locations: ['Seattle'], remote: 'any',
  needs_sponsorship: null, salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null,
}

// Made-up companies, in the lists' real format.
const listing = (over: Record<string, unknown>) => ({
  source: 'Simplify', category: 'Software', id: 'nw-1', company_name: 'Northwind Robotics', title: 'Software Engineer, New Grad',
  active: true, date_updated: sec('2026-10-17T00:00:00Z'), date_posted: sec('2026-10-16T12:00:00Z'),
  url: 'https://job-boards.greenhouse.io/northwind/jobs/1001', locations: ['Seattle, WA'], company_url: '', is_visible: true,
  sponsorship: 'Other', degrees: ["Bachelor's"], ...over,
})

function lists(rows: unknown[], failing = false) {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(String(url))
    if (failing) return new Response('rate limited', { status: 429 })
    return new Response(JSON.stringify(url === SIMPLIFY_LISTS.new_grad.url ? rows : []), { status: 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('refreshSimplify', () => {
  test('postings that fit the search become leads, with their posting date; the rest stay out', async () => {
    const store = fresh()
    const { fetchFn, calls } = lists([
      listing({}),
      listing({ id: 'lm-1', company_name: 'Lumen Labs', title: 'Data Scientist', url: 'https://jobs.example.com/lumen/1' }), // other role
      listing({ id: 'ak-1', company_name: 'Aurora Bio', url: 'https://jobs.example.com/aurora/1', locations: ['Austin, TX'] }), // elsewhere
      listing({ id: 'ks-1', company_name: 'Kestrel Finance', url: 'https://jobs.example.com/kestrel/1', active: false }), // closed
      listing({ id: 'old-1', company_name: 'Old Co', url: 'https://jobs.example.com/old/1', date_posted: sec('2026-06-01T00:00:00Z') }), // old
      { broken: true },
    ])
    const r = await refreshSimplify(store, brief, { fetchFn, now })
    expect(calls).toEqual([SIMPLIFY_LISTS.new_grad.url])
    expect(r).toMatchObject({ lists: ['new_grad'], found: 1, added: 1, closed: 0, failed: [] })
    const [lead] = await store.listJobLeads()
    expect(lead).toMatchObject({ company_name: 'Northwind Robotics', posted_at: '2026-10-16', closed_at: null, status: 'new' })
    expect(lead.sources.map((s) => s.provider)).toEqual(['SimplifyJobs New Grad'])
  })

  test('refreshing again changes nothing: the same posting is not a second source', async () => {
    const store = fresh()
    const { fetchFn } = lists([listing({})])
    await refreshSimplify(store, brief, { fetchFn, now })
    const again = await refreshSimplify(store, brief, { fetchFn, now })
    expect(again).toMatchObject({ added: 0, closed: 0 })
    const leads = await store.listJobLeads()
    expect(leads).toHaveLength(1)
    expect(leads[0].sources).toHaveLength(1)
  })

  test('a posting an agent found too is one lead with both sources', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [{
      company: 'Northwind Robotics', title: 'Software Engineer, New Grad', job_url: 'https://job-boards.greenhouse.io/northwind/jobs/1001',
      location: 'Seattle, WA', posted: null, deadline: '2026-11-01', salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    const { fetchFn } = lists([listing({})])
    expect(await refreshSimplify(store, brief, { fetchFn, now })).toMatchObject({ added: 0, merged: 1 })
    const leads = await store.listJobLeads()
    expect(leads).toHaveLength(1)
    expect(leads[0].sources.map((s) => s.provider)).toEqual(['claude', 'SimplifyJobs New Grad'])
    expect(leads[0]).toMatchObject({ deadline: '2026-11-01', posted_at: '2026-10-16' })
  })

  test('once the list marks the posting closed (or drops it), the lead gets closed_at; its data stays', async () => {
    const store = fresh()
    await refreshSimplify(store, brief, { fetchFn: lists([listing({}), listing({ id: 'nw-2', title: 'Software Engineer I', url: 'https://jobs.example.com/nw/2' })]).fetchFn, now })
    const later = new Date(2026, 9, 20, 9)
    const r = await refreshSimplify(store, brief, { fetchFn: lists([listing({ active: false })]).fetchFn, now: later })
    expect(r.closed).toBe(2)
    const leads = await store.listJobLeads()
    expect(leads.map((l) => l.closed_at)).toEqual([later.toISOString(), later.toISOString()])
    expect(leads.every((l) => l.status === 'new')).toBe(true)
  })

  test('a list that can\'t be fetched is reported, and nothing is closed because of it', async () => {
    const store = fresh()
    await refreshSimplify(store, brief, { fetchFn: lists([listing({})]).fetchFn, now })
    const r = await refreshSimplify(store, brief, { fetchFn: lists([], true).fetchFn, now })
    expect(r).toMatchObject({ failed: ['new_grad'], added: 0, closed: 0 })
    expect((await store.listJobLeads())[0].closed_at).toBeNull()
  })

  test('a senior search checks no list', async () => {
    const store = fresh()
    const { fetchFn, calls } = lists([listing({})])
    expect(await refreshSimplify(store, { ...brief, seniority: 'senior' }, { fetchFn, now })).toMatchObject({ lists: [], found: 0 })
    expect(calls).toEqual([])
  })
})
