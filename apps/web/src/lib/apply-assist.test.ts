// Which resume "Open & autofill" fills with.
import { describe, expect, test } from 'vitest'
import { askAgentToPick, pickCandidate, pickResumeFor, resumeChoiceFor, type AskAgent } from './apply-assist'
import type { DbResume } from './store/types'

const resume = (id: string, over: Partial<DbResume> = {}): DbResume => ({
  id, user_id: 'local', name: id, file_path: null, parsed_json: { name: 'Me' } as never, is_current: false,
  created_at: '2026-10-01T00:00:00Z', kind: 'source', master_json: null, target_json: null, directions: [], ...over,
})
const version = (id: string, target: Partial<NonNullable<DbResume['target_json']>>, created_at = '2026-10-10T00:00:00Z') =>
  resume(id, { kind: 'version', created_at, target_json: { role: 'x', company: null, job_url: null, jd_text: null, application_id: null, notes: { summary: '', picks: [] }, ...target } })

const app = { application_id: 'app-1', company: '字节跳动', role: '产品经理（抖音）', url: 'https://jobs.bytedance.com/experienced/position/123/detail' }

describe('pickResumeFor', () => {
  test('the version tailored for this application wins', () => {
    const picked = pickResumeFor(app, [resume('master', { kind: 'master' }), version('other', { role: 'PM', company: 'Acme' }), version('mine', { role: 'whatever', application_id: 'app-1' })])
    expect(picked).toMatchObject({ resume: { id: 'mine' }, why: 'tailored' })
  })

  test('then one for the same posting, then a close role at the same company (newest first)', () => {
    expect(pickResumeFor(app, [version('link', { role: 'PM', job_url: 'https://jobs.bytedance.com/experienced/position/123/detail?utm_source=x' })])?.why).toBe('tailored')
    const similar = pickResumeFor({ ...app, url: '' }, [
      version('old', { role: '产品经理', company: '字节跳动' }, '2026-10-01T00:00:00Z'),
      version('new', { role: '产品经理（抖音）', company: '字节跳动有限公司' }, '2026-10-12T00:00:00Z'),
      version('elsewhere', { role: '产品经理（抖音）', company: '腾讯' }, '2026-10-13T00:00:00Z'),
    ])
    expect(similar).toMatchObject({ resume: { id: 'new' }, why: 'similar' })
  })

  test('otherwise the master, then the current one; never one without parsed content', () => {
    expect(pickResumeFor(app, [resume('cur', { is_current: true }), resume('master', { kind: 'master' })])?.why).toBe('master')
    expect(pickResumeFor(app, [resume('a'), resume('cur', { is_current: true })])).toMatchObject({ resume: { id: 'cur' }, why: 'current' })
    expect(pickResumeFor(app, [resume('empty', { kind: 'master', parsed_json: null })])).toBeNull()
  })
})

describe('pickResumeFor: Landed picks the resume of the job\'s direction', () => {
  const pm = resume('pm', {
    name: 'Alex_Rivera_PM_resume', is_current: true,
    parsed_json: { basic: { name: 'Alex Rivera' }, skills: ['Figma', 'SQL', 'A/B testing'], experience: [{ title: 'Product Manager Intern', startDate: '2025-06' }] } as never,
  })
  const data = resume('data', {
    name: 'resume+(6)', created_at: '2026-10-12T00:00:00Z',
    parsed_json: { basic: { name: 'Alex Rivera' }, skills: ['SQL', 'Python', 'Tableau', 'pandas'], experience: [{ title: 'Data Analyst Intern', startDate: '2025-01' }] } as never,
  })
  const job = (role: string, description: string | null = null) => ({ application_id: null, company: 'Bluefin Analytics', role, url: '', description })
  const all = () => true

  test('a product job gets the PM resume, a data job the data one; only resumes with a file', () => {
    expect(pickResumeFor(job('Product Management, Intern'), [pm, data], all)).toMatchObject({ resume: { id: 'pm' }, why: 'direction' })
    expect(pickResumeFor(job('Data Analyst Intern', 'SQL, Python and Tableau daily'), [pm, data], all)?.resume.id).toBe('data')
    expect(pickResumeFor(job('Product Manager Intern'), [pm, data], (id) => id === 'data')).toMatchObject({ resume: { id: 'data' }, why: 'only' })
    expect(pickResumeFor(job('Product Manager Intern'), [pm, data, resume('master', { kind: 'master' })], () => false)).toMatchObject({ resume: { id: 'master' }, why: 'no_file', unsure: true })
  })

  test('the same pick as the extension (lib/resume-pick.js), case by case', async () => {
    const loaded = await import(/* @vite-ignore */ new URL('../../../extension/lib/resume-pick.js', import.meta.url).href)
    const ext = (loaded.default ?? loaded) as {
      pickResumeForPage: (page: { title: string; text?: string }, list: unknown[], opts?: { hasFile: (id: string) => boolean }) => { resume: { id: string }; why: string; unsure?: boolean; composite?: boolean } | null
    }
    const swe = version('swe', { role: 'Software Engineer, New Grad', company: 'Kestrel Pay' })
    const cases: [string, string | null, (id: string) => boolean][] = [
      ['Product Analyst', 'Own SQL dashboards in Tableau; Python a plus.', all],
      ['Product Analyst', 'Write roadmaps, prototype in Figma, run A/B testing.', all],
      ['Product Management, Intern', null, all],
      ['Data Analyst Intern', 'You will use SQL, Python and Tableau.', all],
      ['Software Engineer - Northwind Robotics', null, all],
      ['Registered Nurse, Night Shift', null, all],
      ['Product Manager Intern', null, (id) => id !== 'pm'],
    ]
    for (const [role, description, hasFile] of cases) {
      const web = pickResumeFor(job(role, description), [pm, data, swe], hasFile)
      const theirs = ext.pickResumeForPage({ title: role, text: description ?? '' }, [pm, data, swe].map((r) => ({ ...r, target: r.target_json })), { hasFile: (id) => id === 'swe' || hasFile(id) })
      expect([role, web?.resume.id, web?.why, !!web?.unsure, !!web?.composite]).toEqual([role, theirs?.resume.id, theirs?.why, !!theirs?.unsure, !!theirs?.composite])
    }
  })
})

