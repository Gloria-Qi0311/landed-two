import { describe, expect, test } from 'vitest'
import type { DbJobLead, DbResume, DbSuggestion } from './store/types'
import { APPLY_BLOCKED, APPLY_FILLING, APPLY_REVIEW, APPLY_SUBMITTED, nextStepForAssistResult, parseApplyAssistResults, planApplyBatch } from './apply-batch'

const app = (id: string, companyId: string, over: Record<string, unknown> = {}) => ({
  id, companyId, role: `Role ${id}`, stage: 'saved', portal_application_url: `https://jobs.example.com/${id}`,
  deadline: null, nextStep: 'Tailor resume', ...over,
})
const resume = (): DbResume => ({
  id: '11111111-2222-4333-8444-555555555555', user_id: 'local', name: 'Master', file_path: null,
  parsed_json: { name: 'Alex' } as never, is_current: true, created_at: '2026-10-01T00:00:00Z',
  kind: 'master', master_json: null, target_json: null, directions: [],
})
const lead = (application_id: string, score: number): DbJobLead => ({
  id: crypto.randomUUID(), user_id: 'local', fingerprint: crypto.randomUUID(), ats_key: null, canonical_url: null,
  company_key: application_id, title_key: application_id, company_name: application_id, title: application_id,
  job_url: null, location: null, description: null, deadline: null, sources: [], status: 'saved', application_id,
  first_seen_at: '2026-10-01T00:00:00Z', last_seen_at: '2026-10-01T00:00:00Z', posted_at: null,
  closed_at: null, screen: null, fit: { score, reasons: [] },
})
const suggestion = (application_id: string): DbSuggestion => ({
  id: crypto.randomUUID(), user_id: 'local', dedupe_key: crypto.randomUUID(), kind: 'note', state: 'auto_applied',
  application_id, candidate_ids: [], company_name: 'Acme', role: null, status: 'recruiter_response', proposed_stage: null,
  previous_stage: null, confidence: 1, evidence: {}, observation_ids: [], provider: 'mail',
  created_at: '2026-10-10T00:00:00Z', resolved_at: '2026-10-10T00:00:00Z',
})
const names = (id: string) => ({ a: 'Acme', b: 'Beta', c: 'Cedar', d: 'Delta', e: 'Echo', f: 'Foxtrot', g: 'Gamma' } as Record<string, string>)[id]

describe('planApplyBatch', () => {
  test('takes at most five saved applications in fit × urgency order', () => {
    const apps = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => app(id, id))
    const leads = apps.map((a, i) => lead(a.id, (i + 1) / 10))
    const plan = planApplyBatch({ apps, companyName: names, leads, suggestions: [], resumes: [resume()], now: new Date('2026-10-19T12:00:00Z') })
    expect(plan.items.map((x) => x.app.id)).toEqual(['f', 'e', 'd', 'c', 'b'])
  })

  test('a jobright.ai listing is not the application: skipped, saying so', () => {
    const apps = [app('a', 'a', { portal_application_url: 'https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaa1' }), app('b', 'b')]
    const plan = planApplyBatch({ apps, companyName: names, leads: apps.map((x) => lead(x.id, 0.5)), suggestions: [], resumes: [resume()] })
    expect(plan.items.map((x) => x.app.id)).toEqual(['b'])
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'missing-link', message: "Acme · Role a has only a jobright.ai listing, not the company's application page" })])
  })

  test('skips a company already at OA/interview/offer and keeps filling the batch', () => {
    const apps = [app('a1', 'a'), app('a2', 'a', { stage: 'interview' }), app('b1', 'b'), app('c1', 'c')]
    const leads = ['a1', 'b1', 'c1'].map((id) => lead(id, 0.5))
    const plan = planApplyBatch({ apps, companyName: names, leads, suggestions: [], resumes: [resume()], limit: 2 })
    expect(plan.items.map((x) => x.app.id)).toEqual(['b1', 'c1'])
    expect(plan.skipped).toEqual([expect.objectContaining({ app: expect.objectContaining({ id: 'a1' }), reason: 'company-progress' })])
  })

  test('a recruiter reply on an active application blocks another role at that company', () => {
    const apps = [app('new', 'a'), app('old', 'a', { stage: 'applied' }), app('other', 'b')]
    const leads = ['new', 'other'].map((id) => lead(id, 0.5))
    const plan = planApplyBatch({ apps, companyName: names, leads, suggestions: [suggestion('old')], resumes: [resume()] })
    expect(plan.items.map((x) => x.app.id)).toEqual(['other'])
    expect(plan.skipped[0]).toMatchObject({ reason: 'recruiter', company: 'Acme' })
  })

  test('does not reopen pages waiting for the user; missing links or resumes are explained', () => {
    const apps = [
      app('open', 'a', { nextStep: APPLY_FILLING }),
      app('blocked', 'b', { nextStep: `${APPLY_BLOCKED}Sign in required` }),
      app('link', 'c', { portal_application_url: null }),
    ]
    const all = [...apps, app('resume', 'd')]
    const noResume = planApplyBatch({ apps: all, companyName: names, leads: all.map((x) => lead(x.id, 0.5)), suggestions: [], resumes: [] })
    expect(noResume.items).toHaveLength(0)
    expect(noResume.skipped.map((x) => x.reason)).toEqual(['already-open', 'already-open', 'missing-link', 'missing-resume'])
  })

  test('only a saved lead linked to the application carries submit authorization', () => {
    const approved = lead('approved', 0.8)
    const apps = [app('manual', 'a'), app('approved', 'b')]
    const plan = planApplyBatch({ apps, companyName: names, leads: [approved], suggestions: [], resumes: [resume()] })
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].target).toMatchObject({ application_id: 'approved', lead_id: approved.id })
    expect(plan.skipped).toEqual([expect.objectContaining({ app: expect.objectContaining({ id: 'manual' }), reason: 'not-approved' })])
  })
})

