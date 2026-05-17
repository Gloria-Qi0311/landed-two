// Tests for the Ashby portal parser. Ashby is JSON-LD-heavy + cleaner
// DOM than Workday, so most extraction goes through structured data;
// DOM landmarks are the tail.
import { describe, test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  isAshbyUrl,
  parseSubmitConfirmation,
  parseAppliedBadge,
  parseAshbyPage,
} from '../../src/portal-parsers/ashby.js'

const dom = (html) => new JSDOM(html).window.document
const FIXED_NOW = new Date('2026-05-17T12:00:00.000Z')

describe('isAshbyUrl', () => {
  test.each([
    ['https://jobs.ashbyhq.com/acme', true],
    ['https://jobs.ashbyhq.com/acme/abc-uuid', true],
    ['https://careers.ashbyhq.com/acme/abc-uuid', true],
    ['https://acme.ashbyhq.com/jobs/abc', true],
  ])('matches %s', (url, expected) => {
    expect(isAshbyUrl(url)).toBe(expected)
  })

  test.each([
    ['https://boards.greenhouse.io/acme/jobs/12345', false],
    ['https://jobs.lever.co/acme/abc', false],
    ['https://acme.wd5.myworkdayjobs.com/x', false],
    ['https://careers.acme.com', false],
    // Anti-lookalike enforcement
    ['https://ashbyhq.com.evil.com/x', false],
    ['https://faked-ashbyhq.com/x', false],
    ['', false],
    [null, false],
  ])('rejects %s', (url, expected) => {
    expect(isAshbyUrl(url)).toBe(expected)
  })
})

describe('parseSubmitConfirmation', () => {
  test('detects via /confirmation URL + extracts from JSON-LD', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">{
            "@context":"https://schema.org","@type":"JobPosting",
            "title":"Senior ML Engineer",
            "hiringOrganization":{"@type":"Organization","name":"Acme AI"}
          }</script>
        </head>
        <body><main><h1>Thanks!</h1></main></body>
      </html>
    `
    const url = 'https://jobs.ashbyhq.com/acme/abc-uuid-12345/confirmation'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toEqual({
      kind: 'applied',
      company: 'Acme AI',
      role: 'Senior ML Engineer',
      applied_at: FIXED_NOW.toISOString(),
      app_url: url,
      detected_via: 'url',
    })
  })

  test('detects via banner text (English) using og:title "Role at Company"', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Staff Engineer at Acme Co"></head>
        <body>
          <main>
            <div data-testid="application-confirmation">
              <h2>Thank you for applying! We will be in touch.</h2>
            </div>
          </main>
        </body>
      </html>
    `
    const url = 'https://jobs.ashbyhq.com/acme/abc-uuid'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      kind: 'applied',
      company: 'Acme Co',
      role: 'Staff Engineer',
      detected_via: 'banner',
    })
  })

  test('detects via dash-separated og:title with multi-segment role (greedy)', () => {
    // Ships greedy from day-1 per Run-5 lessons (#33.1, #33.2 shipped
    // non-greedy + had to be fixed). "Sr Eng - Backend - Acme" should
    // split at LAST separator → role="Sr Eng - Backend", company="Acme".
    const html = `
      <html>
        <head><meta property="og:title" content="Sr Engineer - Backend - Acme Co"></head>
        <body><main><h1>Application submitted</h1></main></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/acme/abc/confirmation',
      FIXED_NOW,
    )).toMatchObject({ role: 'Sr Engineer - Backend', company: 'Acme Co' })
  })

  test('detects via Chinese confirmation text', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="产品经理 at 阿里巴巴"></head>
        <body><main><h1>感谢您的申请！</h1></main></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/alibaba/xyz',
      FIXED_NOW,
    )).toMatchObject({
      kind: 'applied',
      company: '阿里巴巴',
      role: '产品经理',
      detected_via: 'text',
    })
  })

  test('keeps scanning when first heading text does NOT confirm (per-element iteration)', () => {
    // Per Run-5 retro: jobTitle h1 should not short-circuit a downstream
    // confirmation h2.
    const html = `
      <html>
        <head><meta property="og:title" content="Role at Co"></head>
        <body>
          <main>
            <h1>Original Posting Title</h1>
            <h2>Application received — we will be in touch</h2>
          </main>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/co/abc',
      FIXED_NOW,
    )).toMatchObject({ kind: 'applied', detected_via: 'text' })
  })

  test('returns null on a plain job listing (no signal)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="DevOps at Acme"></head>
        <body><main><h1>DevOps</h1><button>Apply</button></main></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/acme/abc',
      FIXED_NOW,
    )).toBeNull()
  })

  test('returns null for null root', () => {
    expect(parseSubmitConfirmation(null, 'x', FIXED_NOW)).toBeNull()
  })

  test('does NOT false-positive on tenant slugs like "applied-talent-team" (regression)', () => {
    // \b would fire between "applied" and "-" → /\/applied\b/ would
    // match `/applied-talent-team/abc`. Sub-agent flagged. Fix requires
    // path-separator/end-of-string after the keyword.
    const html = `
      <html>
        <head><meta property="og:title" content="Backend Eng at Acme"></head>
        <body><main><h1>Backend Eng</h1><button>Apply</button></main></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/applied-talent-team/abc-uuid',
      FIXED_NOW,
    )).toBeNull()
  })

  test('does NOT false-positive on tenant slugs like "confirmation-of-x"', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="PM at Acme"></head>
        <body><main><h1>PM</h1><button>Apply</button></main></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/confirmation-services/abc',
      FIXED_NOW,
    )).toBeNull()
  })

  test('does NOT false-positive on body prose containing confirmation phrase', () => {
    // Per Run-4 retro: scoped to main h1/h2; body prose should not trigger.
    const html = `
      <html>
        <head><meta property="og:title" content="Eng at Acme"></head>
        <body>
          <main>
            <article>
              <p>The hiring team will email "thank you for applying" once
                 your application has been reviewed.</p>
            </article>
            <button>Apply</button>
          </main>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.ashbyhq.com/acme/abc',
      FIXED_NOW,
    )).toBeNull()
  })
})

