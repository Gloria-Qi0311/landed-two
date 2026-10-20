// Application answers from the resume and the search: only what they say outright.
import { describe, expect, test } from 'vitest'
import { emptyResume, type Resume } from '@landed/schema'
import { EMPTY_ANSWERS } from '@landed/schema/application-answers'
import type { SearchBrief } from '@landed/schema/search-brief'
import { clearPrefilled, fullLink, graduation, placeParts, resumeName, stillPrefilled, suggestAnswers, withSuggestions } from './answer-suggestions'

const now = new Date('2026-10-19T12:00:00Z')

function resume(basic: Partial<Resume['basic']> = {}, education: Partial<Resume['education'][number]>[] = []): Resume {
  const r = emptyResume()
  return { ...r, basic: { ...r.basic, ...basic }, education: education.map((e) => ({ ...emptyResume().education[0], school: 'Example State University', ...e })) as Resume['education'] }
}

const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Software Engineer'], seniority: 'new grad', locations: [], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})

describe('placeParts', () => {
  test.each([
    ['Seattle, WA', { city: 'Seattle', state: 'Washington', country: 'United States' }],
    ['Seattle, WA 98105', { city: 'Seattle', state: 'Washington', country: 'United States' }],
    ['Austin, Texas, USA', { city: 'Austin', state: 'Texas', country: 'United States' }],
    ['Washington, DC', { city: 'Washington', state: 'District of Columbia', country: 'United States' }],
    ['Toronto, ON', { city: 'Toronto', state: 'Ontario', country: 'Canada' }],
    ['Shanghai, China', { city: 'Shanghai', state: null, country: 'China' }],
    ['Boston, USA', { city: 'Boston', state: null, country: 'United States' }],
  ])('%s', (text, want) => expect(placeParts(text)).toEqual(want))

  test.each(['Seattle', 'Remote', 'Remote, US', 'Washington, USA', '123 Main St, Springfield, Narnia, Earth', ''])(
    "%s says too little or isn't a place: nothing", (text) => expect(placeParts(text)).toBeNull())
})

describe('graduation', () => {
  test('the latest school end still ahead, as forms want it', () => {
    expect(graduation(resume({}, [{ end_date: '2022-06' }, { end_date: '2027-06' }]), now)).toBe('June 2027')
    expect(graduation(resume({}, [{ end_date: 'May 2027' }]), now)).toBe('May 2027')
    expect(graduation(resume({}, [{ end_date: '12/2026' }]), now)).toBe('December 2026')
    expect(graduation(resume({}, [{ end_date: '2027' }]), now)).toBe('2027')
  })
  test('already graduated, no date or "Present": nothing', () => {
    expect(graduation(resume({}, [{ end_date: '2024-05' }]), now)).toBeNull()
    expect(graduation(resume({}, [{ end_date: '' }]), now)).toBeNull()
    expect(graduation(resume({}, [{ end_date: 'Present' }]), now)).toBeNull()
  })
})

describe('fullLink', () => {
  test('links as forms want them', () => {
    expect(fullLink('linkedin.com/in/alex-rivera', 'linkedin')).toBe('https://www.linkedin.com/in/alex-rivera')
    expect(fullLink('in/alex-rivera', 'linkedin')).toBe('https://www.linkedin.com/in/alex-rivera')
    expect(fullLink('https://github.com/alexrivera/', 'github')).toBe('https://github.com/alexrivera')
    expect(fullLink('alexrivera.dev')).toBe('https://alexrivera.dev')
  })
  test("text that isn't a link, or the wrong site: nothing", () => {
    expect(fullLink('Alex Rivera', 'linkedin')).toBeNull()
    expect(fullLink('alex@example.com')).toBeNull()
    expect(fullLink('github.com/alexrivera', 'linkedin')).toBeNull()
    expect(fullLink('')).toBeNull()
  })
})

