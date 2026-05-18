// Greenhouse portal parser — content-script edition.
//
// Hand-mirrors packages/extension-core/src/portal-parsers/greenhouse.js
// because content scripts can't `import` from workspace packages. The ESM
// version is the canonical source: tests live alongside it, behaviour
// changes happen there first, then this file gets updated in sync. We
// flag drift via the matching test suite the SW path exercises.
//
// Loaded into the page via manifest.json content_scripts as a classic
// (non-module) script and registers on globalThis (= window in the page
// context) under `LandedPortalParsers.greenhouse`.
(function () {
  'use strict'

  const GREENHOUSE_HOSTS = [
    'boards.greenhouse.io',
    'boards.eu.greenhouse.io',
    'job-boards.greenhouse.io',
    'job-boards.eu.greenhouse.io',
    'my.greenhouse.io',
  ]

  function isGreenhouseUrl(url) {
    if (!url || typeof url !== 'string') return false
    try {
      const h = new URL(url).hostname.toLowerCase()
      return GREENHOUSE_HOSTS.some((host) => h === host || h.endsWith('.' + host))
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
        } catch { /* malformed JSON-LD — try next */ }
      }
    }

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

    const h1 = firstMatch(root, ['header h1', 'h1.app-title', 'h1.job-title', 'h1'])
    if (h1) {
      const role = textOf(h1)
      const companyEl = firstMatch(root, [
        'header .company-name',
        'header [data-qa="company-name"]',
        '.company-name',
        'meta[property="og:site_name"]',
      ])
      const company = companyEl && companyEl.getAttribute && companyEl.getAttribute('content')
        ? companyEl.getAttribute('content').trim()
        : textOf(companyEl)
      return { role, company }
    }

    return { role: '', company: '' }
  }

  const CONFIRMATION_SIGNALS = [
    /thank you for applying/i,
    /your application has been (received|submitted)/i,
    /application (received|submitted|complete)/i,
    /thanks for (applying|your application)/i,
    /感谢您的申请/,
    /申请已提交/,
    /您的申请已收到/,
  ]

  function parseSubmitConfirmation(root, url, now) {
    if (!root) return null
    now = now || new Date()

    let detected_via = null
    if (url && typeof url === 'string') {
      if (/\/applications\/[0-9a-f-]{8,}/i.test(url)) detected_via = 'url'
      else if (/[?&](submitted|success|thanks)=/i.test(url)) detected_via = 'url'
      else if (/\/thank[- _]?you\b/i.test(url)) detected_via = 'url'
    }

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
        const cls = banner && banner.className
        detected_via = (cls && typeof cls === 'string' && cls.includes('confirmation')) ? 'banner' : 'text'
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

  const APPLIED_BADGE_SIGNALS = [
    /you('|’)?ve (already )?applied/i,
    /already applied/i,
    /application (submitted|on file)/i,
    /您?已申请/,
    /已经申请/,
  ]

  function parseAppliedBadge(root, url) {
    if (!root) return null
    const candidates = [
      '.applied-banner',
      '.has-applied',
      '[data-qa="applied-banner"]',
      '[data-qa="has-applied"]',
      '.application-status',
      '.apply-button-wrapper',
    ]
    for (const sel of candidates) {
      const el = root.querySelector && root.querySelector(sel)
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

  function parseGreenhousePage(root, url, now) {
    return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
  }

  // Register on globalThis so content.js (and any other content-script-
  // context module) can call `globalThis.LandedPortalParsers.greenhouse.*`.
  // Other portal parsers (Lever, Workday, Ashby) will add themselves to
  // the same namespace in their respective followup PRs.
  const ns = globalThis.LandedPortalParsers || (globalThis.LandedPortalParsers = {})
  ns.greenhouse = {
    isGreenhouseUrl,
    parseSubmitConfirmation,
    parseAppliedBadge,
    parseGreenhousePage,
  }
})()
