// jobright's lists → Leads, through the real local store and processor.
// Made-up companies and ids, in jobright's README format and Lever's real
// response format.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import { boardListUrl, jobrightUrl } from '@landed/supply'
import { forgetResolvedBoards } from './boards'
import { refreshJobright } from './jobright'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-jobright-${++n}`)
const now = new Date(Date.UTC(2026, 9, 22, 18))
const later = (days: number) => new Date(now.getTime() + days * 86_400_000)

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Data Analyst'], seniority: 'new grad', locations: [], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

const README = `| Company | Job Title | Location | Work Model | Date Posted |
| ----- | --------- |  --------- | ---- | ------- |
| **[Bluefin Analytics](https://bluefin.example.com)** | **[Data Analyst I](https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa1?utm_source=1103)** | Seattle, WA, United States | Hybrid | Oct 21 |
| ↳ | **[Business Intelligence Analyst](https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa2?utm_source=1103)** | Remote in USA | Remote | Oct 20 |
| **[Kestrel Pay](https://kestrel.example.com)** | **[Data Analyst](https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa3?utm_source=1103)** | New York, NY, United States | On Site | Oct 22 |
`
const LEVER_ID = '10dfc8bc-99ad-4ca2-ab76-853cb90a92c2'
/** Bluefin's Lever board: "Data Analyst I" is always the same posting. */
const leverId = (text: string) => (text === 'Data Analyst I' ? LEVER_ID : `20dfc8bc-99ad-4ca2-ab76-${String(text.length).padStart(12, '0')}`)
const lever = (titles: string[]) => titles.map((text) => ({
  id: leverId(text), text,
  hostedUrl: `https://jobs.lever.co/bluefin/${leverId(text)}`, createdAt: Date.UTC(2026, 9, 19),
  categories: { location: 'Seattle, WA', allLocations: ['Seattle, WA'] }, workplaceType: 'hybrid',
  descriptionPlain: `${text} at Bluefin Analytics: own product metrics in SQL.`, lists: [],
}))

/** A fake network: URL → body (text for the README, JSON for boards; 404 otherwise). */
function network(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(String(url))
    const body = routes[String(url)]
    if (body === undefined) return new Response('Not Found', { status: 404 })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

const readmeUrl = jobrightUrl('2026-Data-Analysis-New-Grad')
const bluefinBoard = boardListUrl({ ats: 'lever', board: 'bluefin' })

beforeEach(() => forgetResolvedBoards())

describe('refreshJobright', () => {
  test('rows become leads; the one whose company board has the very same title gets that posting, the rest keep jobright\'s page', async () => {
    const store = fresh()
    const { fetchFn } = network({ [readmeUrl]: README, [bluefinBoard]: lever(['Data Analyst I', 'Senior Data Analyst']) })
    const r = await refreshJobright(store, brief(), { fetchFn, now })
    expect(r).toMatchObject({ lists: ['2026-Data-Analysis-New-Grad'], failed: [], found: 3, added: 3, linked: 1, closed: 0 })
    const leads = await store.listJobLeads()
    const byTitle = Object.fromEntries(leads.map((l) => [l.title, l]))
    expect(byTitle['Data Analyst I']).toMatchObject({
      company_name: 'Bluefin Analytics', job_url: `https://jobs.lever.co/bluefin/${LEVER_ID}`, location: 'Seattle, WA',
      description: 'Data Analyst I at Bluefin Analytics: own product metrics in SQL.',
    })
    expect(byTitle['Business Intelligence Analyst'].job_url).toBe('https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa2')
    expect(byTitle['Data Analyst'].job_url).toBe('https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa3')
    expect(byTitle['Data Analyst I'].sources.map((s) => s.observation_id)).toEqual(['jobright:aaaaaaaaaaaaaaaaaaaaaaa1'])
    // Posting dates: the company's posting's, else the row's.
    expect([byTitle['Data Analyst I'].posted_at, byTitle['Business Intelligence Analyst'].posted_at]).toEqual(['2026-10-19', '2026-10-20'])

    // Again: nothing new, and no board looked for again for rows already in.
    const again = network({ [readmeUrl]: README, [bluefinBoard]: lever(['Data Analyst I']) })
    expect(await refreshJobright(store, brief(), { fetchFn: again.fetchFn, now })).toMatchObject({ added: 0, linked: 0, closed: 0 })
    expect(again.calls.filter((u) => u.includes('greenhouse') || u.includes('ashbyhq'))).toEqual([])
  })

  test('closed: on the company\'s posting, once its board no longer lists it; on jobright\'s page, 30 days after it was posted', async () => {
    const store = fresh()
    await refreshJobright(store, brief(), { fetchFn: network({ [readmeUrl]: README, [bluefinBoard]: lever(['Data Analyst I']) }).fetchFn, now })
    // Two days on: the posting left Bluefin's board; jobright's rows are still recent.
    const gone = network({ [readmeUrl]: README, [bluefinBoard]: lever(['Senior Data Analyst']) })
    expect(await refreshJobright(store, brief(), { fetchFn: gone.fetchFn, now: later(2) })).toMatchObject({ closed: 1 })
    let leads = await store.listJobLeads()
    expect(leads.filter((l) => l.closed_at).map((l) => l.title)).toEqual(['Data Analyst I'])
    // A board that can't be fetched says nothing.
    // Forty days on: the two still on jobright's page are past its 30 days.
    const old = network({ [readmeUrl]: README })
    expect(await refreshJobright(store, brief(), { fetchFn: old.fetchFn, now: later(40) })).toMatchObject({ closed: 2 })
    leads = await store.listJobLeads()
    expect(leads.every((l) => l.closed_at)).toBe(true)
  })

  test('a list that can\'t be read is reported; a search with no product, data or business role reads none', async () => {
    const store = fresh()
    expect(await refreshJobright(store, brief(), { fetchFn: network({}).fetchFn, now })).toMatchObject({ failed: ['2026-Data-Analysis-New-Grad'], added: 0 })
    const none = network({})
    expect(await refreshJobright(store, brief({ roles: ['Software Engineer'] }), { fetchFn: none.fetchFn, now })).toMatchObject({ lists: [], added: 0 })
    expect(none.calls).toEqual([])
  })
})
