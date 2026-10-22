// lib/bridge-handler.js — service-worker side of the Landed web ↔ extension
// bridge.
//
// Landed is local-first: without a Cloud account the extension can't push
// portal events to a server, and the web app's data lives in the page's
// IndexedDB, which the extension can't read. So the open Landed tab and the
// extension trade data directly:
//
//   take-events   page pulls the pending portal-event queue (as rows) and
//                 writes them to whichever store it uses; the queue is
//                 cleared in the same locked step so nothing is delivered twice
//   sync-resumes  page hands over its resumes so the side panel can autofill
//   sync-answers  page hands over the application answers (Extension page) so
//                 fills can answer choice questions; null clears them
//   file-ids      which resume / cover letter file (by id) the extension has
//   sync-file     page hands over one of them (base64, ≤ 3 MB); null removes it
//   assist-open   "Open & autofill" on a lead or application: open its posting
//                 in a new tab and fill it with the resume version Landed
//                 picked; the tab remembers which application/lead it's for,
//                 so the "thanks for applying" page lands on that one. Only
//                 a linked application + lead may carry submit authorization.
//   take-assist-results  fill-ready / human-blocker results, delivered once
//   pick-resume   which of several resumes fits a job, when Landed's rules
//                 can't tell: the posting and each candidate's directions,
//                 job titles and skills (no contact details) go to the user's
//                 own agent through Landed for Mac; it names one or nothing
//   classify-statuses  what an imported spreadsheet's statuses mean: only the
//                 status words go to the user's own agent through Landed for Mac
//   hello         presence + version check
//
// Requests arrive from lib/web-bridge.js (a content script injected only on
// Landed's own origins); the sender origin is re-checked here against
// LandedConfig.WEB_ORIGINS.
//
// Loaded by background.js via importScripts; required directly by Jest.

