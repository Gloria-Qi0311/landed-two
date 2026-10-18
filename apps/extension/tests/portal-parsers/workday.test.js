// Tests for (the shipping copy in apps/extension/lib) the Workday portal parser. Fixtures mirror Workday's
// data-automation-id-heavy frontend convention as of 2026-05-17.
require('../../lib/portal-parsers/workday.js')
const {
  isWorkdayUrl,
  parseSubmitConfirmation,
  parseAppliedBadge,
  parseWorkdayPage,
} = globalThis.LandedPortalParsers.workday

const dom = (html) => new DOMParser().parseFromString(html, 'text/html')
const FIXED_NOW = new Date('2026-05-17T12:00:00.000Z')

describe('isWorkdayUrl', () => {
  test.each([
    ['https://accenture.wd5.myworkdayjobs.com/en-US/AccentureCareers/job/123', true],
    ['https://nike.wd1.myworkdayjobs.com/Nike_External/job/x', true],
    ['https://abc.wd105.myworkdayjobs.com/x', true],
    ['https://example.wd2.myworkdaysite.com/x', true],
    ['https://acme.wd3.myworkday.com/x', true],   // CN tenant edge case
  ])('matches %s', (url, expected) => {
    expect(isWorkdayUrl(url)).toBe(expected)
  })

  test.each([
    ['https://boards.greenhouse.io/acme/jobs/12345', false],
    ['https://jobs.lever.co/acme/abc', false],
    ['https://careers.acme.com', false],
    // Subdomain-anchor enforcement: a malicious lookalike domain shouldn't match.
    ['https://myworkdayjobs.com.evil.com/x', false],
    ['https://faked-myworkdayjobs.com/x', false],
    ['', false],
    [null, false],
  ])('rejects %s', (url, expected) => {
    expect(isWorkdayUrl(url)).toBe(expected)
  })
})

