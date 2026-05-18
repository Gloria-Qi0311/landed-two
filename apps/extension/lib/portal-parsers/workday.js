// Workday portal parser — content-script edition. Hand-mirrors
// packages/extension-core/src/portal-parsers/workday.js (canonical ESM
// source has the tests). Registers `window.LandedPortalParsers.workday`.
(function () {
  'use strict'

  const WORKDAY_HOST_RE = /\.(myworkdayjobs|myworkdaysite|myworkday)\.com$/i

  function isWorkdayUrl(url) {
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

  function tenantFromUrl(url) {
    if (!url) return ''
    try {
      const h = new URL(url).hostname.toLowerCase()
      const first = h.split('.')[0]
      if (/^wd\d+$/.test(first)) return ''
      return first
    } catch {
      return ''
    }
  }

  function extractCompanyAndRole(root, url) {
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

    if (!role) {
      const titleEl = root && root.querySelector && root.querySelector('title')
      const titleText = textOf(titleEl)
      if (titleText) {
        const cleaned = titleText.replace(/\s*[-|]\s*workday\s*$/i, '').trim()
        const m = cleaned.match(/^(.+)\s+[-|]\s+(.+?)\s*$/)
        if (m) {
          role = m[1].trim()
          if (!company) company = m[2].trim()
        } else if (cleaned) {
          role = cleaned
        }
      }
    }

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
    /we have received your application/i,
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
      if (/\/(confirmation|applyComplete|jobConfirmation|applySubmitted)\b/i.test(url)) detected_via = 'url'
      else if (/\/thank[- _]?you\b/i.test(url)) detected_via = 'url'
      else if (/\/jobSubmitted\b/i.test(url)) detected_via = 'url'
    }

    if (!detected_via) {
      const candidates = [
        '[data-automation-id="applicationSubmittedMessage"]',
        '[data-automation-id="confirmationMessage"]',
        '[data-automation-id="thankYouMessage"]',
        '[data-automation-id="applicationConfirmation"]',
        '.WCPI .css-confirmation',
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

  function parseAppliedBadge(root, url) {
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

  function parseWorkdayPage(root, url, now) {
    return parseSubmitConfirmation(root, url, now) || parseAppliedBadge(root, url)
  }

  const ns = globalThis.LandedPortalParsers || (globalThis.LandedPortalParsers = {})
  ns.workday = {
    isWorkdayUrl,
    parseSubmitConfirmation,
    parseAppliedBadge,
    parseWorkdayPage,
  }
})()
