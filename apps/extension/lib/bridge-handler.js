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

  function createBridgeHandler(deps) {
    const { cfg, snapshotStore, pushMod, storage, chromeLocal, withLock, onQueueChanged, version } = deps
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
