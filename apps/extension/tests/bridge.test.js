// Tests for the Landed web ↔ extension bridge:
//   - lib/bridge-handler.js (service-worker side): origin gate, take-events
//     drains the queue exactly once, sync-resumes sanitizes + stores
//   - createQueueLock serializes overlapping sections
//   - lib/web-bridge.js (content script): relays page messages both ways

const { createBridgeHandler, createQueueLock } = require('../lib/bridge-handler.js')
// The SW edition registers itself on globalThis instead of exporting.
require('../lib/portal-events-push.js')
const pushMod = globalThis.LandedPortalEventsPush

const cfg = {
  WEB_ORIGINS: ['http://localhost:5173'],
  LOCAL_RESUMES_KEY: 'landed:local-resumes',
}
const FROM_WEB = { origin: 'http://localhost:5173' }

function memoryQueue(events) {
  let queue = { events, last_updated: null }
  return {
    snapshotStore: {
      async loadPending() { return queue },
      async clearPending() { queue = { events: [], last_updated: 'now' } },
    },
    get queue() { return queue },
  }
}

function makeHandler(events = [], openAndFill) {
  const q = memoryQueue(events)
  const saved = {}
  const onQueueChanged = jest.fn()
  const onAnswersSynced = jest.fn()
  const handle = createBridgeHandler({
    cfg,
    snapshotStore: q.snapshotStore,
    pushMod,
    storage: {},
    chromeLocal: { async set(obj) { Object.assign(saved, obj) }, get(key, cb) { cb({ [key]: saved[key] }) } },
    withLock: createQueueLock(),
    onQueueChanged,
    version: '2.2',
    openAndFill,
    onAnswersSynced,
  })
  return { handle, q, saved, onQueueChanged, onAnswersSynced }
}

const applied = (company) => ({
  kind: 'applied', company, role: 'PM',
  app_url: 'https://boards.greenhouse.io/x/jobs/1?email=me@x.com&gh_jid=1',
})