describe('parseSubmitConfirmation', () => {
  test('detects via /confirmation URL + extracts from data-automation-id', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobPostingHeader">Senior Software Engineer</h2>
          <div data-automation-id="companyName">Accenture</div>
          <h1 data-automation-id="pageHeader">Application Submitted</h1>
        </body>
      </html>
    `
    const url = 'https://accenture.wd5.myworkdayjobs.com/en-US/AccentureCareers/task/jobApply/abc-uuid/confirmation'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      kind: 'applied',
      company: 'Accenture',
      role: 'Senior Software Engineer',
      applied_at: FIXED_NOW.toISOString(),
      app_url: url,
      detected_via: 'url',
    })
  })

  test('detects via applicationSubmittedMessage banner', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">DevOps Engineer</h2>
          <div data-automation-id="companyName">Nike</div>
          <div data-automation-id="applicationSubmittedMessage">Thank you for applying! We have received your application.</div>
        </body>
      </html>
    `
    const url = 'https://nike.wd1.myworkdayjobs.com/Nike_External/job/123/apply'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      kind: 'applied',
      company: 'Nike',
      role: 'DevOps Engineer',
      detected_via: 'banner',
    })
  })

  test('detects via Chinese confirmation text', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">高级工程师</h2>
          <div data-automation-id="companyName">阿里巴巴</div>
          <h1 data-automation-id="confirmationHeader">感谢您的申请！</h1>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://alibaba.wd3.myworkdayjobs.com/Alibaba/job/99/apply',
      FIXED_NOW,
    )).toMatchObject({
      kind: 'applied',
      company: '阿里巴巴',
      role: '高级工程师',
      detected_via: 'banner',
    })
  })

  test('keeps scanning when first matching selector text does NOT confirm', () => {
    // Regression: previously, `h2[data-automation-id]` matched the
    // jobTitle h2 first (text='Role'), failed the CONFIRMATION_SIGNALS
    // regex, and the parser returned null even though a downstream h1
    // had the actual confirmation text. Now we iterate per-element.
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">Random Role</h2>
          <div data-automation-id="companyName">Acme</div>
          <h1 data-automation-id="confirmationHeader">Application submitted</h1>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://acme.wd1.myworkdayjobs.com/A/job/x',
      FIXED_NOW,
    )).toMatchObject({ kind: 'applied', detected_via: 'banner' })
  })

  test('falls back to <title> when QA hooks miss', () => {
    const html = `
      <html>
        <head><title>Data Scientist - Acme Careers - Workday</title></head>
        <body>
          <div data-automation-id="applicationSubmittedMessage">Application received</div>
        </body>
      </html>
    `
    const url = 'https://acme.wd2.myworkdayjobs.com/Acme/job/x/applyComplete'
    const result = parseSubmitConfirmation(dom(html), url, FIXED_NOW)
    expect(result).toMatchObject({
      kind: 'applied',
      role: 'Data Scientist',
      // Company comes from <title> split (URL tenant fallback won't fire
      // because <title> already produced a company).
      company: 'Acme Careers',
    })
  })

  test('title-parse splits at LAST separator on multi-segment titles (regression)', () => {
    // Without greedy first capture, "Sr Eng - Backend - Acme Careers - Workday"
    // would mis-split (Lever shared the same bug class — #33.1).
    const html = `
      <html>
        <head><title>Sr Engineer - Backend - Acme Careers - Workday</title></head>
        <body>
          <div data-automation-id="applicationSubmittedMessage">Application received</div>
        </body>
      </html>
    `
    const url = 'https://acme.wd2.myworkdayjobs.com/Acme/job/x/applyComplete'
    expect(parseSubmitConfirmation(dom(html), url, FIXED_NOW)).toMatchObject({
      role: 'Sr Engineer - Backend',
      company: 'Acme Careers',
    })
  })

  test('falls back to URL tenant when neither QA hooks nor <title> have company', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">Backend Engineer</h2>
          <div data-automation-id="applicationSubmittedMessage">Application received</div>
        </body>
      </html>
    `
    const url = 'https://beta.wd1.myworkdayjobs.com/Beta_Careers/job/x/confirmation'
    const result = parseSubmitConfirmation(dom(html), url, FIXED_NOW)
    expect(result.company).toBe('Beta')  // tenant capitalized
  })

  test('returns null on a plain job listing (no signal)', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">Backend Engineer</h2>
          <button>Apply</button>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://x.wd1.myworkdayjobs.com/X/job/123',
      FIXED_NOW,
    )).toBeNull()
  })

  test('returns null for null root', () => {
    expect(parseSubmitConfirmation(null, 'x', FIXED_NOW)).toBeNull()
  })

  test('does NOT false-positive on body prose containing confirmation phrase', () => {
    // Per Run-4 retro: every parser MUST have this regression test.
    const html = `
      <html>
        <body>
          <main>
            <article data-automation-id="jobDescription">
              <p>You'll be supporting candidates' application received
                 across multiple regions, including ensuring thank you for
                 applying notes reach hiring managers.</p>
            </article>
            <button>Apply</button>
          </main>
        </body>
      </html>
    `
    expect(parseSubmitConfirmation(
      dom(html),
      'https://x.wd1.myworkdayjobs.com/X/job/123',
      FIXED_NOW,
    )).toBeNull()
  })
})

describe('parseAppliedBadge', () => {
  test('detects applicationInProgress data-automation-id', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">QA Engineer</h2>
          <div data-automation-id="companyName">Acme</div>
          <div data-automation-id="applicationInProgress">You already have an application in progress.</div>
        </body>
      </html>
    `
    expect(parseAppliedBadge(
      dom(html),
      'https://acme.wd1.myworkdayjobs.com/A/job/1',
    )).toMatchObject({ kind: 'already_applied', company: 'Acme', role: 'QA Engineer' })
  })

  test('detects withdraw-application button (returning candidate)', () => {
    const html = `
      <html>
        <body>
          <h2 data-automation-id="jobTitle">PM</h2>
          <div data-automation-id="companyName">Beta</div>
          <button data-automation-id="withdrawApplicationButton">Withdraw Application</button>
        </body>
      </html>
    `
    expect(parseAppliedBadge(
      dom(html),
      'https://beta.wd1.myworkdayjobs.com/B/job/1',
    )).toMatchObject({ kind: 'already_applied' })
  })

  test('returns null on a fresh listing with no apply-state markers', () => {
    const html = `
      <html><body>
        <h2 data-automation-id="jobTitle">DevOps</h2>
        <button data-automation-id="applyButton">Apply</button>
      </body></html>
    `
    expect(parseAppliedBadge(
      dom(html),
      'https://x.wd1.myworkdayjobs.com/X/job/4',
    )).toBeNull()
  })
})

describe('parseWorkdayPage', () => {
  test('returns the confirmation event on /confirmation URL', () => {
    const html = `<html><body>
      <h2 data-automation-id="jobTitle">Eng</h2>
      <div data-automation-id="companyName">Y</div>
    </body></html>`
    expect(parseWorkdayPage(
      dom(html),
      'https://y.wd1.myworkdayjobs.com/Y/task/jobApply/abc/confirmation',
      FIXED_NOW,
    )).toMatchObject({ kind: 'applied' })
  })

  test('returns null on a vanilla page', () => {
    expect(parseWorkdayPage(
      dom('<html><body><div>Hi</div></body></html>'),
      'https://x.wd1.myworkdayjobs.com/X',
      FIXED_NOW,
    )).toBeNull()
  })
})
