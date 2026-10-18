import { describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  levelMatches, boardFromUrl, boardListUrl, boardObservationId, boardSourceOf, greenhouseJobUrl, htmlToText, MAX_DESCRIPTION, parseAshbyJobs, parseBoard,
  parseGreenhouseJob, parseGreenhouseJobs, parseLeverPostings, postingIdFromAtsKey, postingToFoundJob, selectPostings, slugCandidates,
} from '../src'
// Real public responses (2026-10-18), trimmed to a few postings and shorter
// descriptions: Greenhouse /v1/boards/stripe/jobs and one job with content,
// Lever /v0/postings/palantir?mode=json, Ashby /posting-api/job-board/ramp.
import ashby from './fixtures/ashby-ramp.json'
import greenhouseJob from './fixtures/greenhouse-stripe-job.json'
import greenhouse from './fixtures/greenhouse-stripe.json'
import lever from './fixtures/lever-palantir.json'

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Software Engineer'], seniority: null, locations: [], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

describe('boardFromUrl', () => {
  test.each([
    ['https://boards.greenhouse.io/stripe/jobs/8172510', { ats: 'greenhouse', board: 'stripe' }],
    ['https://job-boards.greenhouse.io/Axon/jobs/7703668003?utm_source=Simplify', { ats: 'greenhouse', board: 'axon' }],
    ['https://boards.greenhouse.io/embed/job_app?for=figma&token=123', { ats: 'greenhouse', board: 'figma' }],
    ['https://jobs.lever.co/palantir/10dfc8bc-99ad-4ca2-ab76-853cb90a92c2/apply', { ats: 'lever', board: 'palantir' }],
    ['https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245', { ats: 'ashby', board: 'ramp' }],
  ])('%s', (url, board) => expect(boardFromUrl(url)).toEqual(board))

  test('links that name no board', () => {
    for (const url of ['https://stripe.com/jobs/search?gh_jid=8172510', 'https://acme.wd5.myworkdayjobs.com/x/job/y_R1', 'not a url', null, 'https://boards.greenhouse.io/embed/job_app']) {
      expect(boardFromUrl(url)).toBeNull()
    }
  })
})

test('list and job URLs', () => {
  expect(boardListUrl({ ats: 'greenhouse', board: 'stripe' })).toBe('https://boards-api.greenhouse.io/v1/boards/stripe/jobs')
  expect(boardListUrl({ ats: 'lever', board: 'palantir' })).toBe('https://api.lever.co/v0/postings/palantir?mode=json')
  expect(boardListUrl({ ats: 'ashby', board: 'ramp' })).toBe('https://api.ashbyhq.com/posting-api/job-board/ramp')
  expect(greenhouseJobUrl('stripe', '8172503')).toBe('https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172503')
})

describe('parsers (real formats)', () => {
  test('Greenhouse list: company, first-published date, places; no description until the job is fetched', () => {
    const jobs = parseGreenhouseJobs(greenhouse)
    expect(jobs).toHaveLength(6)
    expect(jobs[0]).toMatchObject({ id: '8172503', company: 'Stripe', title: 'Abuse Research Engineer', posted_at: '2026-09-09', remote: true, description: null })
    expect(jobs.find((j) => j.id === '8172510')!.locations).toEqual(['Seattle, San Francisco, New York City'])
  })

  test('Greenhouse job: its escaped HTML description becomes plain text', () => {
    const job = parseGreenhouseJob(greenhouseJob)!
    expect(job.description).toMatch(/Who we are/)
    expect(job.description).not.toMatch(/<|&lt;|&amp;/)
  })

  test('Lever: posting time in ms, every location, description with its lists', () => {
    const jobs = parseLeverPostings(lever)
    expect(jobs).toHaveLength(4)
    expect(jobs[1]).toMatchObject({ title: 'Backend Software Engineer - Application Development', company: null, locations: ['New York, NY'], posted_at: '2024-03-11' })
    expect(jobs[1].url).toMatch(/^https:\/\/jobs\.lever\.co\/palantir\//)
    expect(jobs[1].description!.length).toBeGreaterThan(100)
  })

  test('Ashby: main and secondary places, remote flag, published date', () => {
    const [cloud] = parseAshbyJobs(ashby)
    expect(cloud).toMatchObject({ title: 'Security Engineer, Cloud', posted_at: '2026-04-07', remote: true })
    expect(cloud.locations).toEqual(expect.arrayContaining(['New York, NY (HQ)', 'Remote (US)', 'Miami, FL']))
  })

  test('changed or broken formats are no postings, never a crash', () => {
    for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
      for (const bad of [null, 'html error page', 42, {}, [], { jobs: 'x' }, [{ id: 1 }], { jobs: [{ id: 'x', title: 'T', absolute_url: 'javascript:1' }] }]) {
        expect(parseBoard(ats, bad)).toEqual([])
      }
    }
    // Unlisted: still open (so a lead for it isn't closed), never a new lead.
    const hidden = parseAshbyJobs({ jobs: [{ id: 'a', title: 'Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/x/a', isListed: false }] })
    expect(hidden).toMatchObject([{ id: 'a', listed: false }])
    expect(selectPostings(hidden, brief())).toEqual([])
  })
})