describe('the reason an application records', () => {
  const pm = resume('pm', { name: 'PM resume', directions: ['Product Manager'], parsed_json: { skills: ['Figma', 'roadmaps'] } as never })
  const data = resume('data', { name: 'Data resume', directions: ['Data Analyst'], parsed_json: { skills: ['SQL', 'Tableau', 'Python'] } as never })
  const all = () => true
  const job = (role: string, description: string | null = null) => ({ application_id: 'a1', company: 'Bluefin Analytics', role, url: '', description })

  test('one direction, two directions, none', () => {
    expect(pickResumeFor(job('Data Analyst Intern'), [pm, data], all)?.reason).toBe('the resume for Data Analyst roles')
    expect(pickResumeFor(job('Product Analyst', 'SQL and Tableau every day'), [pm, data], all)?.reason)
      .toBe('a Product Analyst role fits “Data resume” and “PM resume”; the posting asks for SQL, Tableau')
    expect(pickResumeFor(job('Registered Nurse'), [pm, data], all)?.reason).toMatch(/^no resume is for Registered Nurse roles; the closest one/)
  })

  test('resumeChoiceFor keeps which and why', () => {
    const pick = pickResumeFor(job('Data Analyst Intern'), [pm, data], all)!
    expect(resumeChoiceFor(pick, new Date('2026-10-21T20:00:00.000Z'))).toEqual({ resume_id: 'data', name: 'Data resume', reason: 'the resume for Data Analyst roles', at: '2026-10-21T20:00:00.000Z' })
  })
})

describe('between close resumes, the user\'s agent reads the posting', () => {
  const pm = resume('pm', {
    name: 'Alex_Rivera_PM_resume', directions: ['Product Manager'],
    parsed_json: { basic: { name: 'Alex Rivera', email: 'alex.rivera@example.com', phone: '(206) 555-0142' }, skills: ['Figma', 'roadmaps'], experience: [{ title: 'Product Intern' }] } as never,
  })
  const data = resume('data', { name: 'Data resume', directions: ['Data Analyst'], parsed_json: { skills: ['SQL', 'Tableau'], internship: [{ title: 'Analytics Intern' }] } as never })
  const all = () => true
  const job = { application_id: 'a1', company: 'Bluefin Analytics', role: 'Product Data Analyst', url: '', description: 'Own product metrics in SQL.' }

  test('a role between two directions lists both as candidates; a clear one asks nobody', async () => {
    const between = pickResumeFor(job, [pm, data], all)!
    expect(between.composite).toBe(true)
    expect(between.candidates?.map((r) => r.id).sort()).toEqual(['data', 'pm'])
    const clear = pickResumeFor({ ...job, role: 'Data Analyst Intern' }, [pm, data], all)!
    expect(clear.candidates).toBeUndefined()
    let asked = 0
    expect(await askAgentToPick(clear, job, async () => { asked++; return null })).toBe(clear)
    expect(asked).toBe(0)
  })

  test('the agent sees what each resume is for, its titles and skills, never the person; its choice and why are recorded', async () => {
    const between = pickResumeFor(job, [pm, data], all)!
    let sent: Parameters<AskAgent>[0] | null = null
    const chosen = await askAgentToPick(between, job, async (request) => { sent = request; return { resume_id: 'data', reason: 'The posting is about SQL metrics.' } })
    expect(chosen).toMatchObject({ resume: { id: 'data' }, why: 'agent', reason: 'your agent read the posting: The posting is about SQL metrics.' })
    expect(resumeChoiceFor(chosen).reason).toBe('your agent read the posting: The posting is about SQL metrics.')
    expect(sent!.job).toEqual({ role: 'Product Data Analyst', company: 'Bluefin Analytics', description: 'Own product metrics in SQL.' })
    expect(JSON.stringify(sent)).not.toMatch(/Alex|Rivera|example\.com|555/)
    expect(pickCandidate(pm)).toEqual({ id: 'pm', directions: ['Product Manager'], titles: ['Product Intern'], skills: ['Figma', 'roadmaps'] })
  })

  test('no answer, a resume that isn\'t a candidate, or no agent: the rules\' pick stands', async () => {
    const between = pickResumeFor(job, [pm, data], all)!
    expect(await askAgentToPick(between, job, async () => null)).toBe(between)
    expect(await askAgentToPick(between, job, async () => ({ resume_id: 'elsewhere', reason: 'x' }))).toBe(between)
    expect(await askAgentToPick(between, job, async () => { throw new Error('Landed for Mac is not installed') })).toBe(between)
  })
})
