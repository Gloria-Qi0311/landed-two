// Greenhouse portal parser — pure DOM-in, structured-event-out.
//
// REALITY CHECK on the original #33 framing:
//   The issue title is "extension content scripts: Greenhouse ... 'my
//   applications' DOM parsing". Greenhouse does NOT host a unified candidate
//   portal where users can see all their submitted applications across
//   companies — each company gets its own application form, and there's no
//   logged-in dashboard that lists "all jobs you've applied to via
//   Greenhouse". So the "my applications" framing is aspirational; the
//   highest-value DOM-side moments we CAN capture from Greenhouse are:
//
//     1. APPLICATION SUBMITTED — the post-submit confirmation page that
//        appears after a candidate completes a Greenhouse-hosted form.
//        We extract { company, role, applied_at, app_url } and emit a
//        `new-event` portal_event of type "applied".
//     2. ALREADY-APPLIED BADGE — when a returning candidate revisits a job
//        they already applied to, Greenhouse renders a badge ("You've
//        applied to this position"). Useful for reconciling past
//        applications the user may have submitted before installing Landed.
//
// Pure logic — no `document.*`, no `chrome.*`, no `window.*`. Callers pass
// a DOM root (or any element exposing querySelector/textContent) + the
// current URL. Lets the parser be vitest-tested in jsdom AND swapped to a
// different runtime (a future Playwright-driven scraper, server-side
// rendering audit, etc) without changing the contract.
//
// Selector strategy: Greenhouse's frontend has shipped multiple visual
// refreshes over the years (greenhouse-classic vs job-boards v2 vs the
// 2024 candidate-portal redesign). Every extractor tries a layered set of
// selectors — most specific first, falling through to text-content
// matching. When the structure changes again we add another layer rather
// than break existing fixtures.

// ── URL classification ────────────────────────────────────────────────────

/** Hostnames Greenhouse owns directly. Custom-domain career sites that
 *  embed Greenhouse via <iframe> or <script> aren't detected here —
 *  the embed itself loads from one of these hosts and the parser runs
 *  inside that iframe context. */
const GREENHOUSE_HOSTS = [
  'boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.greenhouse.io',          // newer hosted URL pattern
  'job-boards.eu.greenhouse.io',
  'my.greenhouse.io',                  // candidate-portal redesign (2024+)
]

/** True if the given URL is one of the Greenhouse-owned hosts. */
export function isGreenhouseUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return GREENHOUSE_HOSTS.some((host) => h === host || h.endsWith('.' + host))
  } catch {
    return false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function textOf(el) {
  if (!el) return ''
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

function firstMatch(root, selectors) {
  if (!root || typeof root.querySelector !== 'function') return null
  for (const sel of selectors) {
    const el = root.querySelector(sel)
    if (el) return el
  }
  return null
}

/** Extract the {company, role} pair from a Greenhouse application or
 *  confirmation page. Tries:
 *    1. JSON-LD JobPosting structured data (most reliable when present)
 *    2. meta[property="og:title"] (Greenhouse fills "Role at Company")
 *    3. <h1> with breadcrumb pattern
 *    4. fallback: parse <title>
 */
function extractCompanyAndRole(root) {
  // JSON-LD JobPosting
  if (root && typeof root.querySelectorAll === 'function') {
    const scripts = root.querySelectorAll('script[type="application/ld+json"]')
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || '')
        const node = Array.isArray(data) ? data.find((d) => d['@type'] === 'JobPosting') : data
        if (node && node['@type'] === 'JobPosting') {
          const role = String(node.title || '').trim()
          const company = String(node.hiringOrganization?.name || node.hiringOrganization || '').trim()
          if (role || company) return { role, company }
        }
      } catch { /* malformed JSON-LD — ignore + try next */ }
    }
  }

  // og:title — Greenhouse format: "Senior Engineer at Acme Co"
  const og = firstMatch(root, [
    'meta[property="og:title"]',
    'meta[name="og:title"]',
    'meta[name="twitter:title"]',
  ])
  if (og && og.getAttribute) {
    const content = (og.getAttribute('content') || '').trim()
    const m = content.match(/^(.+?)\s+at\s+(.+?)\s*$/i)
    if (m) return { role: m[1].trim(), company: m[2].trim() }
    if (content) return { role: content, company: '' }
  }

  // <h1> + company subheading. Modern Greenhouse uses <header> with
  // <h1>Role</h1> and a sibling element for company.
  const h1 = firstMatch(root, ['header h1', 'h1.app-title', 'h1.job-title', 'h1'])
  if (h1) {
    const role = textOf(h1)
    const companyEl = firstMatch(root, [
      'header .company-name',
      'header [data-qa="company-name"]',
      '.company-name',
      'meta[property="og:site_name"]',
    ])
    const company = companyEl?.getAttribute?.('content')
      ? companyEl.getAttribute('content').trim()
      : textOf(companyEl)
    return { role, company }
  }

  return { role: '', company: '' }
}

