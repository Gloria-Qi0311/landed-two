// Tests for snapshot-store: diff + merge + storage-adapter contract.
//
// Drives the same code path the extension service worker / content
// script will use at runtime, via an in-memory storage adapter that
// matches the chrome.storage.local promise shape.
import { describe, test, expect, beforeEach } from 'vitest'
import {
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
} from '../src/snapshot-store.js'

function memoryStorage() {
  const data = new Map()
  return {
    data,
    async getItem(key) { return data.has(key) ? data.get(key) : null },
    async setItem(key, value) { data.set(key, value) },
  }
}

const ev = (overrides = {}) => ({
  kind: 'applied',
  company: 'Acme',
  role: 'Engineer',
  applied_at: '2026-05-17T12:00:00.000Z',
  app_url: 'https://boards.greenhouse.io/acme/applications/abc-123',
  detected_via: 'url',
  ...overrides,
})

describe('snapshotKey', () => {
  test('namespaces per portal', () => {
    expect(snapshotKey('greenhouse')).toBe('landed:portal-snapshot:greenhouse')
    expect(snapshotKey('lever')).toBe('landed:portal-snapshot:lever')
  })
})

describe('diffEvents', () => {
  test('marks first sighting as new', () => {
    const snap = { events: {}, last_updated: null }
    const result = diffEvents(snap, [ev()])
    expect(result.newOnes).toHaveLength(1)
    expect(result.changed).toHaveLength(0)
    expect(result.unchanged).toHaveLength(0)
  })

  test('marks second sighting of identical event as unchanged', () => {
    const e = ev()
    const snap = { events: { [e.app_url]: e }, last_updated: '...' }
    const result = diffEvents(snap, [e])
    expect(result.unchanged).toHaveLength(1)
    expect(result.newOnes).toHaveLength(0)
  })

  test('marks event with same app_url but different kind as changed', () => {
    const prev = ev({ kind: 'applied' })
    const next = ev({ kind: 'already_applied' })
    const snap = { events: { [prev.app_url]: prev }, last_updated: '...' }
    const result = diffEvents(snap, [next])
    expect(result.changed).toEqual([next])
  })

  test('marks event with different company as changed', () => {
    const prev = ev({ company: 'Acme' })
    const next = ev({ company: 'Beta' })
    const snap = { events: { [prev.app_url]: prev }, last_updated: '...' }
    expect(diffEvents(snap, [next]).changed).toEqual([next])
  })

  test('drops events without app_url (can`t dedupe reliably)', () => {
    const snap = { events: {}, last_updated: null }
    const result = diffEvents(snap, [
      ev({ app_url: '' }),
      ev({ app_url: undefined }),
      ev({ app_url: null }),
      ev(),
    ])
    expect(result.newOnes).toHaveLength(1)
  })

  test('tolerates null / undefined / malformed inputs', () => {
    expect(diffEvents(null, [ev()]).newOnes).toHaveLength(1)
    expect(diffEvents({}, [ev()]).newOnes).toHaveLength(1)
    expect(diffEvents({ events: {} }, null).newOnes).toHaveLength(0)
    expect(diffEvents({ events: {} }, [null, undefined, 'oops', 42]).newOnes).toHaveLength(0)
  })

  test('partitions a mixed batch correctly', () => {
    const a = ev({ app_url: 'https://a/applications/1' })
    const b = ev({ app_url: 'https://b/applications/2', company: 'Beta' })
    const snap = { events: { [a.app_url]: a }, last_updated: '...' }
    const result = diffEvents(snap, [
      a,                                        // unchanged
      { ...a, kind: 'already_applied' },        // changed
      b,                                        // new
    ])
    expect(result.unchanged).toHaveLength(1)
    expect(result.changed).toHaveLength(1)
    expect(result.newOnes).toHaveLength(1)
  })
})

describe('mergeSnapshot', () => {
  test('writes new events into the snapshot', () => {
    const merged = mergeSnapshot(null, [ev()], new Date('2026-05-17T12:00:00Z'))
    expect(Object.keys(merged.events)).toHaveLength(1)
    expect(merged.last_updated).toBe('2026-05-17T12:00:00.000Z')
  })

  test('newer event wins for an existing app_url', () => {
    const prev = ev({ kind: 'applied' })
    const snap = { events: { [prev.app_url]: prev }, last_updated: 'x' }
    const next = ev({ kind: 'already_applied' })
    const merged = mergeSnapshot(snap, [next], new Date('2026-05-17T13:00:00Z'))
    expect(merged.events[next.app_url].kind).toBe('already_applied')
  })

  test('ignores events without app_url', () => {
    const merged = mergeSnapshot({ events: {}, last_updated: null }, [
      ev({ app_url: '' }),
      ev(),
    ])
    expect(Object.keys(merged.events)).toHaveLength(1)
  })
})

