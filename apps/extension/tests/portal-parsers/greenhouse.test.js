// Tests for (the shipping copy in apps/extension/lib) the Greenhouse portal parser.
//
// Fixtures are hand-authored HTML snippets matching the DOM patterns
// Greenhouse actually renders (verified against live job listings on
// boards.greenhouse.io as of 2026-05-17). Selectors target stable
// signals: JSON-LD JobPosting, og:title, semantic <h1>, .application-
// confirmation. When Greenhouse next refreshes its frontend, expect to
// add another layer to the selector lists in greenhouse.js — not rewrite
// these tests.
require('../../lib/portal-parsers/greenhouse.js')
const {
  isGreenhouseUrl,
  parseSubmitConfirmation,
  parseAppliedBadge,
  parseGreenhousePage,
} = globalThis.LandedPortalParsers.greenhouse

function dom(html) {
  return new DOMParser().parseFromString(html, 'text/html')
}

const FIXED_NOW = new Date('2026-05-17T12:00:00.000Z')

// ── isGreenhouseUrl ───────────────────────────────────────────────────────

describe('isGreenhouseUrl', () => {
  test.each([
    ['https://boards.greenhouse.io/acme', true],
    ['https://boards.greenhouse.io/acme/jobs/12345', true],
    ['https://boards.eu.greenhouse.io/acme/jobs/12345', true],
    ['https://job-boards.greenhouse.io/acme/jobs/12345', true],
    ['https://my.greenhouse.io/applications/abc-def', true],
  ])('matches %s → %s', (url, expected) => {
    expect(isGreenhouseUrl(url)).toBe(expected)
  })

  test.each([
    ['https://careers.acme.com/jobs/12345', false],   // custom domain (even if Greenhouse-powered)
    ['https://lever.co/acme/jobs/12345', false],
    ['https://workday.com', false],
    ['', false],
    ['not a url', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('rejects %s → %s', (url, expected) => {
    expect(isGreenhouseUrl(url)).toBe(expected)
  })
})

// ── parseSubmitConfirmation ───────────────────────────────────────────────

describe('parseSubmitConfirmation', () => {
  test('detects via URL (/applications/<uuid>) + extracts from JSON-LD', () => {
    const html = `
      <html>
        <head>
          <title>Application — Acme Co</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Senior Frontend Engineer",
              "hiringOrganization": { "@type": "Organization", "name": "Acme Co" }
            }
          </script>
        </head>
        <body><main><h1>Thanks!</h1></main></body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/acme/applications/abc12345-def0-1234-5678-9abcdef01234'
    const result = parseSubmitConfirmation(dom(html), url, FIXED_NOW)
    expect(result).toEqual({
      kind: 'applied',
      company: 'Acme Co',
      role: 'Senior Frontend Engineer',
      applied_at: FIXED_NOW.toISOString(),
      app_url: url,
      detected_via: 'url',
    })
  })

  test('detects via banner text (English)', () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Staff Backend Engineer at Acme Co">
        </head>
        <body>
          <main>
            <div class="application-confirmation">
              <h2>Thank you for applying</h2>
              <p>We've received your application and will be in touch.</p>
            </div>
          </main>
        </body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/acme/jobs/12345'
    const result = parseSubmitConfirmation(dom(html), url, FIXED_NOW)
    expect(result).toMatchObject({
      kind: 'applied',
      company: 'Acme Co',
      role: 'Staff Backend Engineer',
      detected_via: 'banner',
    })
  })

  test('detects via banner text (Chinese, 感谢您的申请)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="产品经理 at 阿里巴巴"></head>
        <body><main><h1>感谢您的申请！</h1></main></body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/alibaba/jobs/99999'
    const result = parseSubmitConfirmation(dom(html), url, FIXED_NOW)
    expect(result).toMatchObject({
      kind: 'applied',
      company: '阿里巴巴',
      role: '产品经理',
      detected_via: 'text',
    })
  })

  test('detects via ?submitted=1 query', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Data Scientist at Acme"></head>
        <body><main><h1>Welcome back</h1></main></body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/acme/jobs/99?submitted=1'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      kind: 'applied',
      company: 'Acme',
      role: 'Data Scientist',
      detected_via: 'url',
    })
  })

  test('returns null for a plain job listing page (no signal)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Senior PM at Acme"></head>
        <body><main><h1>Senior PM</h1><form><button>Apply</button></form></main></body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/acme/jobs/12345'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toBeNull()
  })

  test('returns null for null root', () => {
    expect(parseSubmitConfirmation(null, 'x', FIXED_NOW)).toBeNull()
  })

  test('falls back to og:title parsing when JSON-LD is malformed', () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Marketing Lead at Beta Inc">
          <script type="application/ld+json">{ not valid json </script>
        </head>
        <body><main><h2>Thanks for applying</h2></main></body>
      </html>
    `
    const result = parseSubmitConfirmation(dom(html), 'https://boards.greenhouse.io/beta/jobs/1', FIXED_NOW)
    expect(result).toMatchObject({ company: 'Beta Inc', role: 'Marketing Lead' })
  })
})

// ── parseAppliedBadge ─────────────────────────────────────────────────────

describe('parseAppliedBadge', () => {
  test("detects 'You've applied' banner on a job listing", () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Engineering Manager at Acme"></head>
        <body>
          <main>
            <h1>Engineering Manager</h1>
            <div class="apply-button-wrapper">
              <div class="applied-banner">You've applied to this position</div>
            </div>
          </main>
        </body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/acme/jobs/22222'
    expect(parseAppliedBadge(dom(html), url)).toEqual({
      kind: 'already_applied',
      company: 'Acme',
      role: 'Engineering Manager',
      app_url: url,
    })
  })

  test('detects via [data-qa] attribute fallback', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="Recruiter at Acme"></head>
        <body>
          <main>
            <h1>Recruiter</h1>
            <div data-qa="applied-banner">Already applied</div>
          </main>
        </body>
      </html>
    `
    const result = parseAppliedBadge(dom(html), 'https://boards.greenhouse.io/acme/jobs/3')
    expect(result).toMatchObject({ kind: 'already_applied', role: 'Recruiter' })
  })

  test('returns null on a fresh job listing (no badge)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="DevOps at Acme"></head>
        <body><main><h1>DevOps</h1><button>Apply now</button></main></body>
      </html>
    `
    expect(parseAppliedBadge(dom(html), 'https://boards.greenhouse.io/acme/jobs/4')).toBeNull()
  })

  test('does NOT false-positive on body prose containing "already applied" (regression)', () => {
    // Reproduces the sub-agent-flagged risk: a job description that warns
    // returning candidates not to re-apply would have matched the old
    // 'main' fallback selector. Tightened selector list must reject this.
    const html = `
      <html>
        <head><meta property="og:title" content="Engineer at Acme"></head>
        <body>
          <main>
            <h1>Engineer</h1>
            <section class="job-description">
              <p>Note to candidates who have already applied for this role:
                 you do not need to re-apply. Recruiters will be in touch.</p>
            </section>
            <button>Apply now</button>
          </main>
        </body>
      </html>
    `
    expect(parseAppliedBadge(dom(html), 'https://boards.greenhouse.io/acme/jobs/5')).toBeNull()
  })
})

// ── parseGreenhousePage — entry point ─────────────────────────────────────

describe('parseGreenhousePage', () => {
  test('returns the confirmation event when both signals are present (confirmation wins)', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="X at Y"></head>
        <body><main>
          <div class="application-confirmation"><h2>Thank you for applying</h2></div>
          <div class="applied-banner">You've applied</div>
        </main></body>
      </html>
    `
    const url = 'https://boards.greenhouse.io/y/applications/abc12345-1234-5678-9abc-def012345678'
    expect(parseGreenhousePage(dom(html), url, FIXED_NOW)).toMatchObject({ kind: 'applied' })
  })

  test('returns the already-applied event when only the badge is present', () => {
    const html = `
      <html>
        <head><meta property="og:title" content="X at Y"></head>
        <body><main><div class="applied-banner">already applied</div></main></body>
      </html>
    `
    expect(parseGreenhousePage(dom(html), 'https://boards.greenhouse.io/y/jobs/1', FIXED_NOW))
      .toMatchObject({ kind: 'already_applied' })
  })

  test('returns null on a vanilla page', () => {
    const html = `<html><body><main><h1>Just a page</h1></main></body></html>`
    expect(parseGreenhousePage(dom(html), 'https://boards.greenhouse.io/x', FIXED_NOW)).toBeNull()
  })
})
