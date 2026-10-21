// lib/fill-trace-store.js: refs, one trace per page, the last 20 kept in the
// extension, Cloud accounts' uploaded (a sync-off account's stay local), the
// outcome added later, and a slow server never holding up the next fill.

const { KEEP, newRef, buildTrace, createFillTraceStore } = require('../lib/fill-trace-store.js')

function memoryStorage() {
  const data = {}
  return { data, getItem: async (k) => data[k] ?? null, setItem: async (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) } }
}

const trace = (ref, extra = {}) => buildTrace({
  ref, via: 'popup', extension: '2.8',
  tab: { url: 'https://job-boards.example.com/acme/jobs/1?gh_src=abc', title: 'Product Analyst — Acme' },
  resume: { id: 'r1', name: 'Alex Chen resume' },
  result: { filled: 2, review: 1, fields: 3, missing_files: [], unanswered: 0, blocker: null, agent_review: null },
  frames: [{ url: 'https://job-boards.example.com/acme/jobs/1', top: true, fields: [] }, null],
  now: new Date('2026-10-21T20:03:00Z'),
  ...extra,
})

function setup({ session = { token: 'tok' }, respond = () => ({ ok: true, status: 204 }) } = {}) {
  const storage = memoryStorage()
  const calls = []
  const store = createFillTraceStore({
    storage,
    session: async () => session,
    apiUrl: 'https://landed.example.com',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      return respond(url, init)
    },
  })
  const kept = () => storage.data['landed:fill-traces'] || []
  return { store, calls, kept }
}

test('refs are six readable characters', () => {
  expect(newRef()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
  expect(newRef(() => new Uint8Array([0, 1, 31, 32, 255, 10]))).toBe('01Z0ZA')
})

test("a page's trace: the page without its query, the resume, the totals, its frames", () => {
  const t = trace('K7Q2MX')
  expect(t).toMatchObject({ v: 1, ref: 'K7Q2MX', via: 'popup', at: '2026-10-21T20:03:00.000Z', outcome: null })
  expect(t.page).toEqual({ url: 'https://job-boards.example.com/acme/jobs/1', title: 'Product Analyst — Acme' })
  expect(t.resume).toEqual({ id: 'r1', name: 'Alex Chen resume' })
  expect(t.frames).toHaveLength(1)
})

test('kept newest first, at most 20, and uploaded with the Cloud session', async () => {
  const { store, calls, kept } = setup()
  for (let i = 0; i < KEEP + 2; i++) await (await store.save(trace(`AAAA${String(i).padStart(2, '0')}`))).uploading
  expect(kept()).toHaveLength(KEEP)
  expect(kept()[0].trace.ref).toBe('AAAA21')
  expect(kept().every((e) => e.uploaded === true)).toBe(true)
  expect(calls[0]).toMatchObject({ url: 'https://landed.example.com/api/fill-traces/AAAA00', init: { method: 'PUT', headers: { Authorization: 'Bearer tok' } } })
  expect(await store.get('AAAA21')).toMatchObject({ ref: 'AAAA21' })
  expect(await store.get('AAAA00')).toBeNull()
})

test("signed out: kept here and uploaded with a later one once signed in", async () => {
  let session = null
  const storage = memoryStorage()
  const calls = []
  const store = createFillTraceStore({
    storage, session: async () => session, apiUrl: 'https://landed.example.com',
    fetch: async (url) => { calls.push(url); return { ok: true, status: 204 } },
  })
  await (await store.save(trace('AAAAA1'))).uploading
  expect(calls).toEqual([])
  expect(storage.data['landed:fill-traces'][0].uploaded).toBe(false)
  session = { token: 'tok' }
  await (await store.save(trace('AAAAA2'))).uploading
  expect(calls.sort()).toEqual(['https://landed.example.com/api/fill-traces/AAAAA1', 'https://landed.example.com/api/fill-traces/AAAAA2'])
})

test("a sync-off account's stay local and aren't sent again", async () => {
  const { store, calls, kept } = setup({ respond: () => ({ ok: false, status: 409 }) })
  await (await store.save(trace('AAAAA1'))).uploading
  await (await store.save(trace('AAAAA2'))).uploading
  expect(calls.map((c) => c.url.slice(-6))).toEqual(['AAAAA1', 'AAAAA2'])
  expect(kept().map((e) => e.uploaded)).toEqual(['local', 'local'])
  await (await store.setOutcome('AAAAA1', { status: 'ready' })).uploading
  expect(calls).toHaveLength(2)
})

test('the outcome is added to the kept trace and uploaded again', async () => {
  const { store, calls } = setup()
  await (await store.save(trace('AAAAA1'))).uploading
  const done = await store.setOutcome('AAAAA1', { status: 'blocked', blocker: { kind: 'login', message: 'Sign in' } }, new Date('2026-10-21T20:04:00Z'))
  await done.uploading
  expect(done.found).toBe(true)
  expect(calls).toHaveLength(2)
  expect(calls[1].body.outcome).toEqual({ status: 'blocked', blocker: { kind: 'login', message: 'Sign in' }, at: '2026-10-21T20:04:00.000Z' })
  expect((await store.setOutcome('ZZZZZZ', { status: 'ready' })).found).toBe(false)
})

test('a slow server never holds up keeping the next fill', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { store, kept } = setup({ respond: async () => { await gate; return { ok: true, status: 204 } } })
  const first = await store.save(trace('AAAAA1'))
  await store.save(trace('AAAAA2'))
  expect(kept().map((e) => e.trace.ref)).toEqual(['AAAAA2', 'AAAAA1'])
  release()
  await first.uploading
})
