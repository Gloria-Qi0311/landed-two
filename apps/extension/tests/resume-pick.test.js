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
