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

function makeHandler(events = [], openAndFill, takeAssistResults, pickResume, classifyStatuses, sameJob, rankLeads) {
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
    takeAssistResults,
    onAnswersSynced,
    pickResume,
    classifyStatuses,
    sameJob,
    rankLeads,
  })
  return { handle, q, saved, onQueueChanged, onAnswersSynced }
}

const applied = (company) => ({
  kind: 'applied', company, role: 'PM',
  app_url: 'https://boards.greenhouse.io/x/jobs/1?email=me@x.com&gh_jid=1',
})

describe('bridge handler', () => {
  test('a file the extension can\'t keep (storage full) is an error the page shows, never dropped silently', async () => {
    const handle = createBridgeHandler({
      cfg, snapshotStore: memoryQueue([]).snapshotStore, pushMod, storage: {}, withLock: createQueueLock(), onQueueChanged: jest.fn(), version: '2.2',
      chromeLocal: { async set() { throw new Error('QUOTA_BYTES quota exceeded') }, get(key, cb) { cb({}) } },
    })
    const V = '11111111-2222-4333-8444-555555555555'
    const file = { id: V, name: 'PM resume.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') }
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: V, hash: 'aaaabbbbccccdddd', file } }, FROM_WEB))
      .toEqual({ ok: false, error: "Couldn't keep this resume's file: the extension's storage is full" })
    expect(await handle({ type: 'sync-file', payload: { kind: 'resume', file } }, FROM_WEB))
      .toEqual({ ok: false, error: "Couldn't keep the file: the extension's storage is full" })
  })

  test('the extension asks for unlimited storage: resumes\' files outgrow Chrome\'s 10 MB default', () => {
    expect(require('../manifest.json').permissions).toContain('unlimitedStorage')
  })

  test('version PDFs: the ids it has, one in, a null for a version that has none, one out', async () => {
    const { handle } = makeHandler()
    const V = '11111111-2222-4333-8444-555555555555'
    const W = '22222222-2222-4333-8444-555555555555'
    expect(await handle({ type: 'version-pdf-ids' }, FROM_WEB)).toEqual({ ok: true, data: {} })
    const file = { id: V, name: 'Alex Chen Resume.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') }
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: V, hash: 'aaaabbbbccccdddd', file } }, FROM_WEB)).toEqual({ ok: true, data: { saved: true } })
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: W, hash: 'eeeeffff00001111', file: null } }, FROM_WEB)).toEqual({ ok: true, data: { saved: false } })
    expect(await handle({ type: 'version-pdf-ids' }, FROM_WEB)).toEqual({ ok: true, data: { [V]: 'aaaabbbbccccdddd', [W]: 'eeeeffff00001111' } })
    // Not a resume file (PDF or Word), no hash, not a Landed id: refused.
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: V, hash: 'aaaabbbbccccdddd', file: { ...file, name: 'photo.png', mime: 'image/png' } } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: V, file } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: '../x', hash: 'aaaabbbbccccdddd', file } }, FROM_WEB)).toMatchObject({ ok: false })
    // An uploaded resume's own Word file is taken too (its original, not a PDF).
    const UPLOAD = '33333333-3333-4333-8333-333333333333'
    const docx = { id: UPLOAD, name: 'Alex Chen Resume.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('PK word').toString('base64') }
    expect(await handle({ type: 'sync-version-pdf', payload: { resume_id: UPLOAD, hash: 'aaaabbbbccccdddd', file: docx } }, FROM_WEB)).toMatchObject({ ok: true, data: { saved: true } })
    await handle({ type: 'sync-version-pdf', payload: { resume_id: UPLOAD, remove: true } }, FROM_WEB)
    await handle({ type: 'sync-version-pdf', payload: { resume_id: V, remove: true } }, FROM_WEB)
    expect(await handle({ type: 'version-pdf-ids' }, FROM_WEB)).toEqual({ ok: true, data: { [W]: 'eeeeffff00001111' } })
  })

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

  test('pick-resume sends the host only a job and resumes\' directions, titles and skills, and returns a candidate or nothing', async () => {
    const pickResume = jest.fn(async () => ({ ok: true, model: 'Claude Code', pick: { resume_id: 'r2', confidence: 0.9, reason: 'SQL and A/B tests.' } }))
    const { handle } = makeHandler([], undefined, undefined, pickResume)
    const payload = {
      job: { role: 'Product Analyst', company: 'Northwind', description: 'Own product metrics.', url: 'https://x.test' },
      resumes: [
        { id: 'r1', directions: ['Product Manager'], titles: ['Product Intern'], skills: ['Figma'], email: 'alex@example.com' },
        { id: 'r2', directions: ['Data Analyst'], titles: ['Analytics Intern'], skills: ['SQL'], phone: '555-0142' },
      ],
    }
    const res = await handle({ type: 'pick-resume', payload }, FROM_WEB)
    expect(res).toEqual({ ok: true, data: { pick: { resume_id: 'r2', confidence: 0.9, reason: 'SQL and A/B tests.' }, model: 'Claude Code' } })
    expect(pickResume).toHaveBeenCalledWith({
      type: 'pick_resume',
      job: { role: 'Product Analyst', company: 'Northwind', description: 'Own product metrics.' },
      resumes: [
        { id: 'r1', directions: ['Product Manager'], titles: ['Product Intern'], skills: ['Figma'] },
        { id: 'r2', directions: ['Data Analyst'], titles: ['Analytics Intern'], skills: ['SQL'] },
      ],
    })
    // A pick that isn't one of the candidates is no pick.
    pickResume.mockResolvedValueOnce({ ok: true, model: 'Claude Code', pick: { resume_id: 'r9', confidence: 1, reason: '' } })
    expect((await handle({ type: 'pick-resume', payload }, FROM_WEB)).data.pick).toBeNull()
    // One resume is nothing to choose between.
    expect((await handle({ type: 'pick-resume', payload: { ...payload, resumes: payload.resumes.slice(0, 1) } }, FROM_WEB)).ok).toBe(false)
    expect(pickResume).toHaveBeenCalledTimes(2)
    // No Landed for Mac / no agent: an error, and Landed keeps its own pick.
    pickResume.mockResolvedValueOnce({ ok: false, error: 'Landed for Mac is not installed' })
    expect(await handle({ type: 'pick-resume', payload }, FROM_WEB)).toEqual({ ok: false, error: 'Landed for Mac is not installed' })
  })

  test('same-job sends the host only public posting details, and returns one known verdict per pair with its tokens', async () => {
    const sameJob = jest.fn(async () => ({
      ok: true, model: 'Claude Code',
      verdicts: [{ id: 'p1', verdict: 'same', reason: 'One opening.' }, { id: 'p2', verdict: 'maybe' }, { id: 'p9', verdict: 'same' }],
      usage: { input_tokens: 3000, output_tokens: 150.4 },
    }))
    const { handle } = makeHandler([], undefined, undefined, undefined, undefined, sameJob)
    const payload = {
      pairs: [
        {
          id: 'p1',
          a: { title: 'Data Analyst, New Grad', company: 'Northwind Robotics', location: 'Seattle, WA', url: 'https://northwind.example.com/jobs/7', description: 'x'.repeat(4000), email: 'alex@example.com' },
          b: { title: 'New Grad Data Analyst', company: 'Northwind Robotics', url: 'javascript:alert(1)' },
        },
        { id: 'p2', a: { title: 'Data Analyst' }, b: { title: 'Data Analyst I' } },
        { id: 'p3', a: { title: '' }, b: { title: 'Data Analyst' } },
      ],
    }
    const res = await handle({ type: 'same-job', payload }, FROM_WEB)
    expect(res).toEqual({ ok: true, data: { verdicts: [{ id: 'p1', verdict: 'same', reason: 'One opening.' }], usage: { input_tokens: 3000, output_tokens: 150 }, model: 'Claude Code' } })
    const sent = sameJob.mock.calls[0][0]
    expect(sent.type).toBe('same_job')
    expect(sent.pairs.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(sent.pairs[0].a).toEqual({ title: 'Data Analyst, New Grad', company: 'Northwind Robotics', location: 'Seattle, WA', url: 'https://northwind.example.com/jobs/7', description: 'x'.repeat(1500) })
    expect(sent.pairs[0].b.url).toBe('')
    expect(await handle({ type: 'same-job', payload: { pairs: [] } }, FROM_WEB)).toMatchObject({ ok: false })
    sameJob.mockResolvedValueOnce({ ok: false, error: 'Landed for Mac is not installed' })
    expect(await handle({ type: 'same-job', payload }, FROM_WEB)).toEqual({ ok: false, error: 'Landed for Mac is not installed' })
    // a browser that can't ask
    expect(await makeHandler().handle({ type: 'same-job', payload }, FROM_WEB)).toMatchObject({ ok: false, error: 'this browser cannot ask your agent' })
  })

  test('rank-leads sends the host the context and postings, capped, and returns scores that have reasons', async () => {
    const rankLeads = jest.fn(async () => ({
      ok: true, model: 'Claude Code',
      scores: [{ id: 'l1', score: 1.3, reasons: ['Asks for SQL.', '', 7, 'New grad.'] }, { id: 'l2', score: 0.4, reasons: [] }, { id: 'l9', score: 1, reasons: ['x'] }],
      usage: { input_tokens: 4000, output_tokens: 300 },
    }))
    const { handle } = makeHandler([], undefined, undefined, undefined, undefined, undefined, rankLeads)
    const payload = {
      context: 'From their master resume:\n- Skills: SQL',
      leads: [
        { id: 'l1', title: 'Data Analyst', company: 'Lumen Labs', location: 'Seattle, WA', description: 'x'.repeat(4000), email: 'alex@example.com' },
        { id: 'l2', title: 'Data Engineer' },
        { id: 'l3', title: '' },
      ],
    }
    const res = await handle({ type: 'rank-leads', payload }, FROM_WEB)
    expect(res).toEqual({ ok: true, data: { scores: [{ id: 'l1', score: 1, reasons: ['Asks for SQL.', 'New grad.'] }], usage: { input_tokens: 4000, output_tokens: 300 }, model: 'Claude Code' } })
    const sent = rankLeads.mock.calls[0][0]
    expect(sent).toMatchObject({ type: 'rank_leads', context: 'From their master resume:\n- Skills: SQL' })
    expect(sent.leads.map((l) => l.id)).toEqual(['l1', 'l2'])
    expect(sent.leads[0]).toEqual({ id: 'l1', title: 'Data Analyst', company: 'Lumen Labs', location: 'Seattle, WA', description: 'x'.repeat(2500) })
    expect(await handle({ type: 'rank-leads', payload: { leads: [] } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await makeHandler().handle({ type: 'rank-leads', payload }, FROM_WEB)).toMatchObject({ ok: false, error: 'this browser cannot ask your agent' })
  })

  test('assist-open passes only a safe link, a resume and Landed ids; submit needs an approved lead link', async () => {
    const open = jest.fn(async (req) => ({ ok: true, data: { tab_id: 7, req } }))
    const { handle } = makeHandler([], open)
    const app = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
    const lead = '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
    const res = await handle({ type: 'assist-open', payload: { url: 'https://jobs.lever.co/acme/1', resume_id: 'r1', application_id: app, lead_id: lead, submit_authorized: true } }, FROM_WEB)
    expect(res).toMatchObject({ ok: true, data: { tab_id: 7 } })
    expect(open).toHaveBeenCalledWith({ url: 'https://jobs.lever.co/acme/1', resume_id: 'r1', application_id: app, lead_id: lead, submit_authorized: true, job: null, examples: [] })

    await handle({ type: 'assist-open', payload: { url: 'https://jobs.lever.co/acme/2', resume_id: 'r1', application_id: app, lead_id: 'not-an-id', submit_authorized: true } }, FROM_WEB)
    expect(open).toHaveBeenLastCalledWith({ url: 'https://jobs.lever.co/acme/2', resume_id: 'r1', application_id: app, lead_id: null, submit_authorized: false, job: null, examples: [] })

    // For open-ended answers: the job and the user's own answers, plain text and capped.
    await handle({ type: 'assist-open', payload: {
      url: 'https://jobs.lever.co/acme/3', resume_id: 'r1', application_id: app, lead_id: lead,
      job: { role: 'Product Analyst', company: 'Bluefin', description: 'x'.repeat(9000), email: 'alex@example.com' },
      examples: [{ question: 'Why Contoso?', answer: 'Tools people use.' }, { question: '', answer: 'no question' }, 'junk'],
    } }, FROM_WEB)
    const last = open.mock.calls[open.mock.calls.length - 1][0]
    expect(last.job).toEqual({ role: 'Product Analyst', company: 'Bluefin', description: 'x'.repeat(6000) })
    expect(last.examples).toEqual([{ question: 'Why Contoso?', answer: 'Tools people use.' }])

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@x.com/', 42]) {
      expect(await handle({ type: 'assist-open', payload: { url, resume_id: 'r1' } }, FROM_WEB)).toMatchObject({ ok: false })
    }
    expect(await handle({ type: 'assist-open', payload: { url: 'https://x.com/' } }, FROM_WEB)).toMatchObject({ ok: false })
    expect(await handle({ type: 'assist-open', payload: { url: 'https://x.com/', resume_id: 'r1' } }, { origin: 'https://evil.example' })).toMatchObject({ ok: false })
    expect(open).toHaveBeenCalledTimes(3)
  })

  test('classify-statuses sends only distinct status words and returns stages for those', async () => {
    const classifyStatuses = jest.fn(async () => ({ ok: true, model: 'Claude Code', stages: { 待申请: { stage: 'saved', note: null }, other: { stage: 'offer', note: null } } }))
    const { handle } = makeHandler([], undefined, undefined, undefined, classifyStatuses)
    const res = await handle({ type: 'classify-statuses', payload: { statuses: [' 待申请 ', '待申请', '已申请', 42, ''], company: 'Bluefin' } }, FROM_WEB)
    expect(classifyStatuses).toHaveBeenCalledWith({ type: 'classify_statuses', statuses: ['待申请', '已申请'] })
    expect(res).toEqual({ ok: true, data: { stages: { 待申请: { stage: 'saved', note: null } }, model: 'Claude Code' } })
    classifyStatuses.mockResolvedValueOnce({ ok: false, error: 'Landed for Mac is not installed' })
    expect(await handle({ type: 'classify-statuses', payload: { statuses: ['x'] } }, FROM_WEB)).toEqual({ ok: false, error: 'Landed for Mac is not installed' })
    expect((await handle({ type: 'classify-statuses', payload: { statuses: ['x'] } }, { origin: 'https://evil.example' })).ok).toBe(false)
  })

  test('take-corrections hands the user\'s corrections over once', async () => {
    const { handle, saved } = makeHandler()
    saved['landed:answer-corrections'] = [{ key: 'city', value: 'Bellevue', site: 'jobs.lever.co' }]
    expect(await handle({ type: 'take-corrections' }, FROM_WEB)).toEqual({ ok: true, data: { corrections: [{ key: 'city', value: 'Bellevue', site: 'jobs.lever.co' }] } })
    expect(await handle({ type: 'take-corrections' }, FROM_WEB)).toEqual({ ok: true, data: { corrections: [] } })
    expect((await handle({ type: 'take-corrections' }, { origin: 'https://evil.example' })).ok).toBe(false)
  })

  test('take-assist-results hands independent page results over once', async () => {
    const app = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
    let rows = [{ application_id: app, tab_id: 7, status: 'blocked', blocker: 'captcha' }]
    const take = jest.fn(async () => { const out = rows; rows = []; return out })
    const { handle } = makeHandler([], undefined, take)
    expect(await handle({ type: 'take-assist-results' }, FROM_WEB)).toEqual({
      ok: true, data: { results: [{ application_id: app, tab_id: 7, status: 'blocked', blocker: 'captcha' }] },
    })
    expect(await handle({ type: 'take-assist-results' }, FROM_WEB)).toEqual({ ok: true, data: { results: [] } })
    expect(take).toHaveBeenCalledTimes(2)
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
