// Agents other than Claude Code: Codex (codex exec) and any ACP agent.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.LANDED_HOME = mkdtempSync(join(tmpdir(), 'landed-any-'))
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
process.env.PATH = `${fixtures}:${process.env.PATH}`
// Codex.app exports its bundled CLI path into desktop-launched processes.
// Pin the test double explicitly so that environment cannot bypass PATH and
// turn this unit test into a real, billable Codex search.
process.env.CODEX_CLI_PATH = join(fixtures, 'codex')

const { MASTER_SCHEMA, RESUME_SCHEMA, SEARCH_RESULT_SCHEMA, TAILOR_SCHEMA, specFor } = await import('../src/agents.ts')
const { codexArgs, dropNulls, parseCodexLine, runCodex, strictSchema } = await import('../src/codex.ts')
const { acpPrompt, allowedKinds, decidePermission, probeAcp, runAcp, userAcpAgents } = await import('../src/acp.ts')
const { jsonFromText } = await import('../src/types.ts')
type TaskEvent = import('../src/types.ts').TaskEvent

const fake = { id: 'fake', label: 'Fake Agent', command: join(fixtures, 'fake-acp-agent.mjs'), args: [] }

function collect() {
  const events: TaskEvent[] = []
  return { events, emit: (e: TaskEvent) => events.push(e), last: () => events[events.length - 1] }
}

const search = (extra: Record<string, unknown> = {}) => specFor({ id: 't1', agent: 'x', kind: 'job_search', input: { brief: { roles: ['Backend Engineer'], locations: ['Seattle'] }, ...extra } })

// ── one task description for every agent ─────────────────────────────────

test('specFor: web only where the task needs it; results that need the web must use it', () => {
  const s = search()
  assert.ok(typeof s === 'object')
  assert.equal(s.web, 'search')
  assert.equal(s.requireWeb, true)
  assert.equal(s.schema, SEARCH_RESULT_SCHEMA)
  assert.doesNotMatch(s.system, /structured output tool/) // Claude-only wording is replaced

  const master = { basic: {}, entries: [], education: [], skills: [] }
  const merge = specFor({ id: 'm', agent: 'x', kind: 'resume_merge', input: { sources: [{ id: 'a', name: 'a', resume: {} }], master: null } })
  assert.ok(typeof merge === 'object' && merge.web === 'none')
  const tailorUrl = specFor({ id: 't', agent: 'x', kind: 'resume_tailor', input: { master, target: { role: 'SWE', company: null, job_url: 'https://x.example/j', jd_text: null } } })
  assert.ok(typeof tailorUrl === 'object' && tailorUrl.web === 'fetch')
  const tailorText = specFor({ id: 't', agent: 'x', kind: 'resume_tailor', input: { master, target: { role: 'SWE', company: null, job_url: 'https://x.example/j', jd_text: 'Go, SQL' } } })
  assert.ok(typeof tailorText === 'object' && tailorText.web === 'none')

  assert.match(String(specFor({ id: 'e', agent: 'x', kind: 'email_check', input: {} })), /Claude Code/)
  assert.equal(specFor({ id: 'b', agent: 'x', kind: 'job_search', input: { brief: { roles: [] } } }), 'Bad search task.')
})

test('specFor: a PDF resume becomes text (the agent needs no file access); an image is attached', { skip: process.platform !== 'darwin' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'landed-pdf-'))
  writeFileSync(join(dir, 'r.txt'), 'Zed Qux\nEngineer at Blorp Inc, 2021-2023\nBuilt the blorp pipeline\n')
  const pdf = execFileSync('cupsfilter', [join(dir, 'r.txt')], { stdio: ['ignore', 'pipe', 'ignore'] })
  const spec = specFor({ id: 'p1', agent: 'x', kind: 'resume_parse', input: { name: 'r.pdf', text: null, file: { type: 'application/pdf', data_base64: pdf.toString('base64') } } })
  assert.ok(typeof spec === 'object')
  assert.match(spec.prompt, /Blorp/)
  assert.equal(spec.images, undefined)
  assert.equal(spec.web, 'none')

  const img = specFor({ id: 'p2', agent: 'x', kind: 'resume_parse', input: { name: 'r.png', text: null, file: { type: 'image/png', data_base64: Buffer.from('png').toString('base64') } } })
  assert.ok(typeof img === 'object' && img.images?.length === 1)
  img.cleanup?.()
  rmSync(dir, { recursive: true, force: true })
})

test('jsonFromText: the last ```json block, a bare object, or null', () => {
  assert.deepEqual(jsonFromText('Here:\n```json\n{"a": 1}\n```\nand\n```json\n{"a": 2}\n```'), { a: 2 })
  assert.deepEqual(jsonFromText('{"jobs": []}'), { jobs: [] })
  assert.deepEqual(jsonFromText('Sure! {"jobs": [1]} hope that helps'), { jobs: [1] })
  assert.equal(jsonFromText('no json here'), null)
})

