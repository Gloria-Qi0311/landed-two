// Ashby portal parser.
//
// Ashby is a 2020+ ATS with a cleaner React frontend than Workday and
// better JSON-LD JobPosting coverage than either Greenhouse or Lever.
// Primary host: `jobs.ashbyhq.com/<company>/<uuid>`. Custom-domain
// careers sites also live under `*.ashbyhq.com` for some tenants.
//
// Selector strategy: JSON-LD JobPosting first (Ashby ships it
// reliably), og:title second ("Role at Company" or "Role - Company"
// depending on tenant template), DOM landmarks as the tail. Per
// Run-4 retro lessons:
//   - greedy first capture on dash/at regexes from the start (no shipped
//     hyphen bug to fix-later as we did with Lever / Workday)
//   - per-element iteration on banner detection so a jobTitle heading
//     can't short-circuit a downstream confirmation heading
//   - no `main` / `body` fallback selectors that false-positive on
//     body prose
//
// Pure logic — no chrome.* / document.* / window.* refs.

// Anchored to second-level domain to prevent `ashbyhq.com.evil.com` and
// `faked-ashbyhq.com` lookalike attacks (same pattern as workday.js).
const ASHBY_HOST_RE = /\.ashbyhq\.com$|^ashbyhq\.com$/i

export function isAshbyUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return ASHBY_HOST_RE.test(h)
  } catch {
    return false
  }
}

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

function extractCompanyAndRole(root) {
  // JSON-LD JobPosting — Ashby's most reliable signal.
  if (root && typeof root.querySelectorAll === 'function') {
    const scripts = root.querySelectorAll('script[type="application/ld+json"]')
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || '')
        const node = Array.isArray(data) ? data.find((d) => d['@type'] === 'JobPosting') : data
        if (node && node['@type'] === 'JobPosting') {
          const role = String(node.title || '').trim()
          const orgName = node.hiringOrganization && node.hiringOrganization.name
          const company = String(orgName || node.hiringOrganization || '').trim()
          if (role || company) return { role, company }
        }
      } catch { /* try next */ }
    }
  }

  // og:title — Ashby uses two patterns depending on tenant template:
  // "Role at Company" or "Role - Company". Greedy first capture on both
  // (per Run-5 retro lessons) so multi-segment titles split at the LAST
  // separator.
  const og = firstMatch(root, [
    'meta[property="og:title"]',
    'meta[name="og:title"]',
    'meta[name="twitter:title"]',
  ])
  if (og && og.getAttribute) {
    const content = (og.getAttribute('content') || '').trim()
    // Try "Role at Company" first (more common on Ashby), then dash variants.
    let m = content.match(/^(.+)\s+at\s+(.+?)\s*$/i)
    if (m) return { role: m[1].trim(), company: m[2].trim() }
    m = content.match(/^(.+)\s+[-—]\s+(.+?)\s*$/)
    if (m) return { role: m[1].trim(), company: m[2].trim() }
    if (content) return { role: content, company: '' }
  }

  // DOM landmarks. Ashby uses `_root_` / `_jobPostingHeader_` style
  // CSS Modules class names that hash on each deploy, so we can't pin
  // those. Stable selectors are the semantic ones + a few test-id-ish
  // attrs Ashby has used historically.
  const roleEl = firstMatch(root, [
    'h1[data-testid="job-title"]',
    '[data-testid="jobPostingHeader"]',
    'h1.ashby-job-posting-heading',
    'header h1',
    'h1',
  ])
  const companyEl = firstMatch(root, [
    '[data-testid="company-name"]',
    'header [data-testid="organization-name"]',
    '.ashby-org-header',
    'meta[property="og:site_name"]',
  ])
  const role = textOf(roleEl)
  const company = companyEl && companyEl.getAttribute && companyEl.getAttribute('content')
    ? companyEl.getAttribute('content').trim()
    : textOf(companyEl)
  return { role, company }
}

