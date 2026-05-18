// Lever portal parser — content-script edition.
//
// Hand-mirrors packages/extension-core/src/portal-parsers/lever.js.
// Loaded into the page via manifest content_scripts as a classic
// (non-module) script; registers on `window.LandedPortalParsers.lever`.
(function () {
  'use strict'

  const LEVER_HOSTS = [
    'jobs.lever.co',
    'jobs.eu.lever.co',
  ]

  function isLeverUrl(url) {
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
      let m = content.match(/^(.+)\s+[-—]\s+(.+?)\s*$/)
      if (m) return { role: m[1].trim(), company: m[2].trim() }
      m = content.match(/^(.+)\s+at\s+(.+?)\s*$/i)
      if (m) return { role: m[1].trim(), company: m[2].trim() }
      if (content) return { role: content, company: '' }
    }

    const role = textOf(firstMatch(root, [
      '.posting-headline h2',
      'h2[data-qa="posting-name"]',
      '.posting-name',
      'header h1',
      'h1',
    ]))
    const companyEl = firstMatch(root, [
      '.main-header-text h3',
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
    /感谢您的申请/,
    /申请已提交/,
    /您的申请已收到/,
  ]

  function parseSubmitConfirmation(root, url, now) {
    if (!root) return null
    now = now || new Date()

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
        '.thanks',
        '.posting-thanks',
        '.confirmation-message',
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

  function parseAppliedBadge(_root, _url) {
    return null
  }

  function parseLeverPage(root, url, now) {
    return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
  }

  const ns = globalThis.LandedPortalParsers || (globalThis.LandedPortalParsers = {})
  ns.lever = {
    isLeverUrl,
    parseSubmitConfirmation,
    parseAppliedBadge,
    parseLeverPage,
  }
})()
