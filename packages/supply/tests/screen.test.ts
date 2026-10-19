import { describe, expect, test } from 'vitest'
import { emptyResume, type Resume } from '@landed/schema'
import { EMPTY_ANSWERS, type ApplicationAnswers } from '@landed/schema/application-answers'
import { graduationOf, graduationWindow, isPutBack, PUT_BACK, screenPosting } from '../src'

const resume = (...ends: string[]): Resume => ({ ...emptyResume(), education: ends.map((end_date) => ({ ...emptyResume().education[0] ?? {}, school: 'State University', degree: 'BS', major: 'CS', gpa: '', start_date: '2022-09', end_date, location: '', description: '' })) })
const answers = (over: Partial<ApplicationAnswers> = {}): ApplicationAnswers => ({ ...EMPTY_ANSWERS, ...over })
const needs = answers({ needs_sponsorship: 'yes', work_authorized: 'yes' })
const noNeed = answers({ needs_sponsorship: 'no', work_authorized: 'yes' })
const screen = (text: string, a: ApplicationAnswers | null = needs, r: Resume | null = null) => screenPosting({ text, resume: r, answers: a })

describe('sponsorship: filtered only when the posting says it outright and the person needs it', () => {
  test.each([
    'We are unable to sponsor or take over sponsorship of an employment visa at this time.',
    'This role is not eligible for visa sponsorship.',
    'Applicants must be authorized to work in the U.S. without the need for current or future visa sponsorship.',
    'Candidates must be able to work in the US without sponsorship now or in the future.',
    'Company X will not sponsor applicants for work visas.',
    'We do not offer visa sponsorship for this position.',
    "We can't provide immigration sponsorship.",
    'Sponsorship is not available for this role.',
    'No visa sponsorship.',
    'Sponsorship: Does Not Offer Sponsorship', // the SimplifyJobs label, as the lead's description carries it
    'We are not able to provide H-1B sponsorship.',
    'We do not offer relocation or visa sponsorship.',
    'H-1B sponsorship is not available.',
    'This position does not provide sponsorship for employment visas.',
    'We will not sponsor H-1B visas for this role.',
    'Company X will not sponsor U.S. work visas.',
    '本岗位不提供工作签证担保。',
    '公司无法提供签证。',
  ])('%s', (text) => {
    expect(screen(text)).toEqual({ pass: false, reasons: ["Says it doesn't sponsor visas; you need sponsorship"] })
  })

  test.each([
    'We sponsor visas for exceptional candidates.',
    'Visa sponsorship is available for this role.',
    'We will provide visa sponsorship.',
    'Sponsorship: Offers Sponsorship',
    'Must be authorized to work in the United States.', // says nothing about sponsoring
    'Please indicate whether you will now or in the future require sponsorship.', // a question, not a policy
    'Our sponsors include NASA.',
    'Our company is not sponsoring the conference this year.',
    'We do not sponsor sports teams. Visa questions? Ask your recruiter.',
    'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)? Yes / No',
    'Applicants must be currently authorized to work in the US on a full-time basis.',
    'Benefits: no-cost health insurance, 401k',
  ])('not filtered: %s', (text) => {
    expect(screen(text)).toEqual({ pass: true, reasons: [] })
  })

  test('someone who doesn\'t need sponsorship is never filtered for it; unanswered skips the rule', () => {
    expect(screen('We will not sponsor visas.', noNeed)).toEqual({ pass: true, reasons: [] })
    expect(screen('We will not sponsor visas.', answers())).toBeNull()
    expect(screen('We will not sponsor visas.', null)).toBeNull()
  })
})

describe('citizenship and clearance', () => {
  test.each([
    'U.S. citizenship is required.',
    'Sponsorship: U.S. Citizenship is Required',
    'Must be a US citizen.',
    'US citizens only.',
    'Requires citizenship due to government contracts.',
    'Applicants must be a U.S. person as defined by ITAR.',
    'An active Secret clearance is required.',
    'Must hold a current TS/SCI clearance.',
    'Ability to obtain and maintain a security clearance.',
    'Must be able to obtain a US security clearance.',
    '• Active Full Scope Poly Level clearance', // real Palantir bullet
    '• Active US DoD Secret or higher Security Clearance',
    'Active TS/SCI clearance required.',
    // A negation elsewhere in the text doesn't undo a requirement in its own sentence.
    'No relocation support is needed. U.S. citizenship is required.',
    'Candidates who do not hold an active Secret clearance will not be considered.',
    // Real Palantir requirement bullets (public postings, 2026-10-18)
    '• Eligibility and willingness to obtain a US Security clearance',
    '• Active US Security clearance or eligibility and willingness to obtain a US Security clearance',
    '• Active Full Scope Poly level US security clearance',
    'An active security clearance at the Top Secret level, or willingness to obtain or upgrade to a Top Secret clearance.',
    'Security clearance required.',
    '候选人须为美国公民。',
  ])('%s', (text) => {
    expect(screen(text)).toEqual({ pass: false, reasons: ['Requires US citizenship or a security clearance; you need sponsorship'] })
  })

  test('not filtered without sure grounds', () => {
    // Can't tell whether someone who needs no sponsorship is a citizen.
    expect(screen('U.S. citizenship is required.', noNeed)).toEqual({ pass: true, reasons: [] })
    for (const text of [
      'We serve citizens across 40 states.', 'Experience with clearance pricing in retail.', 'Open to all work-authorized candidates.',
      // A plus, not a requirement (real Palantir bullet)
      '• Active US Security clearance, or eligibility and willingness to obtain a US Security clearance is beneficial',
      'US citizenship preferred.',
      'Nice to have: an active Secret clearance.',
      // Saying it is NOT required (review of #105)
      'No security clearance required.',
      'This position does not require a security clearance.',
      'A security clearance is not required for this role.',
      'Candidates do not need a US security clearance.',
      'We sponsor visas. Security clearance not needed.',
      'U.S. citizenship is not required; we welcome international applicants.',
      "This role doesn't require U.S. citizenship.",
      'Applicants without a security clearance are welcome; none is necessary.',
      '本岗位不需要安全许可。',
      // Another country's clearance (real Palantir bullets): US sponsorship says nothing about it
      '• Lithuanian Security Clearance or the ability to obtain one',
      '• Active or eligible for DV UK security clearance',
      '• Active clearance a plus, but not required',
    ]) {
      expect(screen(text)).toEqual({ pass: true, reasons: [] })
    }
  })

  test('a job plainly outside the US isn\'t judged by US sponsorship (real Palantir places)', () => {
    const text = 'Security clearance or the ability to obtain a clearance. We do not offer visa sponsorship.'
    const at = (location: string) => screenPosting({ text, location, resume: null, answers: needs })
    for (const abroad of ['London, United Kingdom', 'Oslo, Norway', 'Singapore, Singapore', 'Munich, Germany', 'Canberra, Australia', 'Tokyo, Japan']) {
      expect(at(abroad)).toBeNull() // the only rules that could run are skipped
    }
    for (const home of ['Washington, D.C.', 'New York, NY', 'Remote (US)', 'Denver, CO']) expect(at(home)!.pass).toBe(false)
    expect(at('')!.pass).toBe(false) // no place given: judged as before
  })

  test('both rules can fail at once', () => {
    expect(screen('Must be a US citizen. We do not sponsor visas.')!.reasons).toHaveLength(2)
  })
})

