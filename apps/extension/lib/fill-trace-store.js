// lib/fill-trace-store.js — fill traces in the service worker. Each frame
// records what its fill did (lib/fill/trace.js); fillTab (background.js) adds
// them up into one trace per page with the page, the resume and the totals,
// under a short ref the popup shows. The last 20 stay in the extension; a
// Landed Cloud account's also go to the server (PUT /api/fill-traces/:ref),
// where the user's paired computer reads one by ref (`landed fill-trace
// <ref>`). The server refuses sync-off accounts' (requireCloud), so theirs
// stay here. packages/schema/src/fill-trace.ts is the shape; the server
// validates it again.

(function (global) {
  const KEY = 'landed:fill-traces'
  const KEEP = 20
  const RETRY = 3
  // Crockford base32 (no I, L, O, U): easy to read out and type.
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

  function newRef(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
    return Array.from(random(6), (b) => ALPHABET[b & 31]).join('')
  }

  const pageUrl = (url) => {
    try {
      const u = new URL(url)
      return u.origin + u.pathname
    } catch {
      return ''
    }
  }
  const count = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0)

  /** One page's trace from fillTab's result and its frames' traces. */
  function buildTrace({ ref, via, tab, resume, extension, result, frames, now = new Date() }) {
    return {
      v: 1,
      ref,
      at: now.toISOString(),
      via,
      page: { url: pageUrl(tab && tab.url), title: String((tab && tab.title) || '').slice(0, 200) },
      resume: { id: (resume && resume.id) || null, name: (resume && resume.name) || null },
      extension: String(extension || ''),
      result: {
        filled: count(result.filled),
        review: count(result.review),
        fields: count(result.fields),
        missing_files: Array.isArray(result.missing_files) ? result.missing_files : [],
        unanswered: count(result.unanswered),
        blocker: result.blocker || null,
        agent_review: result.agent_review || null,
      },
      outcome: null,
      frames: (frames || []).filter((f) => f && typeof f === 'object'),
    }
  }

  /**
   * deps: { storage: { getItem, setItem }, session: () => Promise<{ token } | null>,
   *         apiUrl, fetch }
   */
  function createFillTraceStore(deps) {
    let lock = Promise.resolve()
    const locked = (fn) => {
      const run = lock.then(fn)
      lock = run.catch(() => {})
      return run
    }
    const load = async () => {
      const list = await deps.storage.getItem(KEY)
      return Array.isArray(list) ? list : []
    }

    /** true: on the server; 'local': it refused (sync off), don't retry. */
    async function upload(trace) {
      const session = await deps.session()
      if (!session || !session.token) return false
      try {
        const res = await deps.fetch(`${deps.apiUrl}/api/fill-traces/${trace.ref}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(trace),
        })
        if (res.ok) return true
        return res.status === 400 || res.status === 403 || res.status === 409 ? 'local' : false
      } catch {
        return false
      }
    }

    /** Upload the ones that haven't gone up yet (a few at a time), outside
     *  the lock: a slow server never holds up the next fill. */
    async function flush() {
      const pending = await locked(async () => (await load()).filter((e) => e && e.uploaded === false).slice(0, RETRY).map((e) => e.trace))
      if (pending.length === 0) return
      const sent = await Promise.all(pending.map(async (trace) => ({ trace, uploaded: await upload(trace) })))
      await locked(async () => {
        const list = await load()
        for (const { trace, uploaded } of sent) {
          const entry = list.find((e) => e && e.trace && e.trace.ref === trace.ref)
          // Changed since (an outcome came in): its own flush sends the new one.
          if (entry && JSON.stringify(entry.trace) === JSON.stringify(trace)) entry.uploaded = uploaded
        }
        await deps.storage.setItem(KEY, list)
      })
    }

    /** Keep it here, newest first. Resolves once it's kept; `uploading`
     *  settles when the upload has been tried. */
    async function save(trace) {
      await locked(async () => {
        const list = [{ trace, uploaded: false }, ...(await load()).filter((e) => e && e.trace && e.trace.ref !== trace.ref)].slice(0, KEEP)
        await deps.storage.setItem(KEY, list)
      })
      return { uploading: flush().catch(() => {}) }
    }

    /** What happened after the fill (a Landed-opened tab): ready, blocked,
     *  submitted or error. */
    async function setOutcome(ref, outcome, now = new Date()) {
      const found = await locked(async () => {
        const list = await load()
        const entry = list.find((e) => e && e.trace && e.trace.ref === ref)
        if (!entry) return false
        entry.trace.outcome = { status: outcome.status, blocker: outcome.blocker || null, at: now.toISOString() }
        if (entry.uploaded !== 'local') entry.uploaded = false
        await deps.storage.setItem(KEY, list)
        return true
      })
      return { found, uploading: found ? flush().catch(() => {}) : Promise.resolve() }
    }

    async function get(ref) {
      const entry = (await load()).find((e) => e && e.trace && e.trace.ref === ref)
      return entry ? entry.trace : null
    }

    return { save, setOutcome, get }
  }

  const api = { KEY, KEEP, newRef, buildTrace, createFillTraceStore }
  global.LandedFillTraces = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)