describe('bridge handler', () => {
  test('take-questions hands the queued questions over once; answers coming back tell open pages', async () => {
    const { handle, saved, onAnswersSynced } = makeHandler()
    saved['landed:unanswered-questions'] = [{ question: 'T-shirt size', key: null, options: ['S', 'M'], site: 'jobs.example.com' }]
    expect(await handle({ type: 'take-questions' }, FROM_WEB)).toEqual({
      ok: true, data: { questions: [{ question: 'T-shirt size', key: null, options: ['S', 'M'], site: 'jobs.example.com' }] },
    })
    expect(await handle({ type: 'take-questions' }, FROM_WEB)).toEqual({ ok: true, data: { questions: [] } })
    expect(await handle({ type: 'take-questions' }, { origin: 'https://evil.example' })).toMatchObject({ ok: false })

    await handle({ type: 'sync-answers', payload: { answers: null } }, FROM_WEB)
    expect(onAnswersSynced).not.toHaveBeenCalled()
    await handle({ type: 'sync-answers', payload: { answers: { city: 'Seattle', custom: [{ question: 'T-shirt size', answer: 'M' }] } } }, FROM_WEB)
    expect(onAnswersSynced).toHaveBeenCalledTimes(1)
  })

  test('rejects requests from other origins', async () => {
    const { handle, q } = makeHandler([applied('Acme')])
    expect(await handle({ type: 'take-events' }, { origin: 'https://evil.example' }))
      .toEqual({ ok: false, error: 'origin not allowed' })
    expect(await handle({ type: 'take-events' }, {})).toMatchObject({ ok: false })
    expect(q.queue.events).toHaveLength(1)
  })

  test('falls back to sender.url when origin is absent', async () => {
    const { handle } = makeHandler()
    expect(await handle({ type: 'hello' }, { url: 'http://localhost:5173/sync' }))
      .toEqual({ ok: true, data: { version: '2.2' } })
  })

  test('take-events returns mapped rows once and clears the queue', async () => {
    const { handle, q, onQueueChanged } = makeHandler([applied('Acme'), applied('Beta')])
    const first = await handle({ type: 'take-events' }, FROM_WEB)
    expect(first.ok).toBe(true)
    expect(first.data.rows).toHaveLength(2)
    const row = first.data.rows[0]
    expect(row).not.toHaveProperty('user_id')
    expect(row.type).toBe('status-change')
    expect(row.payload_json.company).toBe('Acme')
    expect(row.payload_json.app_url).not.toMatch(/email=/)
    expect(q.queue.events).toEqual([])
    expect(onQueueChanged).toHaveBeenCalledTimes(1)

    const second = await handle({ type: 'take-events' }, FROM_WEB)
    expect(second.data.rows).toEqual([])
    expect(onQueueChanged).toHaveBeenCalledTimes(1)
  })

  test('concurrent takes never deliver the same event twice', async () => {
    const { handle } = makeHandler([applied('Acme'), applied('Beta'), applied('Gamma')])
    const [a, b] = await Promise.all([
      handle({ type: 'take-events' }, FROM_WEB),
      handle({ type: 'take-events' }, FROM_WEB),
    ])
    expect(a.data.rows.length + b.data.rows.length).toBe(3)
  })

  test('sync-resumes stores a sanitized copy', async () => {
    const { handle, saved } = makeHandler()
    const res = await handle({
      type: 'sync-resumes',
      payload: {
        resumes: [
          { id: 'r1', name: 'CV', parsed_json: { basic: {} }, is_current: true, created_at: '2026-10-09', user_id: 'x', extra: 1 },
          { id: 'v1', name: 'Ops', parsed_json: {}, kind: 'version', target: { role: 'Product Operations Analyst', company: 'Instawork', jd_text: 'long…', notes: {} } },
          { id: 2, name: 'bad id' },
          null,
        ],
      },
    }, FROM_WEB)
    expect(res).toEqual({ ok: true, data: { count: 2 } })
    expect(saved['landed:local-resumes'].resumes).toEqual([
      { id: 'r1', name: 'CV', parsed_json: { basic: {} }, is_current: true, created_at: '2026-10-09', kind: 'source', target: null },
      // A version keeps what it's for (not its job description or notes).
      { id: 'v1', name: 'Ops', parsed_json: {}, is_current: false, created_at: '', kind: 'version',
        target: { role: 'Product Operations Analyst', company: 'Instawork', job_url: null, application_id: null } },
    ])
    expect(await handle({ type: 'sync-resumes', payload: {} }, FROM_WEB)).toMatchObject({ ok: false })
  })

  test('assist-open passes only a safe link, a resume and Landed ids', async () => {
    const open = jest.fn(async (req) => ({ ok: true, data: { tab_id: 7, req } }))
    const { handle } = makeHandler([], open)
    const app = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
    const res = await handle({ type: 'assist-open', payload: { url: 'https://jobs.lever.co/acme/1', resume_id: 'r1', application_id: app, lead_id: 'not-an-id' } }, FROM_WEB)
    expect(res).toMatchObject({ ok: true, data: { tab_id: 7 } })
    expect(open).toHaveBeenCalledWith({ url: 'https://jobs.lever.co/acme/1', resume_id: 'r1', application_id: app, lead_id: null })

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@x.com/', 42]) {
      expect(await handle({ type: 'assist-open', payload: { url, resume_id: 'r1' } }, FROM_WEB)).toMatchObject({ ok: false })
    }
    expect(await handle({ type: 'assist-open', payload: { url: 'https://x.com/' } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await handle({ type: 'assist-open', payload: { url: 'https://x.com/', resume_id: 'r1' } }, { origin: 'https://evil.example' })).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(1)
  })

  test('a submission from a tab Landed opened keeps its application', async () => {
    const app = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
    const { handle } = makeHandler([{ ...applied('Acme'), application_id: app, lead_id: 'x' }])
    const { data } = await handle({ type: 'take-events' }, FROM_WEB)
    expect(data.rows[0].payload_json.application_id).toBe(app)
    expect(data.rows[0].payload_json).not.toHaveProperty('lead_id')
  })

  test('files: the page learns which ones the extension has, then sends only what changed', async () => {
    const { handle, saved } = makeHandler()
    expect(await handle({ type: 'file-ids' }, FROM_WEB)).toEqual({ ok: true, data: { resume: null, cover_letter: null } })
    const file = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'Resume.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') }
    expect(await handle({ type: 'sync-file', payload: { kind: 'resume', file } }, FROM_WEB)).toMatchObject({ ok: true, data: { saved: true } })
    expect((await handle({ type: 'file-ids' }, FROM_WEB)).data).toEqual({ resume: file.id, cover_letter: null })
    expect(saved['landed:application-files'].resume).toEqual(file)

    for (const bad of [{ ...file, name: 'evil.exe' }, { ...file, data: 'not base64!' }, { ...file, id: 'x' }, { ...file, data: 'A'.repeat(5 * 1024 * 1024) }]) {
      expect(await handle({ type: 'sync-file', payload: { kind: 'resume', file: bad } }, FROM_WEB)).toMatchObject({ ok: false })
    }
    expect(await handle({ type: 'sync-file', payload: { kind: 'passport', file } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await handle({ type: 'sync-file', payload: { kind: 'resume', file } }, { origin: 'https://evil.example' })).toMatchObject({ ok: false })
    await handle({ type: 'sync-file', payload: { kind: 'resume', file: null } }, FROM_WEB)
    expect((await handle({ type: 'file-ids' }, FROM_WEB)).data.resume).toBeNull()
  })

  test('unknown request types are rejected', async () => {
    const { handle } = makeHandler()
    expect(await handle({ type: 'drop-tables' }, FROM_WEB)).toEqual({ ok: false, error: 'unknown bridge request' })
  })
})

describe('createQueueLock', () => {
  test('runs sections one at a time, in order, even when one throws', async () => {
    const lock = createQueueLock()
    const log = []
    const section = (name, ms, fail) => lock(async () => {
      log.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, ms))
      log.push(`end ${name}`)
      if (fail) throw new Error(name)
    })
    const results = await Promise.allSettled([section('a', 15), section('b', 1, true), section('c', 1)])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })
})

