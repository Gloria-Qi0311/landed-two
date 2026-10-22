// lib/resume-pick.js: the resume a page is filled with when the user
// doesn't pick one.
const { pickResumeForPage } = require('../lib/resume-pick.js')

const resume = (id, extra = {}) => ({ id, name: id, parsed_json: {}, is_current: false, created_at: '2026-10-10T00:00:00Z', kind: 'source', ...extra })
const version = (id, target, extra = {}) => resume(id, { kind: 'version', target, ...extra })
const page = { url: 'https://job-boards.greenhouse.io/instawork/jobs/7345/apply', title: 'Job Application for Product Operations Analyst at Instawork' }

test('the version tailored for this job, by its link, company + role, or the application it was opened for', () => {
  const list = [
    resume('current', { is_current: true }),
    version('ops', { role: 'Product Operations Analyst', company: 'Instawork', job_url: null, application_id: null }),
    version('other-role', { role: 'Software Engineer', company: 'Instawork', job_url: null, application_id: null }),
  ]
  expect(pickResumeForPage(page, list)).toMatchObject({ resume: { id: 'ops' }, why: 'tailored' })
  const byLink = [resume('current', { is_current: true }), version('link', { role: 'PM', company: 'X', job_url: 'https://job-boards.greenhouse.io/instawork/jobs/7345', application_id: null })]
  expect(pickResumeForPage(page, byLink).resume.id).toBe('link')
  const byApp = [resume('current', { is_current: true }), version('app', { role: 'PM', company: 'X', job_url: null, application_id: 'a1' })]
  expect(pickResumeForPage({ ...page, applicationId: 'a1' }, byApp).resume.id).toBe('app')
  // Cloud resumes carry target_json instead of target.
  const cloud = [resume('current', { is_current: true }), resume('ops', { kind: 'version', target_json: { role: 'Product Operations Analyst', company: 'Instawork' } })]
  expect(pickResumeForPage(page, cloud).resume.id).toBe('ops')
})

test('Chinese titles, and otherwise the current resume, then the master, then the newest', () => {
  const cn = { url: 'https://jobs.bytedance.com/x', title: '字节跳动招聘 - AI 产品经理（抖音）' }
  expect(pickResumeForPage(cn, [resume('current', { is_current: true }), version('bd', { role: 'AI 产品经理', company: '字节跳动' })]).resume.id).toBe('bd')
  expect(pickResumeForPage(page, [resume('current', { is_current: true }), version('other-role', { role: 'Software Engineer', company: 'Instawork' })]))
    .toMatchObject({ resume: { id: 'current' }, why: 'current' })
  expect(pickResumeForPage(page, [resume('old'), resume('master', { kind: 'master' })]).why).toBe('master')
  expect(pickResumeForPage(page, [resume('old'), resume('new', { created_at: '2026-10-14T00:00:00Z' })]).resume.id).toBe('new')
  expect(pickResumeForPage(page, [])).toBeNull()
})