// ── Codex ─────────────────────────────────────────────────────────────────

test('strict schemas: every object closed and fully required, optional fields nullable', () => {
  const walk = (s: any, path: string) => {
    if (s?.type === 'object' || (Array.isArray(s?.type) && s.type.includes('object'))) {
      assert.equal(s.additionalProperties, false, path)
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path)
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`)
    }
    if (s?.items) walk(s.items, `${path}[]`)
    if (s?.anyOf) s.anyOf.forEach((x: any, i: number) => walk(x, `${path}|${i}`))
    assert.equal(s?.maxItems, undefined, path)
  }
  for (const [name, schema] of Object.entries({ SEARCH_RESULT_SCHEMA, MASTER_SCHEMA, TAILOR_SCHEMA, RESUME_SCHEMA })) walk(strictSchema(schema), name)
  const job = (strictSchema(SEARCH_RESULT_SCHEMA) as any).properties.jobs.items.properties
  assert.deepEqual(job.company.type, 'string') // required stays required
  assert.deepEqual(job.deadline.type, ['string', 'null']) // optional becomes nullable
  assert.deepEqual(dropNulls({ a: null, b: [{ c: null, d: 1 }] }), { b: [{ d: 1 }] })
})

test('codex args: read-only sandbox, no shell, none of the user\'s config; web only when needed', () => {
  const s = search()
  assert.ok(typeof s === 'object')
  const args = codexArgs({ ...s, images: ['/tmp/a.png'] }, '/tmp/schema.json')
  const after = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(after('--sandbox'), 'read-only')
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ephemeral'))
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--disable'), ['shell_tool', 'unified_exec'])
  assert.ok(args.includes('approval_policy="never"'))
  assert.ok(args.includes('web_search="live"'))
  assert.equal(after('--output-schema'), '/tmp/schema.json')
  assert.deepEqual(args.slice(-2), ['-i', '/tmp/a.png']) // the prompt comes on stdin
  const dev = args.find((a) => a.startsWith('developer_instructions='))!
  assert.equal(JSON.parse(dev.slice('developer_instructions='.length)), s.system)

  const merge = specFor({ id: 'm', agent: 'x', kind: 'resume_merge', input: { sources: [{ id: 'a', name: 'a', resume: {} }], master: null } })
  assert.ok(typeof merge === 'object')
  assert.ok(codexArgs(merge, '/tmp/schema.json').includes('web_search="disabled"'))
})

test('codex output lines → steps, the answer, failure', () => {
  assert.deepEqual(parseCodexLine('{"type":"item.started","item":{"id":"1","type":"web_search","query":"q"}}'), { event: { type: 'tool', name: 'Web search' }, web: true })
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"hi"}}'), { message: 'hi' })
  assert.deepEqual(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}'), { failed: 'boom' })
  assert.deepEqual(parseCodexLine('{"type":"turn.completed","usage":{}}'), { completed: true })
  assert.deepEqual(parseCodexLine('not json'), {})
})

test('runCodex: schema-bound result → done.jobs (nulls dropped); no search → no results; signed out → clear error', async () => {
  const log = join(process.env.LANDED_HOME!, 'codex.log')
  process.env.FAKE_CODEX_LOG = log
  const s = search()
  assert.ok(typeof s === 'object')

  process.env.FAKE_CODEX_MODE = 'ok'
  let c = collect()
  await runCodex(s, c.emit)
  assert.deepEqual(c.last(), { type: 'done', text: 'found one', jobs: [{ company: 'Blorp', title: 'Engineer', job_url: 'https://blorp.example/jobs/1' }] })
  assert.ok(c.events.some((e) => e.type === 'tool'))
  const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!)
  assert.match(call.stdin, /Backend Engineer/)
  assert.equal(call.schema.additionalProperties, false) // the strict version went to Codex

  process.env.FAKE_CODEX_MODE = 'nosearch'
  c = collect()
  await runCodex(s, c.emit)
  assert.equal(c.last().type, 'error')
  assert.match((c.last() as { message: string }).message, /didn't search the web/)

  process.env.FAKE_CODEX_MODE = 'signedout'
  c = collect()
  await runCodex(s, c.emit)
  assert.match((c.last() as { message: string }).message, /codex login/)
})

// ── ACP ───────────────────────────────────────────────────────────────────

test('permissions: only what the task needs, and never edit/delete/move/execute', () => {
  const opts = [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }]
  const ask = (kind: string, web: 'none' | 'fetch' | 'search') => decidePermission({ toolCall: { kind }, options: opts }, allowedKinds({ web }))
  assert.deepEqual(ask('search', 'search'), { outcome: { outcome: 'selected', optionId: 'y' } })
  assert.deepEqual(ask('fetch', 'fetch'), { outcome: { outcome: 'selected', optionId: 'y' } })
  assert.deepEqual(ask('search', 'fetch'), { outcome: { outcome: 'selected', optionId: 'n' } })
  assert.deepEqual(ask('fetch', 'none'), { outcome: { outcome: 'selected', optionId: 'n' } })
  for (const kind of ['execute', 'edit', 'delete', 'move', 'read', 'other']) assert.deepEqual(ask(kind, 'search'), { outcome: { outcome: 'selected', optionId: 'n' } })
  // No way to say no: cancel the request rather than allow it.
  assert.deepEqual(decidePermission({ toolCall: { kind: 'execute' }, options: [{ optionId: 'y', kind: 'allow_once' }] }, allowedKinds({ web: 'search' })), { outcome: { outcome: 'cancelled' } })
})

test('ACP prompt: instructions, the task, and the JSON Schema to answer with', () => {
  const s = search()
  assert.ok(typeof s === 'object')
  const p = acpPrompt(s)
  assert.ok(p.startsWith('<instructions>'))
  assert.match(p, /Backend Engineer/)
  assert.ok(p.includes(JSON.stringify(SEARCH_RESULT_SCHEMA)))
})

test('ACP: probe opens a session without a model call; a signed-out agent says so', async () => {
  process.env.FAKE_ACP_MODE = 'json'
  assert.deepEqual(await probeAcp(fake), { version: '9.9.9', images: true })
  process.env.FAKE_ACP_MODE = 'auth'
  const r = await probeAcp(fake)
  assert.ok('missing' in r && /not signed in/.test(r.missing))
})

test('ACP: a web search that searched → done.jobs', async () => {
  process.env.FAKE_ACP_MODE = 'json'
  const s = search()
  assert.ok(typeof s === 'object')
  const c = collect()
  await runAcp(fake, s, c.emit)
  assert.deepEqual(c.last(), { type: 'done', text: 'found one', jobs: [{ company: 'Blorp', title: 'Engineer', job_url: 'https://blorp.example/jobs/1' }] })
  assert.deepEqual(c.events[0], { type: 'started', agent: 'fake' })
  assert.ok(c.events.some((e) => e.type === 'tool' && e.name === 'Searching the web'))
  assert.ok(!c.events.some((e) => e.type === 'delta')) // structured tasks don't stream JSON into the UI
})

test('ACP: results that never touched the web are refused', async () => {
  process.env.FAKE_ACP_MODE = 'noweb'
  const s = search()
  assert.ok(typeof s === 'object')
  const c = collect()
  await runAcp(fake, s, c.emit)
  assert.equal(c.last().type, 'error')
  assert.match((c.last() as { message: string }).message, /didn't search the web/)
})

test('ACP: asking to run a command gets a no; running one without asking stops the task', async () => {
  const task = specFor({ id: 'm', agent: 'fake', kind: 'resume_merge', input: { sources: [{ id: 'a', name: 'a', resume: {} }], master: null } })
  assert.ok(typeof task === 'object')
  process.env.FAKE_ACP_MODE = 'ask'
  let c = collect()
  await runAcp(fake, task, c.emit)
  assert.equal(c.last().type, 'done')
  assert.equal((c.last() as { text: string }).text, 'told: no')

  process.env.FAKE_ACP_MODE = 'rogue'
  c = collect()
  await runAcp(fake, task, c.emit)
  assert.equal(c.last().type, 'error')
  assert.match((c.last() as { message: string }).message, /without permission/)
  assert.equal(c.events.filter((e) => e.type === 'done' || e.type === 'error').length, 1)
})

test('ACP: an answer without JSON gets one more turn', async () => {
  process.env.FAKE_ACP_MODE = 'prose'
  const merge = specFor({ id: 'm', agent: 'fake', kind: 'resume_merge', input: { sources: [{ id: 'a', name: 'a', resume: {} }], master: null } })
  assert.ok(typeof merge === 'object')
  const c = collect()
  await runAcp(fake, merge, c.emit)
  assert.deepEqual(c.last(), { type: 'done', text: 'ok', jobs: [] })
})

test('user-added ACP agents: well-formed entries only, and never in place of Claude Code or Codex', () => {
  const file = join(process.env.LANDED_HOME!, 'agents.json')
  writeFileSync(file, JSON.stringify([
    { id: 'mine', label: 'My Agent', command: '/usr/local/bin/my-agent', args: ['acp', 3] },
    { id: 'claude', command: '/tmp/evil' },
    { id: 'Bad Id', command: 'x' },
    { id: 'nocmd' },
  ]))
  assert.deepEqual(userAcpAgents(file), [{ id: 'mine', label: 'My Agent', command: '/usr/local/bin/my-agent', args: ['acp'] }])
  writeFileSync(file, 'not json')
  assert.deepEqual(userAcpAgents(file), [])
})
