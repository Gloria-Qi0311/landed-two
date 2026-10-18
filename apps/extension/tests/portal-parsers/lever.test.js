// Tests for (the shipping copy in apps/extension/lib) the Lever portal parser. Fixtures mirror Lever's documented
// DOM conventions (jobs.lever.co frontend as of 2026-05-17): posting-
// headline / posting-thanks class structure, og:title "Role - Company"
// format, /thanks URL after submit.
require('../../lib/portal-parsers/lever.js')
const {
  isLeverUrl,
  parseSubmitConfirmation,
  parseAppliedBadge,
  parseLeverPage,
} = globalThis.LandedPortalParsers.lever

const dom = (html) => new DOMParser().parseFromString(html, 'text/html')
const FIXED_NOW = new Date('2026-05-17T12:00:00.000Z')

describe('isLeverUrl', () => {
  test.each([
    ['https://jobs.lever.co/acme', true],
    ['https://jobs.lever.co/acme/abc-123', true],
    ['https://jobs.eu.lever.co/acme/abc-123', true],
    ['https://jobs.lever.co/acme/abc-123/apply', true],
    ['https://jobs.lever.co/acme/abc-123/thanks', true],
  ])('matches %s', (url, expected) => {
    expect(isLeverUrl(url)).toBe(expected)
  })

  test.each([
    ['https://boards.greenhouse.io/acme/jobs/12345', false],
    ['https://careers.acme.com', false],
    ['https://lever.co/about', false],   // not the jobs subdomain
    ['', false],
    [null, false],
    [42, false],
  ])('rejects %s', (url, expected) => {
    expect(isLeverUrl(url)).toBe(expected)
  })
})

describe('parseSubmitConfirmation', () => {
  test('detects via /thanks URL + extracts from JSON-LD', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">{
            "@context":"https://schema.org","@type":"JobPosting",
            "title":"Staff Frontend Engineer",
            "hiringOrganization":{"@type":"Organization","name":"Acme Co"}
          }</script>
        </head>
        <body><div class="posting"><h1>Thanks!</h1></div></body>
      </html>
    `
    const url = 'https://jobs.lever.co/acme/abc-12345/thanks'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toEqual({
      kind: 'applied',
      company: 'Acme Co',
      role: 'Staff Frontend Engineer',
      applied_at: FIXED_NOW.toISOString(),
      app_url: url,
      detected_via: 'url',
    })
  })

  test('detects via banner text (English) using og:title role-dash-company', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Backend Engineer - Acme Co"></head>
        <body>
          <div class="posting">
            <div class="posting-thanks">Thank you for applying! We will be in touch.</div>
          </div>
        </body>
      </html>
    `
    const url = 'https://jobs.lever.co/acme/abc-12345'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      kind: 'applied',
      company: 'Acme Co',
      role: 'Backend Engineer',
      detected_via: 'banner',
    })
  })

  test('detects via banner text (Chinese)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="产品经理 - 阿里巴巴"></head>
        <body><div class="posting"><h2>感谢您的申请！</h2></div></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.lever.co/alibaba/xyz-999',
      FIXED_NOW,
    )).toMatchObject({
      kind: 'applied',
      company: '阿里巴巴',
      role: '产品经理',
      detected_via: 'text',
    })
  })

  test('splits hyphenated role at LAST separator (regression: was first)', () => {
    // Without greedy first capture, "Sr. Eng - Backend - Acme" mis-splits
    // to role="Sr. Eng", company="Backend - Acme". Sub-agent flagged.
    const html = `
      <html>
        <head><meta property="og:title" content="Sr. Engineer - Backend - Acme Co"></head>
        <body><div class="posting"><h1>Thanks!</h1></div></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.lever.co/acme/abc/thanks',
      FIXED_NOW,
    )).toMatchObject({ role: 'Sr. Engineer - Backend', company: 'Acme Co' })
  })

  test('handles em-dash separator in og:title (Lever uses both)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Senior PM — Beta Inc"></head>
        <body><div class="posting"><h1>Application received</h1></div></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.lever.co/beta/abc/thanks',
      FIXED_NOW,
    )).toMatchObject({ company: 'Beta Inc', role: 'Senior PM' })
  })

  test('returns null on a plain job listing (no signal)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="DevOps - Acme"></head>
        <body><div class="posting"><h2 class="posting-name">DevOps</h2><button>Apply</button></div></body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.lever.co/acme/abc-12345',
      FIXED_NOW,
    )).toBeNull()
  })

  test('returns null for null root', () => {
    expect(parseSubmitConfirmation(null, 'x', FIXED_NOW)).toBeNull()
  })

  test('does NOT false-positive on body prose containing "thanks for applying"', () => {
    // Per Run-4 retro: selectors must be scoped — body prose like "we
    // appreciate thanks for applying mentions in your cover letter"
    // would have matched a broad fallback like 'main' or 'body'.
    const html = `
      <html>
        <head><meta property="og:title" content="Eng - Acme"></head>
        <body>
          <main>
            <article>
              <p>We don't accept thanks-for-applying notes as separate
                 submissions; please include them in your cover letter.</p>
            </article>
            <button>Apply</button>
          </main>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://jobs.lever.co/acme/abc-12345',
      FIXED_NOW,
    )).toBeNull()
  })
})

describe('parseAppliedBadge', () => {
  test('always returns null (Lever has no stable badge)', () => {
    expect(parseAppliedBadge(dom('<html></html>'), 'https://jobs.lever.co/x/y')).toBeNull()
  })
})

describe('parseLeverPage', () => {
  test('returns the confirmation event on a thanks URL', () => {
    const html = `
      <html><head><meta property="og:title" content="X - Y"></head>
      <body><div class="posting"><h1>Thanks!</h1></div></body></html>
    `
    expect(parseLeverPage(
      dom(html),
      'https://jobs.lever.co/y/abc/thanks',
      FIXED_NOW,
    )).toMatchObject({ kind: 'applied' })
  })

  test('returns null on a vanilla page', () => {
    expect(parseLeverPage(
      dom('<html><body><div>Hi</div></body></html>'),
      'https://jobs.lever.co/x',
      FIXED_NOW,
    )).toBeNull()
  })
})