describe('Landed picks the resume per job (several directions, one resume each)', () => {
  const pm = resume('pm', {
    name: 'Alex_Rivera_PM_resume', is_current: true,
    parsed_json: { basic: { name: 'Alex Rivera' }, skills: ['Figma', 'SQL', 'A/B testing'], experience: [{ title: 'Product Manager Intern', startDate: '2025-06' }] },
  })
  const data = resume('data', {
    name: 'resume+(6)', created_at: '2026-10-12T00:00:00Z',
    parsed_json: { basic: { name: 'Alex Rivera' }, skills: ['SQL', 'Python', 'Tableau', 'pandas'], experience: [{ title: 'Data Analyst Intern', startDate: '2025-01' }] },
  })
  const swe = version('swe', { role: 'Software Engineer, New Grad', company: 'Kestrel Pay', job_url: null, application_id: null })
  const all = () => true

  test('each job gets the resume of its direction, whatever the company', () => {
    expect(pickResumeForPage({ title: 'Machina Labs - Product Management, Intern' }, [pm, data, swe], { hasFile: all })).toMatchObject({ resume: { id: 'pm' }, why: 'direction' })
    expect(pickResumeForPage({ title: 'Data Analyst Intern at Bluefin Analytics', text: 'You will use SQL, Python and Tableau.' }, [pm, data, swe], { hasFile: all }).resume.id).toBe('data')
    // A version made for one company's SWE role fits another company's SWE role too.
    expect(pickResumeForPage({ title: 'Software Engineer - Northwind Robotics' }, [pm, data, swe], { hasFile: all }).resume.id).toBe('swe')
    expect(pickResumeForPage({ title: '数据分析实习生 | 蓝鲸科技' }, [pm, resume('cn', { parsed_json: { intent: { apply_position: '数据分析' } } })], { hasFile: all }).resume.id).toBe('cn')
  })

  test('only resumes with a file to upload; the one with a file wins over a better fit without', () => {
    expect(pickResumeForPage({ title: 'Product Manager Intern' }, [pm, data], { hasFile: (id) => id === 'data' })).toMatchObject({ resume: { id: 'data' }, why: 'only' })
    // A tailored version without its PDF (too long for one page) isn't used either.
    const tailored = version('tailored', { role: 'Product Manager Intern', company: 'Machina Labs', job_url: null, application_id: null })
    expect(pickResumeForPage({ title: 'Product Manager Intern - Machina Labs' }, [tailored, pm, data], { hasFile: (id) => id !== 'tailored' }).resume.id).toBe('pm')
    expect(pickResumeForPage({ title: 'Product Manager Intern - Machina Labs' }, [tailored, pm, data], { hasFile: all })).toMatchObject({ resume: { id: 'tailored' }, why: 'tailored' })
    // None has a file: the current one, and it's said.
    expect(pickResumeForPage({ title: 'Product Manager Intern' }, [pm, data], { hasFile: () => false })).toMatchObject({ resume: { id: 'pm' }, why: 'no_file', unsure: true })
  })

  test('a job neither fits well, or both fit alike: still the best, marked unsure', () => {
    expect(pickResumeForPage({ title: 'Registered Nurse, Night Shift' }, [pm, data], { hasFile: all })).toMatchObject({ why: 'fits', unsure: true })
    const pm2 = resume('pm2', { name: 'PM resume (old)', parsed_json: { experience: [{ title: 'Product Manager Intern' }] } })
    expect(pickResumeForPage({ title: 'Product Manager Intern' }, [pm, pm2], { hasFile: all })).toMatchObject({ resume: { id: 'pm' }, unsure: true })
  })
})

describe('directions the user (or Landed, at upload) gave each resume', () => {
  const pm = resume('pm', { directions: ['Product Manager'], parsed_json: { skills: ['Figma', 'roadmaps', 'A/B testing'], experience: [{ title: 'Software Engineer Intern', start_date: '2024-06' }] } })
  const data = resume('data', { directions: ['Data Analyst', 'Business Analyst'], parsed_json: { skills: ['SQL', 'Python', 'Tableau', 'A/B testing'] } })
  const all = () => true

  test('they win over what the latest titles say', () => {
    // Its latest job was engineering, but the user says it's the PM resume.
    expect(pickResumeForPage({ title: 'Product Manager, Payments' }, [pm, data], { hasFile: all })).toMatchObject({ resume: { id: 'pm' }, why: 'direction' })
    expect(pickResumeForPage({ title: 'Business Analyst, Operations' }, [pm, data], { hasFile: all })).toMatchObject({ resume: { id: 'data' }, why: 'direction' })
  })

  test('a role between two directions: what the posting asks for decides', () => {
    const job = { title: 'Product Analyst' }
    const sqlHeavy = pickResumeForPage({ ...job, text: 'Own SQL dashboards in Tableau; Python a plus.' }, [pm, data], { hasFile: all })
    expect(sqlHeavy).toMatchObject({ resume: { id: 'data' }, why: 'fits', composite: true })
    const productHeavy = pickResumeForPage({ ...job, text: 'Write roadmaps, prototype in Figma, run A/B testing.' }, [pm, data], { hasFile: all })
    expect(productHeavy).toMatchObject({ resume: { id: 'pm' }, composite: true })
  })

  test('no direction matches: the best score, unsure', () => {
    expect(pickResumeForPage({ title: 'Registered Nurse' }, [pm, data], { hasFile: all })).toMatchObject({ why: 'fits', unsure: true, composite: false })
  })
})
