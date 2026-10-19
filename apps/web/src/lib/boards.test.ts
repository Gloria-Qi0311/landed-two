// Company job boards → Leads, through the real local store and processor.
// Made-up companies, in each ATS's real response format.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import { followedBoards, forgetResolvedBoards, refreshBoards, resolveBoards, type FollowedBoard } from './boards'
import { ingestFoundJobs } from './inbox'
import { createLocalStore } from './store/local'
import type { DbJobLead } from './store/types'

let n = 0
const fresh = () => createLocalStore(`landed-boards-${++n}`)
const now = new Date(2026, 9, 18, 12)

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Software Engineer'], seniority: null, locations: ['Seattle'], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

const gh = (id: number, title: string, location: string) => ({
  id, title, absolute_url: `https://job-boards.greenhouse.io/northwind/jobs/${id}`, location: { name: location },
  company_name: 'Northwind Robotics', first_published: '2026-10-10T09:00:00-07:00', updated_at: '2026-10-12T09:00:00-07:00', application_deadline: null,
})
const ashby = (id: string, title: string, location: string, over: Record<string, unknown> = {}) => ({
  id, title, location, secondaryLocations: [], publishedAt: '2026-10-01T12:00:00.000+00:00', isListed: true, isRemote: false,
  jobUrl: `https://jobs.ashbyhq.com/lumen/${id}`, descriptionPlain: `${title} at Lumen Labs. Visa sponsorship is not available.`, ...over,
})
const LUMEN_SWE = '11111111-2222-3333-4444-555555555555'