describe('storage round-trip', () => {
  let storage
  beforeEach(() => { storage = memoryStorage() })

  test('loadSnapshot returns empty for unknown portal', async () => {
    const snap = await loadSnapshot(storage, 'greenhouse')
    expect(snap).toEqual({ events: {}, last_updated: null })
  })

  test('saveSnapshot + loadSnapshot round-trip', async () => {
    const e = ev()
    await saveSnapshot(storage, 'greenhouse', { events: { [e.app_url]: e }, last_updated: 'x' })
    const round = await loadSnapshot(storage, 'greenhouse')
    expect(round.events[e.app_url]).toEqual(e)
  })

  test('loadSnapshot recovers from malformed JSON', async () => {
    await storage.setItem(snapshotKey('greenhouse'), '{not valid')
    const snap = await loadSnapshot(storage, 'greenhouse')
    expect(snap).toEqual({ events: {}, last_updated: null })
  })

  test('loadSnapshot handles already-parsed object (chrome.storage.local quirk)', async () => {
    const e = ev()
    storage.data.set(snapshotKey('greenhouse'), { events: { [e.app_url]: e }, last_updated: 'x' })
    const snap = await loadSnapshot(storage, 'greenhouse')
    expect(snap.events[e.app_url]).toEqual(e)
  })

  test('appendPending grows the queue + clearPending wipes it', async () => {
    await appendPending(storage, [ev()])
    let q = await loadPending(storage)
    expect(q.events).toHaveLength(1)

    await appendPending(storage, [ev({ app_url: 'https://b/applications/2' })])
    q = await loadPending(storage)
    expect(q.events).toHaveLength(2)

    await clearPending(storage)
    q = await loadPending(storage)
    expect(q.events).toEqual([])
  })

  test('appendPending caps the queue at 500 (preserves newest)', async () => {
    const events = Array.from({ length: 510 }, (_, i) => ev({ app_url: `https://x/applications/${i}` }))
    await appendPending(storage, events)
    const q = await loadPending(storage)
    expect(q.events).toHaveLength(500)
    expect(q.events[0].app_url).toBe('https://x/applications/10')
    expect(q.events[499].app_url).toBe('https://x/applications/509')
  })

  test('appendPending is a no-op on empty array', async () => {
    await appendPending(storage, [])
    const q = await loadPending(storage)
    expect(q.events).toEqual([])
    expect(q.last_updated).toBeNull()
  })

  test('PENDING_KEY is stable', () => {
    expect(PENDING_KEY).toBe('landed:pending-portal-events')
  })
})

describe('ingest (high-level orchestration)', () => {
  let storage
  beforeEach(() => { storage = memoryStorage() })

  test('first-time ingest stages all events + writes snapshot', async () => {
    const result = await ingest(storage, 'greenhouse', [ev()])
    expect(result.staged).toBe(1)
    const queue = await loadPending(storage)
    expect(queue.events).toHaveLength(1)
    const snap = await loadSnapshot(storage, 'greenhouse')
    expect(Object.keys(snap.events)).toHaveLength(1)
  })

  test('re-ingesting the same event does not duplicate', async () => {
    const e = ev()
    await ingest(storage, 'greenhouse', [e])
    await ingest(storage, 'greenhouse', [e])
    await ingest(storage, 'greenhouse', [e])
    const queue = await loadPending(storage)
    expect(queue.events).toHaveLength(1)
  })

  test('a changed kind triggers a re-stage', async () => {
    const a = ev({ kind: 'applied' })
    await ingest(storage, 'greenhouse', [a])
    const b = { ...a, kind: 'already_applied' }
    await ingest(storage, 'greenhouse', [b])
    const queue = await loadPending(storage)
    expect(queue.events).toHaveLength(2)
    expect(queue.events[1].kind).toBe('already_applied')
  })

  test('a mixed batch (new + unchanged + changed) is correctly partitioned', async () => {
    const a = ev({ app_url: 'https://x/applications/1' })
    const b = ev({ app_url: 'https://x/applications/2' })
    await ingest(storage, 'greenhouse', [a])

    const c = ev({ app_url: 'https://x/applications/3' })
    const result = await ingest(storage, 'greenhouse', [
      a,                              // unchanged
      { ...b, kind: 'already_applied' }, // new (b had no prior entry)
      c,                              // new
    ])
    expect(result.staged).toBe(2)
    expect(result.newOnes).toHaveLength(2)
    expect(result.unchanged).toHaveLength(1)
    const queue = await loadPending(storage)
    expect(queue.events).toHaveLength(3)  // 1 original + 2 newly staged
  })
})
