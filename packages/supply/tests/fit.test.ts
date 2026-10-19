import { describe, expect, test } from 'vitest'
import { emptyResume, type Resume } from '@landed/schema'
import type { SearchBrief } from '@landed/schema/search-brief'
import { scoreFit, skillsMentioned, yearsAsked, yearsOnResume } from '../src'

const now = new Date(2026, 9, 18, 12)
const brief = (over: Partial<SearchBrief> = {}): SearchBrief => ({
  summary: 'x', roles: ['Software Engineer'], seniority: 'new grad', locations: ['Seattle', 'New York'], remote: 'any', needs_sponsorship: null,
  salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null, ...over,
})
const blank = emptyResume()
const resume = (over: Partial<Resume> = {}): Resume => ({ ...blank, skills: ['Python', 'TypeScript', 'React', 'SQL', 'AWS', 'Go'], ...over })
const job = (lines: string[]) => [...lines, 'We value curiosity and ownership. '.repeat(8)].join('\n')

describe('skillsMentioned', () => {
  test('whole words, as written on the resume; tricky short names', () => {
    const text = 'You will build services in Python and Go on AWS, with a React front end. Good communication; CI/CD with C#.'
    expect(skillsMentioned(['Python', 'Go', 'AWS', 'React', 'C', 'C#', 'SQL', 'Node.js'], text)).toEqual(['Python', 'Go', 'AWS', 'React', 'C#'])
  })
  test('"Go" is not found in "good", "Java" not in "JavaScript", "C" not in "CI"', () => {
    expect(skillsMentioned(['Go', 'Java', 'C'], 'Good JavaScript and CI skills')).toEqual([])
  })

  test('look-alikes from real postings (Stripe, Palantir, Ramp, 2026-10-18)', () => {
    const notSkills: [string, string][] = [
      ['Go', 'Build and refine the go-to-market playbook'],
      ['C', 'Maintain key relationships with C-level executives'],
      ['C', 'Kotlin, Swift, Objective-C'],
      ['Swift', 'Move money faster and cheaper vs. SWIFT and other fiat-only rails'],
      ['R', 'Partner with R&D on the roadmap'],
      ['C', "Stripe's Alliances and Channels (A&C) team"],
      ['Go', "You'll go deep on payments infrastructure"],
      ['Excel', 'You excel at building relationships'],
      ['Spark', 'Spark curiosity across teams'.toLowerCase()],
    ]
    for (const [skill, text] of notSkills) expect(skillsMentioned([skill], text)).toEqual([])
    // …and the real mentions still count.
    expect(skillsMentioned(['C++', 'Java', 'Kotlin'], 'Proficiency in C/C++ or Kotlin/Java')).toEqual(['C++', 'Java', 'Kotlin'])
    expect(skillsMentioned(['R', 'Python'], 'Fluency in a language such as Python or R')).toEqual(['R', 'Python'])
    expect(skillsMentioned(['Go', 'Swift'], 'experience writing Go, Swift or Objective-C')).toEqual(['Go', 'Swift'])
    expect(skillsMentioned(['C'], 'Proficiency in C/C++')).toEqual(['C'])
  })
})

describe('yearsAsked', () => {
  test.each([
    ['3+ years of experience building distributed systems', 3],
    ['At least 2 years of professional experience', 2],
    ['5-7 years of experience', 5],
    ["Minimum of 4 years' experience", 4],
    ['1+ year of relevant experience; 3 years of experience preferred', 1],
    ['3年以上相关工作经验', 3],
    // Real Stripe / Palantir / Ramp wording (public postings, 2026-10-18)
    ['8+ years of sales experience, preferably selling a technical product', 8],
    ['5–8 years of full sales cycle or account management experience', 5],
    ["Bachelor's degree in Computer Science, or a related field, plus four (4) years of experience in Software Engineering", 4],
    ['7 or more years of relevant experience in fraud strategy', 7],
    ['8 years+ Experience in partnerships, sales, or business development', 8],
    ['Extensive security experience (3+ years) in at least one major platform', 3],
  ])('%s → %s', (text, n) => expect(yearsAsked(text)).toBe(n))
  test.each([
    'Founded 10 years ago, we serve 2,000 customers.',
    'New grads welcome: no experience required.',
    'A 4-year degree in Computer Science.',
    'In 3 years we grew to 2,000 people. Experience matters here.', // a different sentence
  ])('none: %s', (text) => expect(yearsAsked(text)).toBeNull())
})

