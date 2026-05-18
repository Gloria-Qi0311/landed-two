// Workday portal parser.
//
// Workday is the most fragmented of the three target ATSes:
//   - Each customer is on a per-tenant subdomain like
//     `accenture.wd5.myworkdayjobs.com` or `nike.wd1.myworkdaysite.com`
//     (older). Workday rotates customers across pools wd1..wd105+ as
//     they scale. We match the SECOND-LEVEL domain pattern, not a
//     fixed host list.
//   - The frontend is a heavy React SPA with extensive `data-automation-id`
//     attributes for QA hooks — that's our primary selector surface.
//   - No reliable og:title (it's often the generic "Workday" tenant).
//     Job title and company come from the data-automation-id elements
//     and/or URL tenant extraction.
//
// Pure logic — no chrome.* / document.* / window.* refs.

// Match any subdomain of myworkdayjobs.com / myworkdaysite.com /
// myworkday.com (CN tenants sometimes). Anchored: must END with the
// second-level domain, otherwise a malicious 'myworkdayjobs.com.evil.com'
// would slip through.
const WORKDAY_HOST_RE = /\.(myworkdayjobs|myworkdaysite|myworkday)\.com$/i

export function isWorkdayUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return WORKDAY_HOST_RE.test(h)
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

/** Extract the tenant slug from a Workday URL. e.g.
 *  `https://accenture.wd5.myworkdayjobs.com/...` → 'accenture'.
 *  Used as a company-name fallback when the DOM doesn't expose it. */
function tenantFromUrl(url) {
  if (!url) return ''
  try {
    const h = new URL(url).hostname.toLowerCase()
    // First label is the tenant: `<tenant>.wdN.myworkdayjobs.com`.
    const first = h.split('.')[0]
    // Skip the pool prefix if the URL is shaped like `wd5.myworkdayjobs.com`
    // (rare — happens on internal landing pages without a tenant).
    if (/^wd\d+$/.test(first)) return ''
    return first
  } catch {
    return ''
  }
}

/** Extract { company, role } from a Workday page. Tries data-automation-id
 *  selectors first (Workday's stable QA hooks), then page <title>, then
 *  URL tenant for company. */
function extractCompanyAndRole(root, url) {
  // JSON-LD JobPosting — rare on Workday but check anyway.
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

  // Workday's stable QA hooks. Most reliable in current frontend.
  const roleEl = firstMatch(root, [
    '[data-automation-id="jobPostingHeader"]',
    'h2[data-automation-id="jobTitle"]',
    '[data-automation-id="jobTitle"]',
    '[data-automation-id="job_title"]',
    'h1[data-automation-id="pageHeader"]',
  ])
  const companyEl = firstMatch(root, [
    '[data-automation-id="companyName"]',
    '[data-automation-id="company_name"]',
    '[data-automation-id="organizationName"]',
  ])
  let role = textOf(roleEl)
  let company = textOf(companyEl)

  // Page <title> is "<Role> - <Tenant Workday>" or similar; only useful
  // if QA hooks didn't fire.
  if (!role) {
    const titleEl = root && root.querySelector && root.querySelector('title')
    const titleText = textOf(titleEl)
    if (titleText) {
      // Strip a trailing " | Workday" or " - Workday" so we don't bake
      // the vendor name into role.
      const cleaned = titleText.replace(/\s*[-|]\s*workday\s*$/i, '').trim()
      // Greedy first capture splits at the LAST separator — same bug
      // class as Lever's hyphenated-role fix in #33.1.
      const m = cleaned.match(/^(.+)\s+[-|]\s+(.+?)\s*$/)
      if (m) {
        role = m[1].trim()
        if (!company) company = m[2].trim()
      } else if (cleaned) {
        role = cleaned
      }
    }
  }

  // URL tenant fallback for company. Convert "accenture" → "Accenture"
  // (capitalize first letter — Workday tenant slugs are lowercase).
  if (!company) {
    const tenant = tenantFromUrl(url)
    if (tenant) company = tenant.charAt(0).toUpperCase() + tenant.slice(1)
  }

  return { role, company }
}