describe('parseAppliedBadge', () => {
  test('detects already-applied indicator', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="PM at Beta"></head>
        <body>
          <main>
            <h1>PM</h1>
            <div data-testid="already-applied">You've already applied to this position.</div>
          </main>
        </body>
      </html>
    `
    expect(parseAppliedBadge(
      dom(html),
      'https://jobs.ashbyhq.com/beta/abc',
    )).toMatchObject({ kind: 'already_applied', role: 'PM', company: 'Beta' })
  })

  test('returns null on a fresh listing', () => {
    const html = `
      <html><body><main>
        <h1>DevOps</h1><button>Apply</button>
      </main></body></html>
    `
    expect(parseAppliedBadge(dom(html), 'https://jobs.ashbyhq.com/x/y')).toBeNull()
  })

  test('does NOT false-positive when prose mentions "already applied"', () => {
    const html = `
      <html><body><main>
        <h1>Engineer</h1>
        <section>
          <p>Note to candidates who have already applied: please do not re-apply.</p>
        </section>
      </main></body></html>
    `
    expect(parseAppliedBadge(dom(html), 'https://jobs.ashbyhq.com/x/y')).toBeNull()
  })
})

describe('parseAshbyPage', () => {
  test('returns confirmation on /confirmation URL', () => {
    const html = `<html><body><main><h1>Thanks</h1></main></body></html>`
    expect(parseAshbyPage(
      dom(html),
      'https://jobs.ashbyhq.com/x/abc/confirmation',
      FIXED_NOW,
    )).toMatchObject({ kind: 'applied' })
  })

  test('returns null on vanilla page', () => {
    expect(parseAshbyPage(
      dom('<html><body><div>Hi</div></body></html>'),
      'https://jobs.ashbyhq.com/x',
      FIXED_NOW,
    )).toBeNull()
  })
})
