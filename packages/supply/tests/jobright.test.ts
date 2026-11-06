import { describe, expect, test } from 'vitest'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  isListingPage, jobrightDate, jobrightListsForBrief, jobrightObservationId, jobrightSourceOf, jobrightToFoundJob, matchBoardPosting,
  parseJobrightReadme, selectJobright, touchesRole, type BoardPosting,
} from '../src'
import { README } from './fixtures/jobright-data-new-grad'

const now = new Date(Date.UTC(2026, 9, 22, 18))
const listings = parseJobrightReadme(README, now)

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Data Analyst'], seniority: 'new grad', locations: [], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

describe('jobright lists', () => {
  test('a search reads the lists of the directions its roles name, at its level', () => {
    expect(jobrightListsForBrief(brief()).map((l) => l.repo)).toEqual(['2026-Data-Analysis-New-Grad'])
    expect(jobrightListsForBrief(brief({ roles: ['Product Analyst'], seniority: 'internship' })).map((l) => l.repo))
      .toEqual(['2026-Product-Management-Internship', '2026-Data-Analysis-Internship'])
    expect(jobrightListsForBrief(brief({ roles: ['Business Analyst'], seniority: null })).map((l) => l.repo))
      .toEqual(['2026-Business-Analyst-New-Grad', '2026-Business-Analyst-Internship'])
    // Software is the SimplifyJobs lists' job; senior searches read none.
    expect(jobrightListsForBrief(brief({ roles: ['Software Engineer'] }))).toEqual([])
    expect(jobrightListsForBrief(brief({ seniority: 'senior' }))).toEqual([])
  })

  test('reads the README table: a ↳ row is the company above\'s; rows without a jobright id are skipped; links lose tracking', () => {
    expect(listings.map((l) => [l.company, l.title])).toEqual([
      ['Bluefin Analytics', 'Data Analyst I'],
      ['Bluefin Analytics', 'Business Intelligence Analyst'],
      ['Kestrel Pay', 'Senior Data Analyst, Payments'],
      ['Lumen Labs', 'Analytics Associate'],
      ['Cedar Health', 'Research Fellow'],
      ['Northwind Robotics', 'Operations Data Analyst'],
    ])
    expect(listings[0]).toEqual({
      id: '6ada72df950ef68d518577b1', company: 'Bluefin Analytics', title: 'Data Analyst I',
      url: 'https://jobright.ai/jobs/info/6ada72df950ef68d518577b1', location: 'Seattle, WA, United States', remote: false, posted_at: '2026-10-22',
    })
    expect(listings[1]).toMatchObject({ remote: true, posted_at: '2026-10-21' })
  })

  test('"Oct 22" has no year: the latest such day not after tomorrow', () => {
    expect(jobrightDate('Oct 22', now)).toBe('2026-10-22')
    expect(jobrightDate('Oct 23', now)).toBe('2026-10-23')
    expect(jobrightDate('Dec 30', now)).toBe('2025-12-30')
    expect(jobrightDate('Feb 30', now)).toBeNull()
    expect(jobrightDate('soon', now)).toBeNull()
    expect(listings.find((l) => l.company === 'Northwind Robotics')?.posted_at).toBe('2025-12-30')
  })

  test('keeps the last 30 days, not a senior title for a new-grad search, in the search\'s places; newest first', () => {
    const picked = selectJobright(listings, brief(), now)
    // Kestrel: senior. Lumen: Sep 1, too old. Cedar: no word of the role. Northwind: last December.
    expect(picked.map((l) => l.title)).toEqual(['Data Analyst I', 'Business Intelligence Analyst'])
    expect(selectJobright(listings, brief({ locations: ['Seattle, WA'] }), now).map((l) => l.title)).toEqual(['Data Analyst I'])
    expect(selectJobright(listings, brief({ locations: ['Austin, TX'], remote: 'remote' }), now).map((l) => l.title)).toEqual(['Business Intelligence Analyst'])
    expect(selectJobright(listings, brief({ exclude_companies: ['Bluefin Analytics'] }), now)).toEqual([])
  })

  test('a title needs one word of a role: the list is the direction, not every posting on it', () => {
    expect(touchesRole(['Data Analyst'], 'Clinical Data Coordinator')).toBe(true)
    expect(touchesRole(['Data Analyst'], 'Analyst II / Analyst I')).toBe(true)
    expect(touchesRole(['Data Analyst'], 'Research Fellow')).toBe(false)
    expect(touchesRole(['Product Manager'], 'AI Product Builder Intern')).toBe(true)
    expect(touchesRole(['Product Manager'], 'Summer 2027 Science & Innovation Intern')).toBe(false)
    expect(touchesRole(['Business Analyst'], 'Business Operations Associate')).toBe(true)
  })

  test('the company\'s own posting only when the title is the very same: a name-guessed board can be another company\'s', () => {
    const posting = (title: string, id: string, posted_at = '2026-10-21'): BoardPosting => ({
      id, company: null, title, url: `https://jobs.lever.co/bluefin/${id}`, locations: ['Seattle, WA'], remote: false,
      posted_at, deadline: null, description: 'Own product metrics in SQL.', listed: true,
    })
    const board = [posting('Data Analyst', 'a'), posting('Data Analyst I', 'b', '2026-10-19'), posting('Data Analyst I', 'c'), posting('Senior Data Analyst I', 'd')]
    expect(matchBoardPosting(listings[0], board)?.id).toBe('c')
    expect(matchBoardPosting(listings[1], board)).toBeNull()
    expect(jobrightToFoundJob(listings[0], board[2])).toMatchObject({ job_url: 'https://jobs.lever.co/bluefin/c', location: 'Seattle, WA', posted: '2026-10-21' })
    expect(jobrightToFoundJob(listings[1])).toMatchObject({ job_url: 'https://jobright.ai/jobs/info/6ada72df950ef68d518577b2', location: 'Remote in USA' })
  })

  test('one observation id per jobright job; a jobright page is a listing page, never the application', () => {
    expect(jobrightObservationId('6ada72df950ef68d518577b1')).toBe('jobright:6ada72df950ef68d518577b1')
    expect(jobrightSourceOf('jobright:6ada72df950ef68d518577b1')).toBe('6ada72df950ef68d518577b1')
    expect(jobrightSourceOf('simplify:new_grad:x')).toBeNull()
    expect(isListingPage('https://jobright.ai/jobs/info/6ada72df950ef68d518577b1')).toBe(true)
    expect(isListingPage('https://jobs.lever.co/bluefin/c')).toBe(false)
    expect(isListingPage(null)).toBe(false)
  })
})
