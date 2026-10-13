// The brief the agent writes into its chat reply (packages/schema), as the
// Agent page reads it.
import { describe, expect, test } from 'vitest'
import { extractBrief, parseBrief, parseFoundJobs } from '@landed/schema/search-brief'
import { parsePortalCheckInput, parsePortalResults } from '@landed/schema/portal-check'

const block = (json: string) => '好的，我整理一下：\n\n```landed-brief\n' + json + '\n```\n\n确认的话点下面的按钮。'

describe('extractBrief', () => {
  test('splits the reply text from the brief card', () => {
    const r = extractBrief(block('{"summary":"美国 AI PM NG","roles":["AI Product Manager"],"locations":["United States"],"needs_sponsorship":true}'))
    expect(r.text).toBe('好的，我整理一下：\n\n确认的话点下面的按钮。')
    expect(r.brief).toMatchObject({ roles: ['AI Product Manager'], needs_sponsorship: true, remote: 'any', industries: [] })
    expect(r.drafting).toBe(false)
  })

  test('while the block is still streaming: hidden, marked as drafting', () => {
    const r = extractBrief('好的：\n\n```landed-brief\n{"summary":"美国 AI')
    expect(r).toEqual({ text: '好的：', brief: null, drafting: true })
  })

  test('no block, broken JSON or no roles → no card', () => {
    expect(extractBrief('just chatting').brief).toBeNull()
    expect(extractBrief(block('{not json')).brief).toBeNull()
    expect(extractBrief(block('{"summary":"x","roles":[]}')).brief).toBeNull()
    expect(extractBrief('```json\n{"roles":["PM"]}\n```').brief).toBeNull()
  })
})

describe('parseBrief / parseFoundJobs bound untrusted input', () => {
  test('brief: trims, dedupes, caps lists, rejects unknown enums', () => {
    const b = parseBrief({ roles: [' PM ', 'pm', 42, 'APM'], remote: 'moon', needs_sponsorship: 'yes', locations: Array(30).fill('x').map((x, i) => x + i) })!
    expect(b.roles).toEqual(['PM', 'APM'])
    expect(b.remote).toBe('any')
    expect(b.needs_sponsorship).toBeNull()
    expect(b.locations).toHaveLength(15)
    expect(b.summary).toContain('PM, APM')
  })

  test('jobs: needs company + title; http(s) links only; duplicates dropped', () => {
    const jobs = parseFoundJobs([
      { company: 'Acme', title: 'APM', job_url: 'https://jobs.lever.co/acme/1' },
      { company: 'Acme', title: 'APM', job_url: 'https://jobs.lever.co/acme/1' },
      { company: 'Evil', title: 'PM', job_url: 'javascript:alert(1)' },
      { company: 'No title' },
      'junk',
    ])
    expect(jobs.map((j) => [j.company, j.job_url])).toEqual([['Acme', 'https://jobs.lever.co/acme/1'], ['Evil', null]])
  })
})

describe('portal check input/results', () => {
  test('input: 1–5 items with an http(s) url; refs unique', () => {
    const item = (ref: string, url = 'https://acme.wd1.myworkdayjobs.com/x') => ({ ref, company: 'Acme', role: 'PM', stage: 'applied', url })
    expect(parsePortalCheckInput({ items: [] })).toBeNull()
    expect(parsePortalCheckInput({ items: [item('1', 'file:///etc/passwd')] })).toBeNull()
    expect(parsePortalCheckInput({ items: [item('1'), item('1'), item('2'), item('3'), item('4'), item('5'), item('6')] })!.items.map((i) => i.ref)).toEqual(['1', '2', '3', '4', '5'])
  })

  test('results: unknown outcomes dropped; a found status Landed doesn\'t know becomes not_found', () => {
    expect(parsePortalResults([
      { ref: '1', outcome: 'status_found', status: 'rejected', status_text: 'Not selected', confidence: 2 },
      { ref: '2', outcome: 'status_found', status: 'promoted' },
      { ref: '3', outcome: 'pwned' },
      { ref: '1', outcome: 'error' },
    ]).map((r) => [r.ref, r.outcome, r.status, r.confidence])).toEqual([['1', 'status_found', 'rejected', 1], ['2', 'not_found', null, null]])
  })
})