// ── Extractor 1: post-submit confirmation page ────────────────────────────

const CONFIRMATION_SIGNALS = [
  // English
  /thank you for applying/i,
  /your application has been (received|submitted)/i,
  /application (received|submitted|complete)/i,
  /thanks for (applying|your application)/i,
  // Chinese
  /感谢您的申请/,
  /申请已提交/,
  /您的申请已收到/,
]

/** Detect whether the given DOM looks like a Greenhouse application-
 *  confirmation page + extract its metadata. Returns null if not a
 *  confirmation page.
 *
 *  @param {Element|Document} root  page DOM
 *  @param {string}           url   current page URL
 *  @returns {null | {
 *    kind: 'applied',
 *    company: string,
 *    role: string,
 *    applied_at: string,    // ISO timestamp — caller passes "now"
 *    app_url: string,       // canonical job URL if discoverable, else the current URL
 *    detected_via: 'url' | 'text' | 'banner',
 *  }}
 */
export function parseSubmitConfirmation(root, url, now = new Date()) {
  if (!root) return null

  // URL-based signal: post-submit Greenhouse navigates to a URL containing
  // /applications/<uuid> or /thank-you, or shows a query like ?submitted=1.
  let detected_via = null
  if (url && typeof url === 'string') {
    if (/\/applications\/[0-9a-f-]{8,}/i.test(url)) detected_via = 'url'
    else if (/[?&](submitted|success|thanks)=/i.test(url)) detected_via = 'url'
    else if (/\/thank[- _]?you\b/i.test(url)) detected_via = 'url'
  }

  // Text-based signal: a confirmation phrase in a visible banner / h1 / h2.
  if (!detected_via) {
    const banner = firstMatch(root, [
      '.application-confirmation',
      '[data-qa="confirmation"]',
      '.thank-you-message',
      '.confirmation-message',
      'main h1',
      'main h2',
      'h1',
      'h2',
    ])
    const bannerText = textOf(banner)
    if (bannerText && CONFIRMATION_SIGNALS.some((rx) => rx.test(bannerText))) {
      detected_via = banner?.className?.includes?.('confirmation') ? 'banner' : 'text'
    }
  }

  if (!detected_via) return null

  const { company, role } = extractCompanyAndRole(root)
  return {
    kind: 'applied',
    company,
    role,
    applied_at: now.toISOString(),
    app_url: url || '',  // TODO(#34.2): strip PII query params (?candidate_email=, ?token=) before staging
    detected_via,
  }
}

// ── Extractor 2: "you've already applied" badge ───────────────────────────

const APPLIED_BADGE_SIGNALS = [
  /you('|’)?ve (already )?applied/i,
  /already applied/i,
  /application (submitted|on file)/i,
  // Chinese
  /您?已申请/,
  /已经申请/,
]

/** Detect the "You've already applied" badge on a Greenhouse job listing
 *  page. Useful for reconciling past applications the user submitted
 *  before installing Landed.
 *
 *  @param {Element|Document} root  page DOM
 *  @param {string}           url   current page URL
 *  @returns {null | {
 *    kind: 'already_applied',
 *    company: string,
 *    role: string,
 *    app_url: string,
 *  }}
 */
export function parseAppliedBadge(root, url) {
  if (!root) return null

  // The badge is usually a small element near where the "Apply" button
  // would have been. Greenhouse renders it as either a styled badge or
  // a replacement for the apply button itself.
  //
  // Deliberately scoped to badge-specific selectors only. Falling back to
  // `main` (an earlier draft) false-positives on job descriptions
  // containing prose like "candidates who have already applied need not
  // reapply" — better to miss a badge on an exotic layout than emit a
  // phantom 'already_applied' event the downstream pipeline trusts.
  const candidates = [
    '.applied-banner',
    '.has-applied',
    '[data-qa="applied-banner"]',
    '[data-qa="has-applied"]',
    '.application-status',
    '.apply-button-wrapper',  // scoped: the apply-button region only
  ]
  for (const sel of candidates) {
    const el = root.querySelector?.(sel)
    if (!el) continue
    const text = textOf(el)
    if (text && APPLIED_BADGE_SIGNALS.some((rx) => rx.test(text))) {
      const { company, role } = extractCompanyAndRole(root)
      return {
        kind: 'already_applied',
        company,
        role,
        app_url: url || '',
      }
    }
  }
  return null
}

// ── Single entry point: tries both extractors ─────────────────────────────

/** Run both Greenhouse extractors on a page. Returns the first matching
 *  event (confirmation takes precedence over already-applied badge) or
 *  null if the page yielded nothing actionable. */
export function parseGreenhousePage(root, url, now = new Date()) {
  return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
}