describe('apply-assist results', () => {
  test('records review and the three human-only blockers in next_step', () => {
    expect(nextStepForAssistResult({ status: 'ready', blocker: null, message: null })).toBe(APPLY_REVIEW)
    expect(nextStepForAssistResult({ status: 'submitted', blocker: null, message: null })).toBe(APPLY_SUBMITTED)
    expect(nextStepForAssistResult({ status: 'blocked', blocker: 'login', message: null })).toBe(`${APPLY_BLOCKED}Sign in required`)
    expect(nextStepForAssistResult({ status: 'blocked', blocker: 'account', message: null })).toBe(`${APPLY_BLOCKED}Account creation required`)
    expect(nextStepForAssistResult({ status: 'blocked', blocker: 'captcha', message: null })).toBe(`${APPLY_BLOCKED}CAPTCHA needs you`)
    expect(nextStepForAssistResult({ status: 'blocked', blocker: 'answers', message: null })).toBe(`${APPLY_BLOCKED}Answer required questions in Extension`)
  })

  test("names the fill's trace, so what it did can be looked up", () => {
    const step = nextStepForAssistResult({ status: 'blocked', blocker: 'login', message: null, trace_ref: 'K7Q2MX' })
    expect(step).toBe(`${APPLY_BLOCKED}Sign in required · fill K7Q2MX`)
    expect(step.startsWith(APPLY_BLOCKED)).toBe(true)
  })

  test('bounds and validates extension results', () => {
    const application_id = '11111111-2222-4333-8444-555555555555'
    expect(parseApplyAssistResults([{ application_id, tab_id: 7, status: 'blocked', blocker: 'captcha', message: 'Needs you', filled: 2, review: 1, at: '2026-10-19T12:00:00Z' }]))
      .toEqual([{ application_id, lead_id: null, tab_id: 7, status: 'blocked', blocker: 'captcha', message: 'Needs you', filled: 2, review: 1, at: '2026-10-19T12:00:00Z', trace_ref: null, open_answers: [] }])
    expect(parseApplyAssistResults([{ tab_id: 7, status: 'ready', trace_ref: 'K7Q2MX' }])[0].trace_ref).toBe('K7Q2MX')
    expect(parseApplyAssistResults([{ tab_id: 7, status: 'ready', trace_ref: '<script>' }])[0].trace_ref).toBeNull()
    expect(parseApplyAssistResults([{ tab_id: 'x', status: 'ready' }, null])).toEqual([])
  })
})