/** A fake network: list and job URLs → bodies (404 for anything else). */
function network(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(String(url))
    const body = routes[String(url)]
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

const GH_LIST = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs'
const ASHBY_LIST = 'https://api.ashbyhq.com/posting-api/job-board/lumen'
const boards: FollowedBoard[] = [
  { ats: 'greenhouse', board: 'northwind', company: 'Northwind Robotics', from: 'application' },
  { ats: 'ashby', board: 'lumen', company: 'Lumen Labs', from: 'search' },
]
const routes = (): Record<string, unknown> => ({
  [GH_LIST]: { jobs: [gh(1001, 'Software Engineer, Robotics', 'Seattle, WA'), gh(1002, 'Recruiter', 'Seattle, WA'), gh(1003, 'Software Engineer', 'Austin, TX')], meta: { total: 3 } },
  [`${GH_LIST}/1001`]: { ...gh(1001, 'Software Engineer, Robotics', 'Seattle, WA'), content: '&lt;p&gt;Build robots. &lt;strong&gt;US citizenship required.&lt;/strong&gt;&lt;/p&gt;' },
  [ASHBY_LIST]: { apiVersion: '1', jobs: [ashby(LUMEN_SWE, 'Software Engineer, Backend', 'Seattle, WA')] },
})

describe('followedBoards', () => {
  const lead = (over: Partial<DbJobLead>) => ({
    id: crypto.randomUUID(), company_name: 'Kestrel Finance', job_url: 'https://jobs.lever.co/kestrel/9f0c0b3e-1a2b-4c3d-8e9f-001122334455',
    status: 'saved', closed_at: null, last_seen_at: '2026-10-17T00:00:00Z', sources: [], ...over,
  }) as DbJobLead

  test('applications, approved leads and "Look at first" companies; Skip removes one; one entry per board', () => {
    const list = followedBoards({
      applications: [
        { id: 'a1', company_id: 'c1', created_at: '2026-10-01T00:00:00Z', portal_application_url: 'https://job-boards.greenhouse.io/northwind/jobs/1' },
        { id: 'a2', company_id: 'c1', created_at: '2026-10-02T00:00:00Z', portal_application_url: 'https://job-boards.greenhouse.io/northwind/jobs/2' },
        { id: 'a3', company_id: 'c2', created_at: '2026-10-03T00:00:00Z', portal_application_url: 'https://aurora.wd5.myworkdayjobs.com/x/job/y_R1' },
      ] as never,
      companies: [{ id: 'c1', name: 'Northwind Robotics' }, { id: 'c2', name: 'Aurora Bio' }] as never,
      leads: [
        lead({}),
        lead({ company_name: 'Candidate Co', job_url: 'https://jobs.lever.co/candidate/1', status: 'new' }), // not approved
        lead({ company_name: 'Gone Co', job_url: 'https://jobs.lever.co/gone/1', closed_at: '2026-10-10T00:00:00Z' }),
      ],
      brief: brief({ include_companies: ['Lumen Labs', 'Nobody Inc'], exclude_companies: ['Kestrel Finance'] }),
      resolved: new Map([['lumen labs', { ats: 'ashby', board: 'lumen' }], ['nobody', null]]),
    })
    expect(list).toEqual([
      { ats: 'ashby', board: 'lumen', company: 'Lumen Labs', from: 'search' },
      { ats: 'greenhouse', board: 'northwind', company: 'Northwind Robotics', from: 'application' },
    ])
  })
})

describe('resolveBoards', () => {
  beforeEach(() => forgetResolvedBoards())
  test('tries the company\'s slugs on each ATS; the first with postings wins; remembered for the session', async () => {
    const net = network({ [ASHBY_LIST]: routes()[ASHBY_LIST] })
    const resolved = await resolveBoards(['Lumen Labs', 'Nobody Inc'], net.fetchFn)
    expect(resolved.get('lumen labs')).toEqual({ ats: 'ashby', board: 'lumen' })
    expect(resolved.get('nobody')).toBeNull()
    const asked = net.calls.length
    await resolveBoards(['Lumen Labs'], net.fetchFn)
    expect(net.calls.length).toBe(asked)
  })
})

describe('refreshBoards', () => {
  test('postings that fit the search become leads, with the full description and posting date', async () => {
    const store = fresh()
    const net = network(routes())
    const r = await refreshBoards(store, brief(), boards, { fetchFn: net.fetchFn, now })
    expect(r).toMatchObject({ boards: 2, found: 2, added: 2, closed: 0, failed: [] })
    const leads = await store.listJobLeads()
    const nw = leads.find((l) => l.company_name === 'Northwind Robotics')!
    expect(nw).toMatchObject({ title: 'Software Engineer, Robotics', posted_at: '2026-10-10', ats_key: 'greenhouse:1001' })
    expect(nw.description).toBe('Build robots. US citizenship required.')
    expect(nw.sources[0].provider).toBe('Greenhouse · Northwind Robotics')
    expect(leads.find((l) => l.company_name === 'Lumen Labs')!.description).toMatch(/sponsorship is not available/)
    // Only the postings kept get their description fetched.
    expect(net.calls.filter((u) => u.startsWith(`${GH_LIST}/`))).toEqual([`${GH_LIST}/1001`])
  })

  test('refreshing again changes nothing; a posting an agent found too is one lead with both sources', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [{
      company: 'Lumen Labs', title: 'Software Engineer, Backend', job_url: `https://jobs.ashbyhq.com/lumen/${LUMEN_SWE}`,
      location: 'Seattle, WA', posted: null, deadline: null, salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    const net = network(routes())
    await refreshBoards(store, brief(), boards, { fetchFn: net.fetchFn, now })
    const again = await refreshBoards(store, brief(), boards, { fetchFn: net.fetchFn, now })
    expect(again).toMatchObject({ added: 0, closed: 0 })
    const lumen = (await store.listJobLeads()).filter((l) => l.company_name === 'Lumen Labs')
    expect(lumen).toHaveLength(1)
    expect(lumen[0].sources.map((s) => s.provider)).toEqual(['claude', 'Ashby · Lumen Labs'])
  })

  test('a posting gone from its board is closed — also one only an agent found there; the data stays', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [{
      company: 'Northwind Robotics', title: 'Staff Engineer', job_url: 'https://job-boards.greenhouse.io/northwind/jobs/999',
      location: 'Seattle, WA', posted: null, deadline: null, salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    const before = routes()
    before[GH_LIST] = { jobs: [...(before[GH_LIST] as { jobs: unknown[] }).jobs, gh(999, 'Staff Engineer', 'Seattle, WA')], meta: { total: 4 } }
    await refreshBoards(store, brief(), boards, { fetchFn: network(before).fetchFn, now })
    expect((await store.listJobLeads()).every((l) => l.closed_at === null)).toBe(true)
    const later = new Date(2026, 9, 20, 9)
    const after = routes()
    after[GH_LIST] = { jobs: [gh(1003, 'Software Engineer', 'Austin, TX')], meta: { total: 1 } }
    const r = await refreshBoards(store, brief(), boards, { fetchFn: network(after).fetchFn, now: later })
    expect(r.closed).toBe(2)
    const leads = await store.listJobLeads()
    const closed = leads.filter((l) => l.closed_at === later.toISOString()).map((l) => l.title).sort()
    expect(closed).toEqual(['Software Engineer, Robotics', 'Staff Engineer'])
    expect(leads.find((l) => l.company_name === 'Lumen Labs')!.closed_at).toBeNull()
  })

  test('an unlisted Ashby posting is still open: not closed, not a new lead', async () => {
    const store = fresh()
    await refreshBoards(store, brief(), boards, { fetchFn: network(routes()).fetchFn, now })
    const hidden = routes()
    hidden[ASHBY_LIST] = { apiVersion: '1', jobs: [ashby(LUMEN_SWE, 'Software Engineer, Backend', 'Seattle, WA', { isListed: false })] }
    expect(await refreshBoards(store, brief(), boards, { fetchFn: network(hidden).fetchFn, now })).toMatchObject({ closed: 0 })
  })

  test('a board that can\'t be fetched (or isn\'t a board) is reported and closes nothing', async () => {
    const store = fresh()
    await refreshBoards(store, brief(), boards, { fetchFn: network(routes()).fetchFn, now })
    const broken = { [GH_LIST]: '<html>maintenance</html>' }
    const r = await refreshBoards(store, brief(), boards, { fetchFn: network(broken).fetchFn, now })
    expect(r.failed.sort()).toEqual(['ashby:lumen', 'greenhouse:northwind'])
    expect((await store.listJobLeads()).every((l) => l.closed_at === null)).toBe(true)
  })
})

describe('Lever: only a posting seen listed can close (review of #104)', () => {
  const LEVER_LIST = 'https://api.lever.co/v0/postings/kestrel?mode=json'
  const UNLISTED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const LISTED = '99999999-8888-7777-6666-555555555555'
  const lever = [{ ats: 'lever', board: 'kestrel', company: 'Kestrel Finance', from: 'application' }] as FollowedBoard[]
  const posting = (id: string) => ({
    id, text: 'Software Engineer', hostedUrl: `https://jobs.lever.co/kestrel/${id}`, createdAt: Date.UTC(2026, 9, 1),
    categories: { location: 'Seattle, WA', allLocations: ['Seattle, WA'] }, descriptionPlain: 'Build things.', lists: [],
  })

  test('a posting shared by link alone (never on the list) stays open; one that was listed and left closes', async () => {
    const store = fresh()
    await ingestFoundJobs(store, [{
      company: 'Kestrel Finance', title: 'Software Engineer (by link)', job_url: `https://jobs.lever.co/kestrel/${UNLISTED}`,
      location: 'Seattle, WA', posted: null, deadline: null, salary: null, sponsorship: null, why: null,
    }], { run_id: 'job-1', runtime_id: 'mac', agent: 'claude' })
    await refreshBoards(store, brief(), lever, { fetchFn: network({ [LEVER_LIST]: [posting(LISTED)] }).fetchFn, now })
    const later = new Date(2026, 9, 20, 9)
    const r = await refreshBoards(store, brief(), lever, { fetchFn: network({ [LEVER_LIST]: [] }).fetchFn, now: later })
    expect(r.closed).toBe(1)
    const leads = await store.listJobLeads()
    expect(leads.find((l) => l.job_url!.includes(UNLISTED))!.closed_at).toBeNull()
    expect(leads.find((l) => l.job_url!.includes(LISTED))!.closed_at).toBe(later.toISOString())
  })
})
