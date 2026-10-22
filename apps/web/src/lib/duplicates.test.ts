// Duplicate applications: finding them, and merging with the user's pick.
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { dismissDuplicates, duplicateGroups, mergeApplications, mergedPatch, pickPrimary } from './duplicates'
import { createLocalStore } from './store/local'

let n = 0
const fresh = () => createLocalStore(`landed-dups-${++n}`)
const app = (id: string, company_id: string, role: string, url: string | null = null) => ({ id, company_id, role, portal_application_url: url })

describe('finding them', () => {
  const companies = [{ id: 'ant', name: '蚂蚁集团' }, { id: 'ant2', name: '蚂蚁' }, { id: 'pdd', name: '拼多多' }, { id: 'tx', name: '腾讯' }, { id: 'acme', name: 'Acme' }]

  test('same employer (any spelling of it) + nearly the same title, brackets included', () => {
    const groups = duplicateGroups([
      app('a1', 'ant', 'AI产品工程师'), app('a2', 'ant2', 'AI产品工程师'), // 蚂蚁集团 = 蚂蚁
      app('p1', 'pdd', '产品管培生（上海）'), app('p2', 'pdd', '产品管培生（广东省）'), // two places, two applications
      app('t1', 'tx', 'AI产品经理'), // only one
      app('x1', 'acme', 'Product Manager', 'https://boards.greenhouse.io/acme/jobs/123'), app('x2', 'acme', 'PM, Growth', 'https://acme.com/careers?gh_jid=123'), // same posting
    ], companies)
    expect(groups.map((g) => g.sort())).toEqual([['a1', 'a2'], ['x1', 'x2']])
  })

  test('two different postings on job boards are two applications, however alike the titles', () => {
    const lever = (id: string) => `https://jobs.lever.co/acme/${id}`
    const l1 = app('l1', 'acme', 'Software Engineer, New Grad', lever('1b2c3d4e-0000-4000-8000-000000000001'))
    const l2 = app('l2', 'acme', 'Software Engineer, Platform (New Grad)', lever('1b2c3d4e-0000-4000-8000-000000000002'))
    const l3 = app('l3', 'acme', 'Software Engineer, New Grad', lever('1b2c3d4e-0000-4000-8000-000000000001')) // the first one again
    expect(duplicateGroups([l1, l2, l3], companies).map((g) => g.sort())).toEqual([['l1', 'l3']])
    // One from an email has no link: matched by its title, as before.
    expect(duplicateGroups([l1, app('e1', 'acme', 'Software Engineer, New Grad')], companies).map((g) => g.sort())).toEqual([['e1', 'l1']])
  })

  test('"they\'re different" is remembered for that group', () => {
    const apps = [app('a1', 'ant', 'AI产品工程师'), app('a2', 'ant', 'AI产品工程师')]
    expect(duplicateGroups(apps, companies, new Set(['dup:a1+a2']))).toEqual([])
  })
})

describe('merging', () => {
  test('keeps the furthest along by default and fills it in from the others', () => {
    const base = { company_id: 'c', team: null, salary: null, location: null, remote: null, next_step: null, source: null, job_id: null, portal_application_url: null, notes: null, referral: false, starred: false, interviews: [], deadline: null, resume_choice: null, user_id: 'local', created_at: '2026-10-01T00:00:00Z' }
    const email = { ...base, id: 'e', role: 'AI产品工程师', stage: 'oa', applied_at: '2026-10-13T12:00:00Z', last_activity_at: '2026-10-13T00:00:00Z', notes: 'OA link in email' }
    const shot = { ...base, id: 's', role: 'AI产品工程师（搜推方向）', stage: 'applied', applied_at: '2026-10-12T12:00:00Z', last_activity_at: '2026-10-14T00:00:00Z', location: '杭州', notes: '第一意向', referral: true }
    expect(pickPrimary([shot, email]).id).toBe('e')
    expect(mergedPatch(email, [shot])).toMatchObject({ location: '杭州', applied_at: '2026-10-12T12:00:00Z', notes: 'OA link in email\n\n第一意向', referral: true })
  })

  test('merge into the pick: leads and resolved updates move over, the others are deleted', async () => {
    const store = fresh()
    const keep = await store.addApplication({ name: '蚂蚁集团' }, { role: 'AI产品工程师', stage: 'oa', interviews: [{ round: 1, format: 'remote', interviewers: [], at: null, note: null }] })
    const dup = await store.addApplication({ name: '蚂蚁' }, { role: 'AI产品工程师', stage: 'applied', location: '杭州' })
    await store.saveJobLead({
      id: crypto.randomUUID(), fingerprint: 'job:x', ats_key: null, canonical_url: null, company_key: '蚂蚁', title_key: 'x', company_name: '蚂蚁', title: 'AI产品工程师',
      job_url: null, location: null, description: null, deadline: null, sources: [], status: 'saved', application_id: dup.id, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    } as never)
    const merged = await mergeApplications(store, keep.id, [dup.id])
    expect(merged).toMatchObject({ id: keep.id, stage: 'oa', location: '杭州' })
    expect(merged.interviews).toHaveLength(1)
    expect((await store.listApplications()).map((a) => a.id)).toEqual([keep.id])
    expect((await store.listJobLeads())[0].application_id).toBe(keep.id)
  })

  test('"they\'re different" stops the question', async () => {
    const store = fresh()
    const a = await store.addApplication({ name: 'Acme' }, { role: 'Product Manager' })
    const b = await store.addApplication({ name: 'Acme' }, { role: 'Product Manager' })
    const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
    expect(duplicateGroups(apps, companies)).toHaveLength(1)
    await dismissDuplicates(store, [a.id, b.id], 'Acme')
    const dismissed = new Set((await store.listSuggestions()).map((s) => s.dedupe_key))
    expect(duplicateGroups(apps, companies, dismissed)).toEqual([])
  })
})
