// lib/resume-pick.js — which resume to fill a page with: Landed decides, the
// user can still choose one. A user may apply to several kinds of roles with
// a resume for each, so:
//   1. the version tailored for this job (opened from Landed for that
//      application, its target's link, or company + most of the role in the
//      page title);
//   2. else, of the resumes that have a file to upload (an upload's own file,
//      a version's one-page PDF), the one whose direction fits the job best:
//      the job's title against the resume's direction (a version's target
//      role; an upload's intended position, its name, its latest titles),
//      plus how many of its skills the posting mentions. Low or close scores
//      are marked `unsure`;
//   3. none with a file: the current resume, then the master, then the
//      newest (`why: 'no_file'` when files are known, so it's said).
// The file uploaded is always the picked resume's own (lib/fill/files.js),
// never another one's. Same rule as Landed's "Open & autofill"
// (apps/web/src/lib/apply-assist.ts). Used by the popup and the menu-bar
// fill ("auto").
//
// Resumes: { id, name, is_current, created_at, kind?, parsed_json?, target? | target_json? }
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

  // ── how well a resume's direction fits a job ─────────────────────────────

  const EXPAND = {
    pm: ['product', 'manager'], apm: ['associate', 'product', 'manager'], tpm: ['technical', 'program', 'manager'],
    swe: ['software', 'engineer'], sde: ['software', 'engineer'], eng: ['engineer'], dev: ['developer'],
    ds: ['data', 'scientist'], da: ['data', 'analyst'], ba: ['business', 'analyst'], ml: ['machine', 'learning'],
    mle: ['machine', 'learning', 'engineer'], ai: ['ai'], ux: ['ux'], ui: ['ui'], fe: ['frontend'], be: ['backend'],
    qa: ['quality'], ops: ['operations'], mgr: ['manager'], sr: ['senior'], jr: ['junior'],
  }
  // One word for a job word's forms: "Product Management" is a product manager job.
  const LEMMA = {
    management: 'manager', manage: 'manager', managing: 'manager', engineering: 'engineer', analytics: 'analyst',
    analysis: 'analyst', science: 'scientist', design: 'designer', development: 'developer', marketing: 'marketer',
    research: 'researcher', consulting: 'consultant', internship: 'intern', interns: 'intern', operation: 'operations',
  }
  // Words in a resume's name that say nothing about its direction.
  const NAME_NOISE = new Set(['resume', 'cv', 'final', 'new', 'updated', 'latest', 'copy', 'version', 'draft', 'pdf', 'docx', 'and', 'the', 'for', 'of'])
  const CJK = /[\u3400-\u9fff]/

  /** Title words: latin words (abbreviations expanded) and Chinese character pairs. */
  function titleWords(text) {
    const out = []
    for (const raw of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (!raw) continue
      if (CJK.test(raw)) {
        const chars = [...raw].filter((c) => CJK.test(c))
        if (chars.length === 1) out.push(chars[0])
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
      } else if (EXPAND[raw]) out.push(...EXPAND[raw])
      else if (raw.length > 1 && !/^\d+$/.test(raw)) out.push(LEMMA[raw] || raw)
    }
    return out
  }

  /** What a resume is for, as title phrases: a version's target role; an
   *  upload's intended position, its name (minus the person's name and
   *  "resume"), and its two latest job titles. */
  function directions(r) {
    const target = r.target || r.target_json
    if (r.kind === 'version' && target && target.role) return [target.role]
    // What the user (or Landed, at upload) said it's for.
    if (Array.isArray(r.directions) && r.directions.length) return r.directions
    const p = r.parsed_json || {}
    const basic = p.basic || {}
    const person = new Set(titleWords(`${basic.name || ''} ${basic.firstName || ''} ${basic.lastName || ''} ${basic.englishName || ''}`))
    const fromName = titleWords(r.name).filter((w) => !person.has(w) && !NAME_NOISE.has(w) && !/^v\d+$/.test(w)).join(' ')
    const jobs = [...(Array.isArray(p.experience) ? p.experience : []), ...(Array.isArray(p.internship) ? p.internship : [])]
      .filter((e) => e && (e.title || e.position || e.role))
      .sort((a, b) => String(b.start_date || b.startDate || '').localeCompare(String(a.start_date || a.startDate || '')))
      .slice(0, 2)
      .map((e) => e.title || e.position || e.role)
    return [p.intent && p.intent.apply_position, fromName, ...jobs].filter((d) => d && String(d).trim())
  }

  /** Share of a direction's words that are in the job title (0..1), best direction. */
  function roleFit(r, jobTitle) {
    const job = new Set(titleWords(jobTitle))
    if (job.size === 0) return 0
    let best = 0
    for (const d of directions(r)) {
      const words = [...new Set(titleWords(d))]
      if (words.length === 0) continue
      best = Math.max(best, words.filter((w) => job.has(w)).length / words.length)
    }
    return best
  }

  /** Share of a resume's skills the posting mentions (0..1; 10 or more is full). */
  function skillFit(r, text) {
    const body = ` ${String(text || '').toLowerCase()} `
    const skills = (Array.isArray(r.parsed_json && r.parsed_json.skills) ? r.parsed_json.skills : [])
      .map((s) => String(s || '').toLowerCase().trim()).filter((s) => s.length > 1).slice(0, 40)
    if (!body.trim() || skills.length === 0) return 0
    const hits = skills.filter((s) => {
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(body)
    }).length
    return Math.min(1, hits / Math.min(10, skills.length))
  }

  /** How well a resume fits a job: mostly its direction against the title. */
  function score(r, page) {
    return 0.75 * roleFit(r, page.jobTitle || page.title) + 0.25 * skillFit(r, page.text)
  }

  /** A direction is a job's when at least half its words are in the title. */
  const DIRECTION_MATCH = 0.5
  const UNSURE_BELOW = 0.3
  const UNSURE_MARGIN = 0.1

  /** { resume, why, unsure?, score? } or null.
   *  why: 'tailored' | 'direction' | 'fits' | 'only' | 'no_file' | 'current' | 'master' | 'newest';
   *  composite: several resumes are of the job's direction (decided by skills).
   *  page: { url, title, jobTitle?, text?, applicationId? };
   *  opts.hasFile(id): the resume has its own file. Without it, files aren't
   *  known (an older caller): no scoring, the old order. */
  function pickResumeForPage(page, resumes, opts) {
    const list = (Array.isArray(resumes) ? resumes : []).filter((r) => r && r.id && (r.parsed_json === undefined || r.parsed_json))
    if (list.length === 0) return null
    const on = page || {}
    let best = null
    let bestFit = 0
    for (const r of [...list].sort(newestFirst)) {
      if (r.kind !== 'version') continue
      const fitScore = fit(r.target || r.target_json, on)
      if (fitScore > bestFit) { best = r; bestFit = fitScore }
    }
    const hasFile = opts && typeof opts.hasFile === 'function' ? opts.hasFile : null
    if (best && bestFit >= 2 && (!hasFile || hasFile(best.id))) return { resume: best, why: 'tailored' }
    if (hasFile) {
      const withFile = list.filter((r) => r.kind !== 'master' && hasFile(r.id))
      if (withFile.length === 1) return { resume: withFile[0], why: 'only' }
      if (withFile.length > 1) {
        const title = on.jobTitle || on.title
        // 1. The resumes whose direction is this job's: one → that one.
        const ofDirection = withFile.filter((r) => roleFit(r, title) >= DIRECTION_MATCH)
        if (ofDirection.length === 1) return { resume: ofDirection[0], why: 'direction' }
        // 2. Several (a role between two directions) or none: what the posting
        //    asks for decides among them; none matched is unsure.
        const pool = ofDirection.length ? ofDirection : withFile
        const ranked = pool
          .map((r) => ({ r, s: score(r, on) }))
          .sort((a, b) => b.s - a.s || Number(!!b.r.is_current) - Number(!!a.r.is_current) || newestFirst(a.r, b.r))
        const [top, next] = ranked
        return {
          resume: top.r, why: 'fits', score: top.s, composite: ofDirection.length > 1,
          unsure: ofDirection.length === 0 || top.s < UNSURE_BELOW || top.s - next.s < UNSURE_MARGIN,
        }
      }
    }
    const fallback = (why) => (hasFile ? { why: 'no_file', unsure: true } : { why })
    const current = list.find((r) => r.is_current)
    if (current) return { resume: current, ...fallback('current') }
    const master = list.find((r) => r.kind === 'master')
    if (master) return { resume: master, ...fallback('master') }
    return { resume: [...list].sort(newestFirst)[0], ...fallback('newest') }
  }

  /** Which resumes have their own file, from the files the Landed page handed
   *  over (resume id → { file | null }). Null until the page sends uploads'
   *  files (an entry for each, null when it has none): then callers keep the
   *  old order and the account's default file. */
  function fileKnowledge(resumes, stored) {
    const map = stored && typeof stored === 'object' ? stored : {}
    const known = (Array.isArray(resumes) ? resumes : []).some((r) => r && r.kind === 'source' && Object.prototype.hasOwnProperty.call(map, r.id))
    return known ? { hasFile: (id) => !!(map[id] && map[id].file) } : null
  }

  const api = { pickResumeForPage, fit, directions, roleFit, skillFit, fileKnowledge }
  global.LandedResumePick = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)
