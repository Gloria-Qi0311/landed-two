import { describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  listsForBrief, parseSimplifyListings, placeMatches, roleMatches, selectForBrief, simplifyObservationId, simplifySourceOf, toFoundJob,
} from '../src'
import raw from './fixtures/simplify-new-grad.json'

// Real rows from SimplifyJobs/New-Grad-Positions .github/scripts/listings.json
// (public postings, 2026-10-18), plus rows that don't read.
const listings = parseSimplifyListings(raw)
const now = new Date(2026, 9, 18, 12)

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Software Engineer'], seniority: 'new grad', locations: [], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

describe('parseSimplifyListings', () => {
  test('reads the real format; hidden rows and rows without an id, a company, a title or an http link are skipped', () => {
    expect(listings.map((l) => l.company)).toEqual([
      'Axon', 'Affirm', 'CVector', 'American Institutes for Research', 'JP Morgan Chase', 'People Culture Talent', 'Northrop Grumman',
    ])
    const axon = listings[0]
    expect(axon).toMatchObject({ title: 'Software Engineer 1', active: true, sponsorship: null, category: 'Software' })
    expect(axon.posted_at).toMatch(/^2026-10-1\d$/)
    expect(axon.url).toMatch(/^https:\/\//)
    expect(listings.find((l) => l.company === 'Northrop Grumman')!.active).toBe(false)
    expect(listings.find((l) => l.company === 'People Culture Talent')!.sponsorship).toBe('Does Not Offer Sponsorship')
  })

  test('anything but a list is no listings, never a crash', () => {
    for (const bad of [null, {}, 'listings', 42]) expect(parseSimplifyListings(bad)).toEqual([])
  })
})

describe('listsForBrief', () => {
  test.each([
    [{ seniority: 'new grad' }, ['new_grad']],
    [{ seniority: null, roles: ['Software Engineer Intern'] }, ['internships']],
    [{ seniority: '应届 / 实习' }, ['new_grad', 'internships']],
    [{ seniority: null }, ['new_grad', 'internships']],
    [{ seniority: 'senior' }, []],
  ] as const)('%o → %o', (over, lists) => expect(listsForBrief(brief(over as Partial<SearchBrief>))).toEqual(lists))
})

describe('roleMatches', () => {
  test('every meaningful word of a role, level words aside', () => {
    expect(roleMatches(['Software Engineer'], 'Software Engineer 1 - Fullstack - Search')).toBe(true)
    expect(roleMatches(['Software Engineer'], 'Full Stack Software Engineer 1 or 2')).toBe(true)
    expect(roleMatches(['New Grad Software Engineer'], 'Software Engineer 1')).toBe(true)
    expect(roleMatches(['Software Engineering Intern'], 'Software Engineer Intern')).toBe(true)
    expect(roleMatches(['SWE'], 'Software Engineer II')).toBe(true)
    expect(roleMatches(['Product Manager'], 'Martech Product Manager - Associate')).toBe(true)
    expect(roleMatches(['Software Engineer'], 'Full-Stack Engineer')).toBe(false)
    expect(roleMatches(['Data Scientist'], 'Software Engineer 1')).toBe(false)
  })
})

describe('placeMatches', () => {
  const places = (locations: string[], over: Partial<SearchBrief> = {}) => placeMatches(brief(over), locations)
  test('anywhere when the search names no place', () => expect(places(['London, UK'])).toBe(true))
  test('a city the search names, short forms included', () => {
    expect(places(['Boston, MA', 'Seattle, WA'], { locations: ['Seattle'] })).toBe(true)
    expect(places(['NYC'], { locations: ['New York, NY'] })).toBe(true)
    expect(places(['Mountain View, CA'], { locations: ['Bay Area'] })).toBe(true)
    expect(places(['Austin, TX'], { locations: ['Seattle'] })).toBe(false)
  })
  test('remote postings when the search wants remote', () => {
    expect(places(['Remote in USA'], { locations: ['Seattle'], remote: 'remote' })).toBe(true)
    expect(places(['Remote in USA'], { locations: ['Seattle'], remote: 'onsite' })).toBe(false)
  })
})

describe('selectForBrief', () => {
  test('open, recent, the right role and place, newest first', () => {
    const picked = selectForBrief(listings, brief({ locations: ['Seattle', 'New York'], remote: 'remote' }), now)
    expect(picked.map((l) => l.company)).toEqual(['Axon', 'Affirm'])
  })
  test('closed postings never become leads; old ones neither', () => {
    const all = selectForBrief(listings, brief({ roles: ['Software Engineer', 'Full Stack Engineer', 'Product Manager'] }), now)
    expect(all.map((l) => l.company)).not.toContain('Northrop Grumman')
    expect(all.map((l) => l.company)).not.toContain('CVector') // posted in June
  })
  test('the odd senior role in a new-grad list stays out; an internship needn\'t say "intern"', () => {
    const extra = parseSimplifyListings([
      { ...(raw[0] as Record<string, unknown>), id: 'principal', title: 'Principal Software Engineer - Clinical Analytics', locations: ['Seattle, WA'] },
      { ...(raw[0] as Record<string, unknown>), id: 'summer', title: 'Summer 2027 Software Engineer', locations: ['Seattle, WA'] },
    ])
    expect(selectForBrief(extra, brief({ locations: ['Seattle'] }), now).map((l) => l.id)).toEqual(['summer'])
    expect(selectForBrief(extra, brief({ seniority: 'intern', locations: ['Seattle'] }), now).map((l) => l.id)).toEqual(['summer'])
  })

  test('excluded companies stay out', () => {
    expect(selectForBrief(listings, brief({ exclude_companies: ['Axon, Inc.'] }), now).map((l) => l.company)).not.toContain('Axon')
  })
})

test('a listing as a found job, and a stable id per listing', () => {
  const job = toFoundJob(listings[0])
  expect(job).toMatchObject({ company: 'Axon', title: 'Software Engineer 1', deadline: null })
  expect(job.location).toMatch(/^Boston, MA; Seattle, WA/)
  expect(job.posted).toBe(listings[0].posted_at)
  const id = simplifyObservationId('new_grad', listings[0].id)
  expect(simplifySourceOf(id)).toEqual({ list: 'new_grad', id: listings[0].id })
  expect(simplifySourceOf('runtime-job-1:0')).toBeNull()
})