test('htmlToText', () => {
  expect(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;')).toBe('Hello & welcome\n• One')
  expect(htmlToText('<div>A&nbsp;B<br>C &#8212; D &#x2014; E</div><script>x()</script>')).toBe('A B\nC — D — E')
  expect(htmlToText('x'.repeat(MAX_DESCRIPTION + 10)).length).toBe(MAX_DESCRIPTION + 10) // capped by the parsers, not here
})

describe('selectPostings', () => {
  test('the search\'s roles and places; remote when it wants remote; newest first', () => {
    const jobs = [...parseGreenhouseJobs(greenhouse), ...parseLeverPostings(lever), ...parseAshbyJobs(ashby)]
    const picked = selectPostings(jobs, brief({ locations: ['New York'], remote: 'remote' }))
    // New York software engineering roles, newest first; the remote Greenhouse
    // posting isn't a software engineer, London and D.C. are elsewhere.
    expect(picked.map((p) => [p.title, p.posted_at])).toEqual([
      ['Backend Software Engineer - Application Development', '2024-03-11'],
      ['Software Engineer, Frontend', '2023-03-09'],
    ])
  })
})

describe('levelMatches', () => {
  const level = (seniority: string | null, title: string, roles = ['Software Engineer']) => levelMatches(brief({ seniority, roles }), title)
  test('a new-grad search skips senior, staff, lead and manager roles, and internships', () => {
    expect(level('new grad', 'Software Engineer')).toBe(true)
    expect(level('new grad', 'Software Engineer, Early Career')).toBe(true)
    for (const t of ['Senior Software Engineer, Backend', 'Staff Software Engineer', 'Sr. Software Engineer', 'Engineering Manager', 'Tech Lead, Payments', 'Software Engineer Intern']) {
      expect(level('new grad', t)).toBe(false)
    }
  })
  test('an internship search wants internships and co-ops', () => {
    expect(level('intern', 'Software Engineering Intern, iOS')).toBe(true)
    expect(level(null, 'Software Engineer Co-op', ['Software Engineer Intern'])).toBe(true)
    expect(level('intern', 'Software Engineer')).toBe(false)
  })
  test('both, or no level said', () => {
    expect(level('应届 / 实习', 'Software Engineer Intern')).toBe(true)
    expect(level('应届 / 实习', 'Senior Software Engineer')).toBe(false)
    expect(level(null, 'Staff Software Engineer')).toBe(true)
  })
})

test('a posting as a found job; stable ids; ids from ATS keys; slugs from names', () => {
  const [lv] = parseLeverPostings(lever)
  expect(postingToFoundJob(lv, 'Palantir')).toMatchObject({ company: 'Palantir', title: lv.title, job_url: lv.url, posted: lv.posted_at })
  const id = boardObservationId({ ats: 'lever', board: 'palantir' }, lv.id)
  expect(boardSourceOf(id)).toEqual({ ats: 'lever', board: 'palantir', id: lv.id })
  expect(boardSourceOf('simplify:new_grad:1')).toBeNull()
  expect(postingIdFromAtsKey('greenhouse:8172510', 'greenhouse')).toBe('8172510')
  expect(postingIdFromAtsKey('lever:abc', 'greenhouse')).toBeNull()
  expect(slugCandidates('Scale AI, Inc.')).toEqual(['scaleai', 'scale-ai', 'scale'])
  expect(slugCandidates('Stripe')).toEqual(['stripe'])
  expect(slugCandidates('字节跳动')).toEqual([])
})
