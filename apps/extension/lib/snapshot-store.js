// Snapshot store — service-worker / content-script edition.
//
// Hand-mirrors packages/extension-core/src/snapshot-store.js because the
// MV3 service worker can't `import` from workspace packages without
// switching to module-type SW (out of scope for #34). The ESM version is
// the canonical source; vitest coverage lives alongside it.
//
// Loaded via `importScripts('lib/snapshot-store.js')` from background.js;
// registers on globalThis (= self in SW context) as
// `LandedSnapshotStore`. The same file is safe to importScripts from
// other contexts later.
(function () {
  'use strict'

  function snapshotKey(portal) {
    return 'landed:portal-snapshot:' + portal
  }

  const PENDING_KEY = 'landed:pending-portal-events'
  const emptySnapshot = () => ({ events: {}, last_updated: null })

  function eventsDiffer(a, b) {
    return (
      a.kind !== b.kind ||
      (a.company || '') !== (b.company || '') ||
      (a.role || '') !== (b.role || '') ||
      (a.applied_at || '') !== (b.applied_at || '')
    )
  }

  function diffEvents(snapshot, newEvents) {
    const snap = snapshot && snapshot.events ? snapshot : emptySnapshot()
    const newOnes = []
    const changed = []
    const unchanged = []
    for (const ev of (newEvents || [])) {
      if (!ev || typeof ev !== 'object' || !ev.app_url) continue
      const prev = snap.events[ev.app_url]
      if (!prev) newOnes.push(ev)
      else if (eventsDiffer(prev, ev)) changed.push(ev)
      else unchanged.push(ev)
    }
    return { newOnes, changed, unchanged }
  }

  function mergeSnapshot(snapshot, newEvents, now) {
    now = now || new Date()
    const snap = snapshot && snapshot.events ? snapshot : emptySnapshot()
    const merged = Object.assign({}, snap.events)
    for (const ev of (newEvents || [])) {
      if (!ev || !ev.app_url) continue
      merged[ev.app_url] = ev
    }
    return { events: merged, last_updated: now.toISOString() }
  }

  // Promise-wrapped chrome.storage.local accessors. The callback shape is
  // ancient; we adapt it to async/await once here.
  function chromeStorageAdapter(area) {
    return {
      async getItem(key) {
        return new Promise((resolve) => {
          area.get(key, (res) => resolve(res ? res[key] : null))
        })
      },
      async setItem(key, value) {
        return new Promise((resolve) => {
          area.set({ [key]: value }, () => resolve())
        })
      },
    }
  }

  async function loadSnapshot(storage, portal) {
    if (!storage) return emptySnapshot()
    const raw = await storage.getItem(snapshotKey(portal))
    if (!raw) return emptySnapshot()
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed && parsed.events && typeof parsed.events === 'object') return parsed
    } catch { /* malformed — restart */ }
    return emptySnapshot()
  }

  async function saveSnapshot(storage, portal, snapshot) {
    if (!storage) return
    await storage.setItem(snapshotKey(portal), JSON.stringify(snapshot))
  }

  async function loadPending(storage) {
    if (!storage) return { events: [], last_updated: null }
    const raw = await storage.getItem(PENDING_KEY)
    if (!raw) return { events: [], last_updated: null }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed && Array.isArray(parsed.events)) return parsed
    } catch { /* malformed — restart */ }
    return { events: [], last_updated: null }
  }

  async function savePending(storage, queue) {
    if (!storage) return
    await storage.setItem(PENDING_KEY, JSON.stringify(queue))
  }

  async function appendPending(storage, events, now) {
    if (!storage || !events || events.length === 0) return
    now = now || new Date()
    const queue = await loadPending(storage)
    const next = (queue.events || []).concat(events).slice(-500)
    await savePending(storage, { events: next, last_updated: now.toISOString() })
  }

  async function clearPending(storage, now) {
    now = now || new Date()
    await savePending(storage, { events: [], last_updated: now.toISOString() })
  }

  async function ingest(storage, portal, newEvents, now) {
    now = now || new Date()
    const snapshot = await loadSnapshot(storage, portal)
    const triage = diffEvents(snapshot, newEvents)
    const toStage = triage.newOnes.concat(triage.changed)
    if (toStage.length > 0) {
      await appendPending(storage, toStage, now)
      const nextSnapshot = mergeSnapshot(snapshot, toStage, now)
      await saveSnapshot(storage, portal, nextSnapshot)
    }
    return Object.assign({}, triage, { staged: toStage.length })
  }

  const api = {
    snapshotKey,
    PENDING_KEY,
    diffEvents,
    mergeSnapshot,
    loadSnapshot,
    saveSnapshot,
    loadPending,
    savePending,
    appendPending,
    clearPending,
    ingest,
    chromeStorageAdapter,
  }

  // SW context exposes `self`; content-script context exposes `window` +
  // `globalThis`. Cover both. Also expose CJS exports so jest specs can
  // `require()` (matches lib/auth.js / lib/config.js / lib/storage-adapter.js).
  if (typeof globalThis !== 'undefined') globalThis.LandedSnapshotStore = api
  else if (typeof self !== 'undefined') self.LandedSnapshotStore = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
