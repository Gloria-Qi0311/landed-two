// Snapshot store + diff for portal-event detection.
//
// Purpose: portal parsers (#33 — Greenhouse so far) emit raw events every
// time content.js / the service-worker poller sees a relevant page. We
// don't want to push duplicate events to Landed every time the user
// revisits the same confirmation URL. This module:
//
//   1. Models a per-portal snapshot keyed by `app_url`  (one event per
//      job URL — both 'applied' and 'already_applied' use it as the
//      stable identity).
//   2. Diffs new events against the stored snapshot → tags each as
//      `new` / `changed` / `unchanged`.
//   3. Stages `new` + `changed` events in a per-extension pending queue
//      that #35 will drain to Supabase `portal_events`.
//
// Pure logic — no `chrome.*` reads or writes. Callers pass the storage
// adapter (the same async getItem/setItem shape Supabase auth uses) so
// the module is vitest-testable in jsdom.
//
// Event shape (from packages/extension-core/src/portal-parsers/greenhouse.js):
//   {
//     kind: 'applied' | 'already_applied' | 'status-change' | 'rejection',
//     company: string,
//     role: string,
//     applied_at?: string,   // ISO timestamp on 'applied'
//     app_url: string,       // stable identity — must be unique per job
//     detected_via?: string,
//   }

/** chrome.storage.local key for the per-portal snapshot.
 *  Snapshot shape: { events: { [app_url]: Event }, last_updated: string }. */
export function snapshotKey(portal) {
  return `landed:portal-snapshot:${portal}`
}

/** chrome.storage.local key for the cross-portal pending-events queue.
 *  Shape: { events: Event[], last_updated: string }. */
export const PENDING_KEY = 'landed:pending-portal-events'

const emptySnapshot = () => ({ events: {}, last_updated: null })

/** Compare each new event against the stored snapshot. Returns a triage.
 *  Stable identity = `app_url`. An event is:
 *    - `new` if its app_url isn't in the snapshot
 *    - `changed` if it is, but kind/role/company/applied_at differs
 *    - `unchanged` otherwise
 *
 *  `app_url` is required + non-empty; events without one are dropped
 *  (they can't be deduped reliably).
 *
 *  @param {{ events: Record<string, object>, last_updated: string|null }} snapshot
 *  @param {object[]} newEvents
 *  @returns {{ newOnes: object[], changed: object[], unchanged: object[] }}
 */
export function diffEvents(snapshot, newEvents) {
  const snap = snapshot && snapshot.events ? snapshot : emptySnapshot()
  const newOnes = []
  const changed = []
  const unchanged = []
  for (const ev of (newEvents || [])) {
    if (!ev || typeof ev !== 'object' || !ev.app_url) continue
    const prev = snap.events[ev.app_url]
    if (!prev) {
      newOnes.push(ev)
    } else if (eventsDiffer(prev, ev)) {
      changed.push(ev)
    } else {
      unchanged.push(ev)
    }
  }
  return { newOnes, changed, unchanged }
}

function eventsDiffer(a, b) {
  return (
    a.kind !== b.kind ||
    (a.company || '') !== (b.company || '') ||
    (a.role || '') !== (b.role || '') ||
    (a.applied_at || '') !== (b.applied_at || '')
  )
}

/** Fold the diff result back into a fresh snapshot. Newest event wins per
 *  app_url. last_updated tracks when this merge happened. */
export function mergeSnapshot(snapshot, newEvents, now = new Date()) {
  const snap = snapshot && snapshot.events ? snapshot : emptySnapshot()
  const merged = { ...snap.events }
  for (const ev of (newEvents || [])) {
    if (!ev || !ev.app_url) continue
    merged[ev.app_url] = ev
  }
  return { events: merged, last_updated: now.toISOString() }
}

// ── Storage adapter contract ──────────────────────────────────────────────
//
// All read/write helpers take a `storage` adapter matching the shape
// Supabase auth uses (apps/extension/lib/storage-adapter.js):
//   getItem(key): Promise<string|null>
//   setItem(key, value): Promise<void>
//
// chrome.storage.local stores JSON-serializable objects natively; the
// adapter pattern here keeps tests + the real runtime on the same code
// path. Real-runtime values arrive as strings (JSON-parsed inside).

export async function loadSnapshot(storage, portal) {
  if (!storage) return emptySnapshot()
  const raw = await storage.getItem(snapshotKey(portal))
  if (!raw) return emptySnapshot()
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed && parsed.events && typeof parsed.events === 'object') return parsed
  } catch { /* malformed snapshot — start fresh */ }
  return emptySnapshot()
}

export async function saveSnapshot(storage, portal, snapshot) {
  if (!storage) return
  await storage.setItem(snapshotKey(portal), JSON.stringify(snapshot))
}

export async function loadPending(storage) {
  if (!storage) return { events: [], last_updated: null }
  const raw = await storage.getItem(PENDING_KEY)
  if (!raw) return { events: [], last_updated: null }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed && Array.isArray(parsed.events)) return parsed
  } catch { /* malformed — start fresh */ }
  return { events: [], last_updated: null }
}

export async function savePending(storage, queue) {
  if (!storage) return
  await storage.setItem(PENDING_KEY, JSON.stringify(queue))
}

/** Append events to the pending queue (cap at 500 to bound storage). */
export async function appendPending(storage, events, now = new Date()) {
  if (!storage || !events || events.length === 0) return
  const queue = await loadPending(storage)
  const next = (queue.events || []).concat(events).slice(-500)
  await savePending(storage, { events: next, last_updated: now.toISOString() })
}

/** Drop everything from the pending queue (called by #35 after push). */
export async function clearPending(storage, now = new Date()) {
  await savePending(storage, { events: [], last_updated: now.toISOString() })
}

// ── High-level convenience: one-call diff + merge + stage ─────────────────
//
// The orchestrator path: parser returns N events for a portal → call this
// helper → snapshot updates, new/changed events land in the pending queue,
// `last_updated` timestamps roll forward, all in one go.

export async function ingest(storage, portal, newEvents, now = new Date()) {
  const snapshot = await loadSnapshot(storage, portal)
  const triage = diffEvents(snapshot, newEvents)
  const toStage = [...triage.newOnes, ...triage.changed]
  if (toStage.length > 0) {
    await appendPending(storage, toStage, now)
    const nextSnapshot = mergeSnapshot(snapshot, toStage, now)
    await saveSnapshot(storage, portal, nextSnapshot)
  }
  return { ...triage, staged: toStage.length }
}