const CONFIRMATION_SIGNALS = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application (received|submitted|complete)/i,
  /your application has been (received|submitted)/i,
  /we('ve| have) received your application/i,
  /you('ve| have) successfully (applied|submitted)/i,
  // Chinese
  /感谢您的申请/,
  /申请已提交/,
  /您的申请已收到/,
]

/** Detect Ashby post-submit confirmation. Returns null if not a
 *  confirmation page. */
export function parseSubmitConfirmation(root, url, now = new Date()) {
  if (!root) return null

  // URL signals — Ashby's post-submit pattern is /confirmation or a
  // /application-submitted variant. Some tenants stay on the form route
  // and show an inline banner.
  let detected_via = null
  if (url && typeof url === 'string') {
    // Tighter than \b — require path separator / query / end-of-string
    // right after the keyword so `/applied-talent-team/abc` (a legit
    // listing) doesn't get classified as a confirmation. Sub-agent
    // flagged: \b fires between word and `-`, so the looser version
    // would match. Same tightening applied to confirmation.
    if (/\/(confirmation|application-submitted|applicationSubmitted)(?:[/?#]|$)/i.test(url)) detected_via = 'url'
    else if (/\/thank[- _]?you(?:[/?#]|$)/i.test(url)) detected_via = 'url'
    else if (/\/applied(?:[/?#]|$)/i.test(url)) detected_via = 'url'
  }

  // DOM signals — per-element iteration so the jobTitle h1 can't
  // short-circuit a downstream confirmation h1/h2 (Run-5 lesson).
  if (!detected_via) {
    const candidates = [
      '[data-testid="application-confirmation"]',
      '[data-testid="confirmation-message"]',
      '[data-testid="thankYouMessage"]',
      '.ashby-application-confirmation',
      '.application-confirmation',
      // Scoped headings only — NOT body / main, AND not bare h1/h2.
      // Sub-agent flagged: a JD page with `<main><h2>Why apply at
      // Acme — thank you for applying...</h2></main>` would otherwise
      // false-positive. Keep main-scoped, drop bare globals.
      'main h1',
      'main h2',
    ]
    if (root && typeof root.querySelectorAll === 'function') {
      outer: for (const sel of candidates) {
        const els = root.querySelectorAll(sel)
        for (const el of els) {
          const text = textOf(el)
          if (!text || !CONFIRMATION_SIGNALS.some((rx) => rx.test(text))) continue
          const id = (el.getAttribute && el.getAttribute('data-testid')) || ''
          const cls = (el.className && typeof el.className === 'string') ? el.className : ''
          detected_via = (/confirm|thank/i.test(id) || /confirmation|thanks/i.test(cls)) ? 'banner' : 'text'
          break outer
        }
      }
    }
  }

  if (!detected_via) return null

  const { company, role } = extractCompanyAndRole(root)
  return {
    kind: 'applied',
    company,
    role,
    applied_at: now.toISOString(),
    app_url: url || '',  // TODO(#34.2): strip PII query params before staging
    detected_via,
  }
}

/** Ashby occasionally shows "You've already applied" on returning
 *  visits. Selector list kept tight (no body / main fallback). */
export function parseAppliedBadge(root, url) {
  if (!root) return null
  const candidates = [
    '[data-testid="already-applied"]',
    '[data-testid="applied-indicator"]',
    '.ashby-already-applied',
    '.already-applied',
  ]
  const APPLIED_SIGNALS = [
    /you('ve| have) already applied/i,
    /already applied/i,
    /application (on file|in progress)/i,
    /您?已申请/,
    /已经申请/,
  ]
  for (const sel of candidates) {
    const el = root.querySelector && root.querySelector(sel)
    if (!el) continue
    const text = textOf(el)
    if (!text || !APPLIED_SIGNALS.some((rx) => rx.test(text))) continue
    const { company, role } = extractCompanyAndRole(root)
    return {
      kind: 'already_applied',
      company,
      role,
      app_url: url || '',
    }
  }
  return null
}

export function parseAshbyPage(root, url, now = new Date()) {
  return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
}