(function (global) {
  /** Serializes async sections that read-modify-write the pending queue
   *  (ingest, Cloud push, bridge take) so none of them clobbers another. */
  function createQueueLock() {
    let tail = Promise.resolve()
    return function withLock(fn) {
      const run = tail.then(fn, fn)
      tail = run.catch(() => {})
      return run
    }
  }

  function senderOrigin(sender) {
    if (!sender) return null
    if (sender.origin) return sender.origin
    try { return new URL(sender.url).origin } catch { return null }
  }

  const LANDED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const landedId = (v) => (typeof v === 'string' && LANDED_ID.test(v) ? v : null)

  /** A link the extension may open: http(s) only, no credentials. */
  function postingUrl(v) {
    if (typeof v !== 'string' || v.length > 2000) return null
    try {
      const u = new URL(v)
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : null
    } catch { return null }
  }

  /** Application answers as the page sent them, bounded: flat strings,
   *  booleans and nulls, up to three locations and forty other questions.
   *  The content script validates again before using any of it. */
  function sanitizeAnswers(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out = {}
    for (const [key, value] of Object.entries(raw).slice(0, 80)) {
      if (!/^[a-z0-9_]{1,40}$/.test(key)) continue
      if (typeof value === 'string') out[key] = value.slice(0, 500)
      else if (value === null || typeof value === 'boolean') out[key] = value
    }
    out.preferred_locations = (Array.isArray(raw.preferred_locations) ? raw.preferred_locations : [])
      .filter((l) => typeof l === 'string').slice(0, 3).map((l) => l.slice(0, 100))
    out.custom = (Array.isArray(raw.custom) ? raw.custom : [])
      .filter((c) => c && typeof c.question === 'string' && typeof c.answer === 'string')
      .slice(0, 40).map((c) => ({ question: c.question.slice(0, 300), answer: c.answer.slice(0, 500) }))
    return out
  }

  const FILE_KINDS = ['resume', 'cover_letter']
  const MAX_FILE_BASE64 = Math.ceil((3 * 1024 * 1024) / 3) * 4

  /** One file as the page sent it: a known kind's id, a .pdf/.doc/.docx
   *  name, base64 within the size limit. */
  function sanitizeFile(raw) {
    if (!raw || typeof raw !== 'object') return null
    const name = typeof raw.name === 'string' ? raw.name.slice(0, 120) : ''
    const data = typeof raw.data === 'string' ? raw.data : ''
    if (typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id)) return null
    if (!/\.(pdf|docx?)$/i.test(name)) return null
    if (!data || data.length > MAX_FILE_BASE64 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
    const mime = typeof raw.mime === 'string' && raw.mime.length < 120 ? raw.mime : 'application/octet-stream'
    return { id: raw.id, name, mime, data }
  }

  function readLocal(chromeLocal, key) {
    return new Promise((resolve) => {
      try {
        const out = chromeLocal.get(key, (value) => resolve(value || {}))
        if (out && typeof out.then === 'function') out.then((value) => resolve(value || {}), () => resolve({}))
      } catch {
        resolve({})
      }
    })
  }

  function sanitizeTarget(raw) {
    if (!raw || typeof raw !== 'object') return null
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
    const role = text(raw.role, 200)
    return role ? { role, company: text(raw.company, 120), job_url: text(raw.job_url, 2000), application_id: text(raw.application_id, 64) } : null
  }

  /** A pick-resume request as the host takes it: short, plain text only. */
  function sanitizePick(raw) {
    if (!raw || typeof raw !== 'object') return null
    const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
    const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => text(x, max)).filter(Boolean).slice(0, n)
    const job = raw.job && typeof raw.job === 'object' ? raw.job : {}
    const role = text(job.role, 200)
    const resumes = (Array.isArray(raw.resumes) ? raw.resumes : []).slice(0, 6).flatMap((r) => {
      const id = r && text(r.id, 64)
      return id ? [{ id, directions: list(r.directions, 6, 80), titles: list(r.titles, 6, 120), skills: list(r.skills, 30, 60) }] : []
    })
    if (!role || resumes.length < 2) return null
    return { type: 'pick_resume', job: { role, company: text(job.company, 120), description: text(job.description, 6000) }, resumes }
  }

  /** A write that may not fit (resume files are big): what went wrong, in
   *  words the page can show, instead of dropping the file silently. */
  async function keep(write) {
    try {
      await write()
      return null
    } catch (e) {
      const why = String((e && e.message) || e || 'the browser said no')
      return /quota/i.test(why) ? "the extension's storage is full" : why.slice(0, 200)
    }
  }

  function createBridgeHandler(deps) {
    const { cfg, snapshotStore, pushMod, storage, chromeLocal, withLock, onQueueChanged, version, openAndFill, takeAssistResults, onAnswersSynced, pickResume, classifyStatuses } = deps
    const allowed = new Set(cfg.WEB_ORIGINS)

    return async function handle(msg, sender) {
      if (!allowed.has(senderOrigin(sender))) return { ok: false, error: 'origin not allowed' }
      switch (msg && msg.type) {
        case 'hello':
          return { ok: true, data: { version } }

        case 'take-events': {
          const rows = await withLock(async () => {
            const queue = await snapshotStore.loadPending(storage)
            const events = (queue && queue.events) || []
            if (events.length === 0) return []
            await snapshotStore.clearPending(storage)
            return events
              .map((ev) => pushMod.mapEventToRow(ev, 'local'))
              .filter(Boolean)
              .map(({ user_id: _ignored, ...row }) => row)
          })
          if (rows.length > 0 && onQueueChanged) onQueueChanged()
          return { ok: true, data: { rows } }
        }

        case 'sync-resumes': {
          const list = msg.payload && msg.payload.resumes
          if (!Array.isArray(list)) return { ok: false, error: 'resumes must be an array' }
          const resumes = list
            .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string')
            .slice(0, 50)
            .map((r) => ({
              id: r.id,
              name: r.name,
              parsed_json: r.parsed_json == null ? null : r.parsed_json,
              is_current: !!r.is_current,
              created_at: typeof r.created_at === 'string' ? r.created_at : '',
              // What a tailored version is for, so a fill can pick it
              // for that job (lib/resume-pick.js).
              kind: ['source', 'master', 'version'].includes(r.kind) ? r.kind : 'source',
              target: sanitizeTarget(r.target),
            }))
          await chromeLocal.set({
            [cfg.LOCAL_RESUMES_KEY]: { resumes, synced_at: new Date().toISOString() },
          })
          return { ok: true, data: { count: resumes.length } }
        }

        case 'sync-answers': {
          const answers = msg.payload ? sanitizeAnswers(msg.payload.answers) : null
          await chromeLocal.set({
            [cfg.LOCAL_ANSWERS_KEY || 'landed:application-answers']: { answers, synced_at: new Date().toISOString() },
          })
          // Pages still open may have fields these answers now cover.
          if (answers && onAnswersSynced) onAnswersSynced()
          return { ok: true, data: { saved: !!answers } }
        }

        // Questions fills had to leave empty (lib/fill/unanswered.js), taken
        // once: the Landed tab keeps them with the answers.
        case 'take-questions': {
          const key = cfg.LOCAL_QUESTIONS_KEY || 'landed:unanswered-questions'
          const questions = await withLock(async () => {
            const queued = (await readLocal(chromeLocal, key))[key]
            if (!Array.isArray(queued) || queued.length === 0) return []
            await chromeLocal.set({ [key]: [] })
            return queued
          })
          return { ok: true, data: { questions } }
        }

        case 'file-ids': {
          const key = cfg.LOCAL_FILES_KEY || 'landed:application-files'
          const stored = (await readLocal(chromeLocal, key))[key] || {}
          const ids = {}
          for (const kind of FILE_KINDS) ids[kind] = stored[kind] && stored[kind].id ? stored[kind].id : null
          return { ok: true, data: ids }
        }

        case 'sync-file': {
          const p = msg.payload || {}
          if (!FILE_KINDS.includes(p.kind)) return { ok: false, error: 'unknown file kind' }
          const file = p.file === null ? null : sanitizeFile(p.file)
          if (p.file !== null && !file) return { ok: false, error: 'not a file the extension can upload' }
          const key = cfg.LOCAL_FILES_KEY || 'landed:application-files'
          const failed = await keep(() => withLock(async () => {
            const stored = (await readLocal(chromeLocal, key))[key] || {}
            await chromeLocal.set({ [key]: { ...stored, [p.kind]: file } })
          }))
          if (failed) return { ok: false, error: `Couldn't keep the file: ${failed}` }
          return { ok: true, data: { kind: p.kind, saved: !!file } }
        }

        // Tailored versions' one-page PDFs (apps/web/src/lib/resume-pdf.ts):
        // which ones the extension has, and one at a time in or out. A
        // version that can't have one (too long, CJK text) is kept as null,
        // so the page doesn't make it again until the version changes.
        case 'version-pdf-ids': {
          const key = cfg.LOCAL_VERSION_PDFS_KEY || 'landed:version-pdfs'
          const stored = (await readLocal(chromeLocal, key))[key] || {}
          const ids = {}
          for (const [id, entry] of Object.entries(stored)) if (entry && typeof entry.hash === 'string') ids[id] = entry.hash
          return { ok: true, data: ids }
        }

        case 'sync-version-pdf': {
          const p = msg.payload || {}
          const id = landedId(p.resume_id)
          if (!id) return { ok: false, error: 'resume_id must be a Landed id' }
          const key = cfg.LOCAL_VERSION_PDFS_KEY || 'landed:version-pdfs'
          if (p.remove === true) {
            await withLock(async () => {
              const stored = (await readLocal(chromeLocal, key))[key] || {}
              delete stored[id]
              await chromeLocal.set({ [key]: stored })
            })
            return { ok: true, data: { removed: true } }
          }
          const hash = typeof p.hash === 'string' && /^[0-9a-f]{16,64}$/.test(p.hash) ? p.hash : null
          if (!hash) return { ok: false, error: 'hash is required' }
          const file = p.file === null ? null : sanitizeFile(p.file)
          // A version's one-page PDF, or an uploaded resume's own file (PDF or Word).
          if (p.file !== null && (!file || !/\.(pdf|docx?)$/i.test(file.name))) return { ok: false, error: 'not a resume file the extension can upload' }
          // The manifest asks for unlimitedStorage (Chrome caps storage.local at
          // 10 MB without it; a few resumes' files are more), and a write that
          // still fails says so.
          const failed = await keep(() => withLock(async () => {
            const stored = (await readLocal(chromeLocal, key))[key] || {}
            stored[id] = { hash, file, synced_at: new Date().toISOString() }
            // The newest 40 resumes' files are plenty for the jobs in flight.
            const newest = Object.entries(stored).sort((a, b) => String(b[1].synced_at).localeCompare(String(a[1].synced_at))).slice(0, 40)
            await chromeLocal.set({ [key]: Object.fromEntries(newest) })
          }))
          if (failed) return { ok: false, error: `Couldn't keep this resume's file: ${failed}` }
          return { ok: true, data: { saved: !!file } }
        }

        case 'assist-open': {
          const p = msg.payload || {}
          const url = postingUrl(p.url)
          if (!url) return { ok: false, error: 'not a link the extension can open' }
          if (typeof p.resume_id !== 'string' || !p.resume_id) return { ok: false, error: 'resume_id is required' }
          if (!openAndFill) return { ok: false, error: 'this browser cannot autofill' }
          const applicationId = landedId(p.application_id)
          const leadId = landedId(p.lead_id)
          return openAndFill({
            url,
            resume_id: p.resume_id.slice(0, 64),
            application_id: applicationId,
            lead_id: leadId,
            // The web app sets this only for a lead the user approved. The
            // bridge refuses to forward it without both linked Landed ids,
            // so manual Open & autofill can never inherit submit permission.
            submit_authorized: p.submit_authorized === true && !!applicationId && !!leadId,
          })
        }

        case 'take-assist-results': {
          const results = takeAssistResults ? await takeAssistResults() : []
          return { ok: true, data: { results: Array.isArray(results) ? results.slice(0, 50) : [] } }
        }

        case 'pick-resume': {
          const request = sanitizePick(msg.payload)
          if (!request) return { ok: false, error: 'a job and at least two resumes are required' }
          if (!pickResume) return { ok: false, error: 'this browser cannot ask your agent' }
          const res = await pickResume(request)
          if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'your agent did not answer' }
          const pick = res.pick && request.resumes.some((r) => r.id === res.pick.resume_id) ? res.pick : null
          return { ok: true, data: { pick, model: typeof res.model === 'string' ? res.model : null } }
        }

        case 'classify-statuses': {
          const statuses = [...new Set((Array.isArray(msg.payload?.statuses) ? msg.payload.statuses : [])
            .map((t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 80) : ''))
            .filter(Boolean))].slice(0, 40)
          if (statuses.length === 0) return { ok: false, error: 'no statuses' }
          if (!classifyStatuses) return { ok: false, error: 'this browser cannot ask your agent' }
          const res = await classifyStatuses({ type: 'classify_statuses', statuses })
          if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'your agent did not answer' }
          const stages = res.stages && typeof res.stages === 'object' ? res.stages : {}
          return { ok: true, data: { stages: Object.fromEntries(statuses.filter((t) => stages[t]).map((t) => [t, stages[t]])), model: typeof res.model === 'string' ? res.model : null } }
        }

        default:
          return { ok: false, error: 'unknown bridge request' }
      }
    }
  }

  global.LandedBridge = { createQueueLock, createBridgeHandler }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedBridge
  }
})(typeof self !== 'undefined' ? self : globalThis)