test('yearsOnResume: full-time work only, open-ended jobs run to now', () => {
  const r = resume({
    experience: [{ ...blank.experience[0], company: 'A', title: 'SWE', start_date: '2024-07', end_date: '', current: true, location: '', description: '' }] as never,
    internship: [{ company: 'B', title: 'Intern', start_date: '2023-06', end_date: '2023-09', current: false, location: '', description: '' }] as never,
  })
  expect(yearsOnResume(r, now)).toBe(2.3)
  expect(yearsOnResume(null, now)).toBe(0)
})

describe('scoreFit', () => {
  test('a matching role, place and skills scores high, with the telling reasons', () => {
    const fit = scoreFit({
      title: 'Software Engineer, Backend', location: 'Seattle, WA',
      description: job(['Build APIs in Python and Go on AWS.', 'You know SQL and TypeScript.']), brief: brief(), resume: resume(),
    }, now)!
    expect(fit.score).toBeGreaterThan(0.85)
    expect(fit.reasons).toHaveLength(3)
    // Every lead's title matches (that's how it got here): the skills say more, so they lead.
    expect(fit.reasons[0]).toBe('Mentions 5 of your skills: Python, TypeScript, SQL, AWS…')
    expect(fit.reasons).toContain('Title matches "Software Engineer"')
  })

  test('the first reason is the one that tells leads apart, not the title every lead matches', () => {
    const at = (description: string) => scoreFit({ title: 'Software Engineer', location: 'Seattle, WA', description, brief: brief(), resume: resume() }, now)!.reasons[0]
    expect(at(job(['Build services in Rust and Elixir.']))).toBe("Mentions none of your resume's skills")
    expect(at(job(['Python and SQL.', '5+ years of experience.']))).toBe('Asks for 5+ years; you have about 0')
    expect(scoreFit({ title: 'Senior Software Engineer', location: 'Seattle, WA', description: null, brief: brief(), resume: resume() }, now)!.reasons[0])
      .toBe('Looks senior for a new grad search')
  })

  test('the wrong place and a big experience ask pull it down, and say so', () => {
    const fit = scoreFit({
      title: 'Software Engineer', location: 'Austin, TX', description: job(['8+ years of experience with Python.']), brief: brief(), resume: resume(),
    }, now)!
    expect(fit.score).toBeLessThan(0.6)
    expect(fit.reasons).toEqual(expect.arrayContaining(['Not in the places you want', 'Asks for 8+ years; you have about 0']))
  })

  test('a different role scores low', () => {
    const fit = scoreFit({ title: 'Account Executive', location: 'Seattle, WA', description: null, brief: brief(), resume: resume() }, now)!
    expect(fit.score).toBeLessThan(0.3)
    expect(fit.reasons[0]).toBe("Title isn't one of the roles you're looking for")
  })

  test('parts without input are left out: no description, no resume', () => {
    const fit = scoreFit({ title: 'Software Engineer', location: 'Seattle, WA', description: null, brief: brief(), resume: null }, now)!
    expect(fit).toEqual({ score: 1, reasons: ['Title matches "Software Engineer"', 'In Seattle, WA', 'Level fits new grad'] })
  })

  test('closer titles score higher; a senior title in a new-grad search scores low and says why', () => {
    const at = (title: string) => scoreFit({ title, location: 'Seattle, WA', description: null, brief: brief(), resume: null }, now)!
    expect(at('Software Engineer').score).toBeGreaterThan(at('Software Engineer, Fraud & Identity').score)
    expect(at('Software Engineer 1 New Grad').score).toBe(1) // level words don't count against a title
    const principal = at('Principal Software Engineer - Clinical Analytics')
    expect(principal.score).toBeLessThan(0.8)
    expect(principal.reasons[0]).toBe('Looks senior for a new grad search')
  })

  test('the place that matched is the one named', () => {
    const fit = scoreFit({ title: 'Software Engineer', location: 'Boston, MA; Seattle, WA; Scottsdale, AZ', description: null, brief: brief(), resume: null }, now)!
    expect(fit.reasons).toContain('In Seattle, WA (+2)')
  })

  test('no search: nothing to score with', () => {
    expect(scoreFit({ title: 'Software Engineer', location: null, description: null, brief: null, resume: resume() }, now)).toBeNull()
  })

  test('same input, same score', () => {
    const input = { title: 'Software Engineer II', location: 'New York, NY', description: job(['React and TypeScript.']), brief: brief(), resume: resume() }
    expect(scoreFit(input, now)).toEqual(scoreFit(input, now))
  })
})