describe('web-bridge content script', () => {
  let sendMessage
  let posted

  beforeEach(() => {
    jest.resetModules()
    posted = []
    sendMessage = jest.fn((msg, cb) => cb({ ok: true, data: { echoed: msg.type } }))
    globalThis.chrome = {
      runtime: { sendMessage, lastError: undefined, getManifest: () => ({ version: '2.2' }) },
    }
    jest.spyOn(window, 'postMessage').mockImplementation((data) => posted.push(data))
    require('../lib/web-bridge.js')
  })

  afterEach(() => {
    window.postMessage.mockRestore()
    delete globalThis.chrome
  })

  const fromPage = (data) => window.dispatchEvent(new MessageEvent('message', { data, source: window }))

  test('announces itself on load', () => {
    expect(posted[0]).toEqual({ source: 'landed-extension', type: 'ready', version: '2.2' })
  })

  test('relays page requests and posts the reply with the same id', () => {
    fromPage({ source: 'landed-web', id: 'req-1', type: 'take-events' })
    expect(sendMessage).toHaveBeenCalledWith({ action: 'landed-bridge', type: 'take-events', payload: undefined }, expect.any(Function))
    expect(posted[1]).toEqual({ source: 'landed-extension', id: 'req-1', ok: true, data: { echoed: 'take-events' }, error: undefined })
  })

  test('ignores messages that are not from the Landed page', () => {
    fromPage({ source: 'something-else', id: 'x', type: 'take-events' })
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'landed-web', id: 'y', type: 'hello' }, source: null }))
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
