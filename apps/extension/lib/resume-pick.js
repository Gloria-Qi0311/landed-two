// lib/resume-pick.js — which resume to fill a page with, when the user
// doesn't pick one: the version tailored for this job (it was opened from
// Landed for that application, or its target's link, or company + role in
// the page title, match), else the current resume, else the master, else the
// newest. Same rule as Landed's "Open & autofill" (apps/web/src/lib/
// apply-assist.ts). Used by the popup and the menu-bar fill ("auto").
//
// Resumes: { id, name, is_current, created_at, kind?, target? | target_json? }
// where target = { role, company, job_url, application_id }.

(function (global) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s\u00a0·|,–—-]+/g, ' ').trim()

  function samePosting(a, b) {
    try {
      const x = new URL(a)
      const y = new URL(b)
      const path = (u) => u.pathname.replace(/\/+$/, '')
      return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && (path(x) === path(y) || path(y).startsWith(path(x) + '/'))
    } catch {
      return false
    }
  }

  /** How well a version's target fits the page: 4 opened for this
   *  application, 3 same posting, 2 company and most of the role in the
   *  title, else 0. */
  function fit(target, page) {
    if (!target || typeof target !== 'object') return 0
    if (page.applicationId && target.application_id === page.applicationId) return 4
    if (target.job_url && page.url && samePosting(target.job_url, page.url)) return 3
    const title = norm(page.title)
    const company = norm(target.company)
    if (!title || !company || !title.includes(company)) return 0
    // Short English words ("of", "an") say little; CJK words always count.
    const words = norm(target.role).split(' ').filter((w) => w.length > 2 || w.charCodeAt(0) > 127)
    if (words.length === 0) return 0
    return words.filter((w) => title.includes(w)).length / words.length >= 0.6 ? 2 : 0
  }

  const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))

  /** { resume, why: 'tailored' | 'current' | 'master' | 'newest' } or null. */
  function pickResumeForPage(page, resumes) {
    const list = (Array.isArray(resumes) ? resumes : []).filter((r) => r && r.id && (r.parsed_json === undefined || r.parsed_json))
    if (list.length === 0) return null
    let best = null
    let bestFit = 0
    for (const r of [...list].sort(newestFirst)) {
      if (r.kind !== 'version') continue
      const score = fit(r.target || r.target_json, page || {})
      if (score > bestFit) { best = r; bestFit = score }
    }
    if (best && bestFit >= 2) return { resume: best, why: 'tailored' }
    const current = list.find((r) => r.is_current)
    if (current) return { resume: current, why: 'current' }
    const master = list.find((r) => r.kind === 'master')
    if (master) return { resume: master, why: 'master' }
    return { resume: [...list].sort(newestFirst)[0], why: 'newest' }
  }

  const api = { pickResumeForPage, fit }
  global.LandedResumePick = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)
