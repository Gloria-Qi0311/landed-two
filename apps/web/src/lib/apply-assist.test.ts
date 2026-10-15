// Which resume "Open & autofill" fills with.
import { describe, expect, test } from 'vitest'
import { pickResumeFor } from './apply-assist'
import type { DbResume } from './store/types'

const resume = (id: string, over: Partial<DbResume> = {}): DbResume => ({
  id, user_id: 'local', name: id, file_path: null, parsed_json: { name: 'Me' } as never, is_current: false,
  created_at: '2026-10-01T00:00:00Z', kind: 'source', master_json: null, target_json: null, ...over,
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