describe('graduationWindow', () => {
  const ym = (y: number, m: number) => y * 12 + m - 1
  test.each([
    ['Candidates graduating between December 2025 and June 2026.', { from: ym(2025, 12), to: ym(2026, 6) }],
    ['Must have an expected graduation date between 2026 and 2027.', { from: ym(2026, 1), to: ym(2027, 12) }],
    ['For students graduating in 2027.', { from: ym(2027, 1), to: ym(2027, 12) }],
    ['Expected graduation date of May 2026.', { from: ym(2026, 5), to: ym(2026, 5) }],
    ['You are graduating in December 2026 or June 2027.', { from: ym(2026, 12), to: ym(2027, 6) }],
    ['Open to students graduating in 2027 or later.', { from: ym(2027, 1), to: null }],
    ['You must graduate by June 2026.', { from: null, to: ym(2026, 6) }],
    ['Graduating in Fall 2026.', { from: ym(2026, 12), to: ym(2026, 12) }],
    ['Graduation date: December 2026', { from: ym(2026, 12), to: ym(2026, 12) }],
    ['Class of 2026 software engineers.', { from: ym(2025, 9), to: ym(2026, 12) }],
    ['We are hiring 2026 new grads!', { from: ym(2025, 9), to: ym(2026, 12) }],
    ['面向2026届毕业生。', { from: ym(2025, 9), to: ym(2026, 12) }],
    ['2025年10月至2026年9月毕业的应届生。', { from: ym(2025, 10), to: ym(2026, 9) }],
  ])('%s', (text, w) => expect(graduationWindow(text)).toEqual(w))

  test.each([
    'Founded in 2016, we serve 2000 customers.',
    "Bachelor's degree in Computer Science by your start date.",
    'Graduates of top universities are welcome.',
    '2+ years of experience since graduation.',
    'Our CEO graduated in 2019 from MIT.',
    'Recent graduates (within the last 12 months).',
    '',
  ])('none: %s', (text) => expect(graduationWindow(text)).toBeNull())
})

describe('graduation rule', () => {
  test('outside the posting\'s window: filtered, with both dates', () => {
    expect(screen('Graduating between December 2025 and June 2026.', null, resume('2025-05'))).toEqual({
      pass: false, reasons: ['Wants graduates Dec 2025 – Jun 2026; you graduate May 2025'],
    })
    expect(screen('Open to students graduating in 2027 or later.', null, resume('May 2026'))!.reasons[0]).toBe('Wants graduates Jan 2027 or later; you graduate May 2026')
  })

  test('inside, or not sure: not filtered', () => {
    expect(screen('Graduating between December 2025 and June 2026.', null, resume('2026-05'))!.pass).toBe(true)
    expect(screen('Class of 2026.', null, resume('2026'))!.pass).toBe(true) // a bare year overlaps
    expect(screen('Graduating in 2026.', null, resume('Present'))).toBeNull() // still studying, no date: rule skipped
    expect(screen('Graduating in 2026.', null, null)).toBeNull()
  })

  test('the latest degree counts', () => {
    expect(graduationOf(resume('2022-05', 'Expected May 2026'))).toEqual({ from: 2026 * 12 + 4, to: 2026 * 12 + 4 })
    expect(screen('Graduating in 2026.', null, resume('2022-05', '2026-05'))!.pass).toBe(true)
  })
})

test('a lead the user put back is recognised', () => {
  expect(isPutBack({ pass: true, reasons: [PUT_BACK] })).toBe(true)
  expect(isPutBack({ pass: true, reasons: [] })).toBe(false)
  expect(isPutBack(null)).toBe(false)
})