describe('suggestAnswers', () => {
  const r = resume({ name: 'Alex Rivera', linkedin: 'linkedin.com/in/alex-rivera', github: 'github.com/alexrivera', location: 'Seattle, WA' }, [{ end_date: '2027-06' }])

  test('the resume and the search answer the blank questions', () => {
    const s = suggestAnswers({ resume: r, brief: brief({ locations: ['Seattle', 'New York', 'Remote', 'Boston', 'Austin'], needs_sponsorship: true }), answers: EMPTY_ANSWERS }, now)
    expect(s).toEqual([
      { key: 'legal_first_name', value: 'Alex', from: 'resume' },
      { key: 'legal_last_name', value: 'Rivera', from: 'resume' },
      { key: 'linkedin', value: 'https://www.linkedin.com/in/alex-rivera', from: 'resume' },
      { key: 'github', value: 'https://github.com/alexrivera', from: 'resume' },
      { key: 'city', value: 'Seattle', from: 'resume' },
      { key: 'state', value: 'Washington', from: 'resume' },
      { key: 'country', value: 'United States', from: 'resume' },
      { key: 'earliest_start', value: 'June 2027', from: 'resume' },
      { key: 'preferred_locations', value: ['Seattle', 'New York', 'Boston'], from: 'search' },
      { key: 'needs_sponsorship', value: 'yes', from: 'search' },
    ])
  })

  test('never replaces an answer, and never mixes a half-typed address with the resume', () => {
    const answers = { ...EMPTY_ANSWERS, github: 'https://github.com/someone-else', state: 'Oregon', needs_sponsorship: 'no' as const }
    const keys = suggestAnswers({ resume: r, brief: brief({ needs_sponsorship: true }), answers }, now).map((s) => s.key)
    expect(keys).toEqual(['legal_first_name', 'legal_last_name', 'linkedin', 'earliest_start'])
  })

  test('never birth date, address lines, work authorization, EEO or consent', () => {
    const keys = suggestAnswers({ resume: r, brief: brief({ needs_sponsorship: false }), answers: EMPTY_ANSWERS }, now).map((s) => s.key)
    for (const k of ['date_of_birth', 'address_line1', 'work_authorized', 'adult', 'gender', 'race', 'agree_to_terms']) {
      expect(keys).not.toContain(k)
    }
  })

  test('a name is filled in only when it has a first and a last part', () => {
    const keys = (name: string) => suggestAnswers({ resume: resume({ name }), brief: null, answers: EMPTY_ANSWERS }, now).map((s) => s.key)
    expect(keys('Alex Rivera')).toEqual(['legal_first_name', 'legal_last_name'])
    expect(keys('李雷')).toEqual([])
    expect(keys('Alex')).toEqual([])
  })

  test('each question is filled in once: one the user cleared stays clear, and Undo clears only what is still as written', () => {
    const first = suggestAnswers({ resume: r, brief: brief({ needs_sponsorship: true }), answers: EMPTY_ANSWERS }, now)
    const filled = withSuggestions(EMPTY_ANSWERS, first)
    expect(filled.prefilled.city).toEqual({ value: 'Seattle', from: 'resume' })
    expect(filled.prefilled.needs_sponsorship).toEqual({ value: 'yes', from: 'search' })
    expect(stillPrefilled(filled)).toHaveLength(first.length)

    // The user clears the city and changes the first name: neither comes back, neither is marked.
    const edited = { ...filled, city: null, legal_first_name: 'Alejandro' }
    expect(suggestAnswers({ resume: r, brief: brief({ needs_sponsorship: true }), answers: edited }, now)).toEqual([])
    expect(stillPrefilled(edited).map(([k]) => k)).not.toEqual(expect.arrayContaining(['city', 'legal_first_name']))

    // Undo: what's still as written goes blank; the user's own first name stays.
    const undone = clearPrefilled(edited)
    expect(undone).toMatchObject({ legal_first_name: 'Alejandro', legal_last_name: null, linkedin: null, preferred_locations: [], needs_sponsorship: null })
    expect(suggestAnswers({ resume: r, brief: brief({ needs_sponsorship: true }), answers: undone }, now)).toEqual([])
  })

  test("a search that didn't say about sponsorship or places offers nothing for them; no resume, no search: nothing", () => {
    expect(suggestAnswers({ resume: null, brief: brief(), answers: EMPTY_ANSWERS }, now)).toEqual([])
    expect(suggestAnswers({ resume: null, brief: null, answers: EMPTY_ANSWERS }, now)).toEqual([])
  })

  test('answers saved before `prefilled` existed: filled in all the same', () => {
    const { prefilled: _, ...old } = { ...EMPTY_ANSWERS, linkedin: 'https://www.linkedin.com/in/someone' }
    const s = suggestAnswers({ resume: r, brief: null, answers: old as typeof EMPTY_ANSWERS }, now)
    expect(s.map((x) => x.key)).toEqual(['legal_first_name', 'legal_last_name', 'github', 'city', 'state', 'country', 'earliest_start'])
    const filled = withSuggestions(old as typeof EMPTY_ANSWERS, s)
    expect(filled.linkedin).toBe('https://www.linkedin.com/in/someone')
    expect(stillPrefilled(filled)).toHaveLength(s.length)
    expect(stillPrefilled(old as typeof EMPTY_ANSWERS)).toEqual([])
  })

  test('filling them in', () => {
    const s = suggestAnswers({ resume: r, brief: null, answers: EMPTY_ANSWERS }, now)
    expect(withSuggestions(EMPTY_ANSWERS, s)).toMatchObject({ city: 'Seattle', state: 'Washington', earliest_start: 'June 2027', legal_first_name: 'Alex', date_of_birth: null })
  })
})

test('resumeName', () => {
  expect(resumeName(resume({ name: 'Alex Rivera' }))).toEqual({ first: 'Alex', last: 'Rivera', full: 'Alex Rivera' })
  expect(resumeName(resume({ firstName: 'Alex', lastName: 'Rivera' }))).toEqual({ first: 'Alex', last: 'Rivera', full: 'Alex Rivera' })
  expect(resumeName(resume({ name: '李雷' }))).toEqual({ first: '李雷', last: '', full: '李雷' })
  expect(resumeName(resume())).toBeNull()
})
