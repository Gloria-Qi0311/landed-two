// What the user's agent is told about the user: the resume's gist, the
// answers that shape a search, the current search; never contact details,
// address, date of birth or EEO answers.
import { describe, expect, test } from 'vitest'
import { EMPTY_ANSWERS } from '@landed/schema/application-answers'
import { normalizeResume } from '@landed/schema'
import { agentContext } from './agent-context'
import type { DbResume } from './store/types'

// A made-up person.
const resume = normalizeResume({
  basic: { name: 'Alex Chen', email: 'alex.chen@example.com', phone: '+1 206 555 0100', location: 'Seattle, WA', wechat: 'alexc' },
  summary: 'Product-minded analyst.',
  education: [{ school: 'University of Washington', degree: 'MS', major: 'Information Management', start_date: '2024-09', end_date: '2026-06' }],
  experience: [{ company: 'Northwind', title: 'Data Analyst', start_date: '2022-07', end_date: '2024-08', description: '• Built the pricing dashboard.\n• Cut report time in half.\n• Third bullet.' }],
  internship: [{ company: 'Globex', title: 'Product Intern', start_date: '2025-06', end_date: '2025-09', description: '' }],
  skills: ['SQL', 'Python', 'Figma'],
  languages: ['English', 'Mandarin'],
})
const row = (over: Partial<DbResume>): DbResume => ({
  id: crypto.randomUUID(), user_id: 'u', name: 'Upload', file_path: null, parsed_json: resume, is_current: false,
  created_at: '2026-10-01T00:00:00Z', kind: 'source', master_json: null, target_json: null, directions: [], ...over,
})

describe('agentContext', () => {
  test('the master resume, the search-shaping answers and the search', () => {
    const text = agentContext({
      resumes: [row({ name: 'Old upload' }), row({ kind: 'master', name: 'Master' })],
      answers: { ...EMPTY_ANSWERS, work_authorized: 'yes', needs_sponsorship: 'yes', preferred_locations: ['Seattle, WA', 'San Francisco, CA'], earliest_start: 'June 2026' },
      search: { summary: 'PM roles', roles: ['Product Manager'], seniority: 'new grad', locations: ['Seattle, WA'], remote: 'any', needs_sponsorship: true, salary_min: null, industries: [], include_companies: [], exclude_companies: [], notes: null },
    })!
    expect(text).toMatch(/^From their master resume:/)
    expect(text).toContain('- Education: MS, Information Management — University of Washington (2024-09 – 2026-06)')
    expect(text).toContain('- Job: Data Analyst at Northwind (2022-07 – 2024-08): Built the pricing dashboard.; Cut report time in half.')
    expect(text).not.toContain('Third bullet')
    expect(text).toContain('- Internship: Product Intern at Globex (2025-06 – 2025-09)')
    expect(text).toContain('- Skills: SQL, Python, Figma')
    expect(text).toContain('- needs visa sponsorship now or later: yes')
    expect(text).toContain('- preferred places: Seattle, WA; San Francisco, CA')
    expect(text).toContain('- Roles: Product Manager · level: new grad · places: Seattle, WA')
  })

  test('never contact details, address, date of birth or EEO answers', () => {
    const text = agentContext({
      resumes: [row({ kind: 'master' })],
      answers: { ...EMPTY_ANSWERS, date_of_birth: 'March 3', address_line1: '100 Main St', postal_code: '98105', gender: 'Male', race: 'Asian', veteran: 'no', legal_first_name: 'Alexander' },
      search: null,
    })!
    expect(text).not.toMatch(/alex\.chen@example\.com|555 0100|alexc|March 3|100 Main|98105|Male|Asian|veteran|Alexander/)
  })

  test('nothing known: no context', () => {
    expect(agentContext({ resumes: [], answers: null, search: null })).toBeNull()
  })
})
