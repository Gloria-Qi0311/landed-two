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
//   assist-open   "Open & autofill" on a lead or application: open its posting
//                 in a new tab and fill it with the resume version Landed
//                 picked; the tab remembers which application/lead it's for,
//                 so the "thanks for applying" page lands on that one
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

  function createBridgeHandler(deps) {
    const { cfg, snapshotStore, pushMod, storage, chromeLocal, withLock, onQueueChanged, version, openAndFill } = deps
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
          return { ok: true, data: { saved: !!answers } }
        }

        case 'assist-open': {
          const p = msg.payload || {}
          const url = postingUrl(p.url)
          if (!url) return { ok: false, error: 'not a link the extension can open' }
          if (typeof p.resume_id !== 'string' || !p.resume_id) return { ok: false, error: 'resume_id is required' }
          if (!openAndFill) return { ok: false, error: 'this browser cannot autofill' }
          return openAndFill({
            url,
            resume_id: p.resume_id.slice(0, 64),
            application_id: landedId(p.application_id),
            lead_id: landedId(p.lead_id),
          })
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
