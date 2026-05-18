// Lever portal parser — same shape as greenhouse.js.
//
// Lever hosts applications at jobs.lever.co/<company>/<uuid>. The
// confirmation page after submit is typically /<uuid>/thanks, and Lever's
// frontend uses og:title in "Role - Company" format (note the dash, not
// "at" — different from Greenhouse). Lever doesn't render a stable
// "already applied" badge on returning visits (the apply button just
// changes state silently), so this parser only emits 'applied' events
// from confirmation pages.
//
// Pure logic — no chrome.* / document.* / window.* refs. Caller passes
// DOM root + URL. Selector layers degrade gracefully when Lever ships
// frontend refreshes (mirrors greenhouse.js's strategy).

const LEVER_HOSTS = [
  'jobs.lever.co',
  'jobs.eu.lever.co',
]

export function isLeverUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return LEVER_HOSTS.some((host) => h === host || h.endsWith('.' + host))
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

/** Extract { company, role } from a Lever page.
 *  Layered: JSON-LD JobPosting → og:title ("Role - Company") → h2 title +
 *  posting headline. Lever's structured-data coverage is partial; og:title
 *  is the most reliable single signal. */
function extractCompanyAndRole(root) {
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
      } catch { /* malformed — try next */ }
    }
  }

  // Lever's og:title format: "<Role> - <Company>" (em dash sometimes too).
  const og = firstMatch(root, [
    'meta[property="og:title"]',
    'meta[name="og:title"]',
    'meta[name="twitter:title"]',
  ])
  if (og && og.getAttribute) {
    const content = (og.getAttribute('content') || '').trim()
    // Try " - " first (Lever's canonical), then " — " (em dash variant).
    // Greedy on first capture so a hyphenated role ("Sr. Eng - Backend -
    // Acme") splits at the LAST separator — sub-agent caught this same
    // bug class as Greenhouse's last-"at" issue.
    let m = content.match(/^(.+)\s+[-—]\s+(.+?)\s*$/)
    if (m) return { role: m[1].trim(), company: m[2].trim() }
    // Fallback: " at " in case Lever ever switches to Greenhouse-style.
    m = content.match(/^(.+)\s+at\s+(.+?)\s*$/i)
    if (m) return { role: m[1].trim(), company: m[2].trim() }
    if (content) return { role: content, company: '' }
  }

  // Lever-specific DOM landmarks: posting headline + sticky company name.
  const role = textOf(firstMatch(root, [
    '.posting-headline h2',
    'h2[data-qa="posting-name"]',
    '.posting-name',
    'header h1',
    'h1',
  ]))
  const companyEl = firstMatch(root, [
    '.main-header-text h3',          // Lever's sticky top header
    '[data-qa="company-name"]',
    '.company-name',
    'meta[property="og:site_name"]',
  ])
  const company = companyEl && companyEl.getAttribute && companyEl.getAttribute('content')
    ? companyEl.getAttribute('content').trim()
    : textOf(companyEl)
  return { role, company }
}

const CONFIRMATION_SIGNALS = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application received/i,
  /your application has been (received|submitted)/i,
  /we('ve| have) received your application/i,
  // Chinese (mirrors greenhouse.js — Lever supports CN postings)
  /感谢您的申请/,
  /申请已提交/,
  /您的申请已收到/,
]

/** Detect Lever post-submit confirmation. Returns null if not a
 *  confirmation page. */
export function parseSubmitConfirmation(root, url, now = new Date()) {
  if (!root) return null

  // URL signals: Lever's standard post-submit pattern is /thanks. Some
  // refreshes have used ?status=applied or /confirmation.
  let detected_via = null
  if (url && typeof url === 'string') {
    if (/\/thanks?\b/i.test(url)) detected_via = 'url'
    else if (/\/confirmation\b/i.test(url)) detected_via = 'url'
    else if (/[?&](submitted|status)=(applied|success|thanks)/i.test(url)) detected_via = 'url'
  }

  if (!detected_via) {
    const banner = firstMatch(root, [
      '.application-confirmation',
      '[data-qa="confirmation"]',
      '.thanks',                   // Lever's stock thanks block
      '.posting-thanks',
      '.confirmation-message',
      // Scoped headings only — not body / main (per Run-4 retro: broad
      // fallbacks can match prose like "thanks for considering applying").
      '.posting h1',
      '.posting h2',
    ])
    const bannerText = textOf(banner)
    if (bannerText && CONFIRMATION_SIGNALS.some((rx) => rx.test(bannerText))) {
      const cls = banner && banner.className
      detected_via = (cls && typeof cls === 'string' && /thanks|confirmation/i.test(cls)) ? 'banner' : 'text'
    }
  }

  if (!detected_via) return null

  const { company, role } = extractCompanyAndRole(root)
  return {
    kind: 'applied',
    company,
    role,
    applied_at: now.toISOString(),
    app_url: url || '',
    detected_via,
  }
}

/** Lever doesn't render a stable already-applied badge — the apply button
 *  silently transitions. Returning null keeps the contract symmetric with
 *  greenhouse.js so the entry point can chain uniformly. */
export function parseAppliedBadge(_root, _url) {
  return null
}

export function parseLeverPage(root, url, now = new Date()) {
  return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
}
