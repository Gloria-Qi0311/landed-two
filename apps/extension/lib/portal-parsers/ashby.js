// Ashby portal parser — content-script edition. Mirrors
// packages/extension-core/src/portal-parsers/ashby.js (canonical ESM
// source). Registers `window.LandedPortalParsers.ashby`.
(function () {
  'use strict'

  const ASHBY_HOST_RE = /\.ashbyhq\.com$|^ashbyhq\.com$/i

  function isAshbyUrl(url) {
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

    const og = firstMatch(root, [
      'meta[property="og:title"]',
      'meta[name="og:title"]',
      'meta[name="twitter:title"]',
    ])
    if (og && og.getAttribute) {
      const content = (og.getAttribute('content') || '').trim()
      let m = content.match(/^(.+)\s+at\s+(.+?)\s*$/i)
      if (m) return { role: m[1].trim(), company: m[2].trim() }
      m = content.match(/^(.+)\s+[-—]\s+(.+?)\s*$/)
      if (m) return { role: m[1].trim(), company: m[2].trim() }
      if (content) return { role: content, company: '' }
    }

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
    /感谢您的申请/,
    /申请已提交/,
    /您的申请已收到/,
  ]

  function parseSubmitConfirmation(root, url, now) {
    if (!root) return null
    now = now || new Date()

    let detected_via = null
    if (url && typeof url === 'string') {
      if (/\/(confirmation|application-submitted|applicationSubmitted)(?:[/?#]|$)/i.test(url)) detected_via = 'url'
      else if (/\/thank[- _]?you(?:[/?#]|$)/i.test(url)) detected_via = 'url'
      else if (/\/applied(?:[/?#]|$)/i.test(url)) detected_via = 'url'
    }

    if (!detected_via) {
      const candidates = [
        '[data-testid="application-confirmation"]',
        '[data-testid="confirmation-message"]',
        '[data-testid="thankYouMessage"]',
        '.ashby-application-confirmation',
        '.application-confirmation',
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

  function parseAppliedBadge(root, url) {
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

  function parseAshbyPage(root, url, now) {
    return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
  }

  const ns = globalThis.LandedPortalParsers || (globalThis.LandedPortalParsers = {})
  ns.ashby = {
    isAshbyUrl,
    parseSubmitConfirmation,
    parseAppliedBadge,
    parseAshbyPage,
  }
})()
