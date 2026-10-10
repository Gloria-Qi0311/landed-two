import { describe, expect, test } from 'vitest'
import { atsJobKey, canonicalUrl, companyKey, locationsCompatible, titleKey, titleSimilarity } from '../src'

describe('companyKey', () => {
  test.each([
    ['The Acme Corp., Inc.', 'acme'],
    ['Stripe, Inc.', 'stripe'],
    ['Lumen & Co.', 'lumen and'],
    ['Meta Platforms, Inc.', 'meta'],
    ['Alphabet', 'google'],
    ['Société Générale', 'societe generale'],
    ['Co', 'co'],
  ])('%s → %s', (input, key) => expect(companyKey(input)).toBe(key))
})

describe('titles', () => {
  test('expands abbreviations, drops bracketed noise, keeps seniority', () => {
    expect(titleKey('Sr. SWE (Remote) [R-1234]')).toBe('senior software engineer')
    expect(titleKey('PM, AI Platform')).toBe('product manager ai platform')
    expect(titleKey('Senior PM')).not.toBe(titleKey('PM'))
  })
  test('similarity', () => {
    expect(titleSimilarity('Senior Product Manager', 'Sr PM')).toBe(1)
    expect(titleSimilarity('Frontend Engineer, Console', 'Frontend Engineer')).toBeCloseTo(2 / 3)
    expect(titleSimilarity('Designer', 'Data Scientist')).toBe(0)
    expect(titleSimilarity('', 'x')).toBe(0)
  })
})

describe('urls', () => {
  test('canonicalUrl strips tracking, fragment, www and trailing slash', () => {
    expect(canonicalUrl('http://www.Example.com/jobs/1/?utm_source=x&b=2&a=1#apply')).toBe('example.com/jobs/1?a=1&b=2')
    expect(canonicalUrl('javascript:alert(1)')).toBeNull()
    expect(canonicalUrl('not a url')).toBeNull()
  })
  test.each([
    ['https://boards.greenhouse.io/acme/jobs/4567890?gh_src=abc', 'greenhouse:4567890'],
    ['https://job-boards.greenhouse.io/acme/jobs/4567890', 'greenhouse:4567890'],
    ['https://www.acme.com/careers/open?gh_jid=4567890', 'greenhouse:4567890'],
    ['https://jobs.lever.co/Ramp/0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/apply', 'lever:0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'],
    ['https://jobs.ashbyhq.com/linear/7d9e2c1a-3b4c-4d5e-9f60-718293a4b5c6', 'ashby:7d9e2c1a-3b4c-4d5e-9f60-718293a4b5c6'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/San-Francisco-CA/Senior-PM_R-01234', 'workday:acme:r-01234'],
    ['https://example.com/jobs/1', null],
  ])('atsJobKey(%s) = %s', (url, key) => expect(atsJobKey(url)).toBe(key))
})

describe('locationsCompatible', () => {
  test.each([
    ['San Francisco, CA', 'San Francisco', true],
    ['San Francisco, CA', 'New York, NY', false],
    ['Remote (US)', 'New York, NY', true],
    [null, 'Seattle, WA', true],
  ])('%s vs %s → %s', (a, b, ok) => expect(locationsCompatible(a, b)).toBe(ok))
})
