// The search brief and the jobs a search reports (packages/schema): both are
// untrusted input, bounded on the way in.
import { describe, expect, test } from 'vitest'
import { parseBrief, parseFoundJobs } from '@landed/schema/search-brief'

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