const CONFIRMATION_SIGNALS = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application submitted/i,
  /application received/i,
  /your application has been (received|submitted)/i,
  // Workday-specific phrases observed
  /we have received your application/i,
  /you('ve| have) successfully (applied|submitted)/i,
  // Chinese (CN tenants exist)
  /感谢您的申请/,
  /申请已提交/,
  /您的申请已收到/,
]

/** Detect Workday post-submit confirmation. Returns null if not a
 *  confirmation page. */
export function parseSubmitConfirmation(root, url, now = new Date()) {
  if (!root) return null

  // URL signals — Workday's post-submit routes typically include
  // /confirmation, /applyComplete, /jobConfirmation, /applySubmitted,
  // or a /thank-you variant in the SPA hash.
  let detected_via = null
  if (url && typeof url === 'string') {
    if (/\/(confirmation|applyComplete|jobConfirmation|applySubmitted)\b/i.test(url)) detected_via = 'url'
    else if (/\/thank[- _]?you\b/i.test(url)) detected_via = 'url'
    else if (/\/jobSubmitted\b/i.test(url)) detected_via = 'url'
  }

  // DOM signals — Workday uses data-automation-id for confirmation
  // banners. We iterate selectors AND check text together: the jobTitle
  // heading also matches `h2[data-automation-id]` but its text won't
  // match CONFIRMATION_SIGNALS, so we need to keep scanning past it
  // until we find a hit (or run out of selectors).
  if (!detected_via) {
    const candidates = [
      '[data-automation-id="applicationSubmittedMessage"]',
      '[data-automation-id="confirmationMessage"]',
      '[data-automation-id="thankYouMessage"]',
      '[data-automation-id="applicationConfirmation"]',
      '.WCPI .css-confirmation',     // Workday's css-* shielded classes
      // Scoped headings only — NOT body / main per Run-4 retro lesson.
      'h1[data-automation-id]',
      'h2[data-automation-id]',
    ]
    if (root && typeof root.querySelectorAll === 'function') {
      outer: for (const sel of candidates) {
        const els = root.querySelectorAll(sel)
        for (const el of els) {
          const text = textOf(el)
          if (!text || !CONFIRMATION_SIGNALS.some((rx) => rx.test(text))) continue
          const id = (el.getAttribute && el.getAttribute('data-automation-id')) || ''
          detected_via = /confirm|thank|submit/i.test(id) ? 'banner' : 'text'
          break outer
        }
      }
    }
  }

  if (!detected_via) return null

  const { company, role } = extractCompanyAndRole(root, url)
  return {
    kind: 'applied',
    company,
    role,
    applied_at: now.toISOString(),
    app_url: url || '',
    detected_via,
  }
}

/** Workday occasionally shows an "Application in progress" / "Withdraw
 *  application" surface for returning candidates. The most stable signal
 *  is `data-automation-id="applicationInProgress"` or a "withdraw"
 *  button label. We treat that as a weak `already_applied` signal. */
export function parseAppliedBadge(root, url) {
  if (!root) return null
  const candidates = [
    '[data-automation-id="applicationInProgress"]',
    '[data-automation-id="alreadyApplied"]',
    '[data-automation-id="withdrawApplication"]',
    'button[data-automation-id*="withdraw" i]',
  ]
  for (const sel of candidates) {
    const el = root.querySelector && root.querySelector(sel)
    if (!el) continue
    const text = textOf(el)
    // For withdraw-button case any non-empty text is enough; for the
    // in-progress / already-applied attrs the element existing is enough.
    if (el.getAttribute && /withdraw/i.test(el.getAttribute('data-automation-id') || '') && !text) continue
    const { company, role } = extractCompanyAndRole(root, url)
    return {
      kind: 'already_applied',
      company,
      role,
      app_url: url || '',
    }
  }
  return null
}

export function parseWorkdayPage(root, url, now = new Date()) {
  return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
}
