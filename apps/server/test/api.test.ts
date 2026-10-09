// End-to-end API tests against a real Postgres. Wipes and re-migrates the
// database at TEST_DATABASE_URL (default: local landed_test) — never point
// it at a database you care about.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { connect, type Sql } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { PortalEventsHub } from '../src/realtime.ts'
import { decryptSecret } from '../src/secrets.ts'

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/landed_test'

const baseConfig: Config = {
  databaseUrl: DB_URL,
  host: '127.0.0.1',
  port: 0,
  secretsKey: randomBytes(32),
  cookieSecure: false,
  signup: 'open',
  webDist: null,
}

let sql: Sql
let hub: PortalEventsHub
let app: ReturnType<typeof createApp>

type Res = { status: number; body: any; headers: Headers }

async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.cookie) headers.Cookie = opts.cookie
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

async function signup(email: string, password = 'correct horse battery'): Promise<string> {
  const res = await call('POST', '/api/auth/signup', { body: { email, password, mode: 'token' } })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.token
}

before(async () => {
  sql = connect(DB_URL)
  await sql.unsafe('drop schema public cascade; create schema public;')
  await migrate(sql)
  hub = new PortalEventsHub(sql)
  await hub.start()
  app = createApp(sql, baseConfig, hub)
})

after(async () => {
  await hub.stop()
  await sql.end()
})

describe('auth', () => {
  test('first-only signup closes after the first account', async () => {
    const closed = createApp(sql, { ...baseConfig, signup: 'first-only' }, hub)
    const req = (email: string) => closed.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'long enough pw' }),
    })
    assert.equal((await req('owner@example.com')).status, 201)
    assert.equal((await req('stranger@example.com')).status, 403)
  })

  test('cookie login, session probe, logout', async () => {
    await signup('cookie@example.com', 'hunter2hunter2')
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'cookie@example.com', password: 'nope-nope' } })).status, 401)

    const login = await call('POST', '/api/auth/login', { body: { email: 'COOKIE@example.com', password: 'hunter2hunter2' } })
    assert.equal(login.status, 200)
    assert.equal(login.body.token, undefined, 'cookie mode must not expose the token to page JS')
    const setCookie = login.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /landed_session=.+; .*HttpOnly/i)
    const cookie = setCookie.split(';')[0]

    assert.equal((await call('GET', '/api/auth/session', { cookie })).body.user.email, 'cookie@example.com')
    assert.equal((await call('GET', '/api/me', { cookie })).status, 200)
    assert.equal((await call('POST', '/api/auth/logout', { cookie })).status, 204)
    assert.equal((await call('GET', '/api/me', { cookie })).status, 401)
    assert.equal((await call('GET', '/api/auth/session', { cookie })).body.user, null)
  })

  test('duplicate email and short password are rejected', async () => {
    await signup('dup@example.com')
    assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'dup@example.com', password: 'whatever123' } })).status, 409)
    assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'short@example.com', password: 'short' } })).status, 400)
  })

  test('unauthenticated API calls get 401', async () => {
    assert.equal((await call('GET', '/api/applications')).status, 401)
    assert.equal((await call('GET', '/api/applications', { token: 'garbage' })).status, 401)
  })
})

describe('data isolation + CRUD', () => {
  let alice: string
  let bob: string
  let aliceAppId: string
  let aliceCompanyId: string

  before(async () => {
    alice = await signup('alice@example.com')
    bob = await signup('bob@example.com')
  })

  test('add application find-or-creates the company', async () => {
    const first = await call('POST', '/api/applications', {
      token: alice,
      body: { company: { name: 'Stripe', hue: 250, logo_chars: 'St' }, application: { role: 'PM', stage: 'applied' } },
    })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const second = await call('POST', '/api/applications', {
      token: alice,
      body: { company: { name: 'Stripe' }, application: { role: 'Senior PM' } },
    })
    assert.equal(second.body.company_id, first.body.company_id)
    aliceAppId = first.body.id
    aliceCompanyId = first.body.company_id

    const companies = await call('GET', '/api/companies', { token: alice })
    assert.equal(companies.body.length, 1)
    assert.equal(companies.body[0].hue, 250)
    const apps = await call('GET', '/api/applications', { token: alice })
    assert.equal(apps.body.length, 2)
    assert.equal(apps.body[0].role, 'Senior PM', 'ordered by last_activity_at desc')
    assert.equal(typeof apps.body[0].created_at, 'string')
  })

  test('patch bumps last_activity_at and ignores non-whitelisted fields', async () => {
    const before = (await call('GET', '/api/applications', { token: alice })).body.find((a: any) => a.id === aliceAppId)
    const res = await call('PATCH', `/api/applications/${aliceAppId}`, {
      token: alice,
      body: { stage: 'onsite', user_id: '00000000-0000-0000-0000-000000000000' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.stage, 'onsite')
    assert.equal(res.body.user_id, before.user_id)
    assert.ok(Date.parse(res.body.last_activity_at) >= Date.parse(before.last_activity_at))
    assert.equal((await call('PATCH', `/api/applications/${aliceAppId}`, { token: alice, body: { stage: 'bogus' } })).status, 400)
  })

  test('bob cannot see or touch alice\'s rows', async () => {
    assert.deepEqual((await call('GET', '/api/applications', { token: bob })).body, [])
    assert.deepEqual((await call('GET', '/api/companies', { token: bob })).body, [])
    assert.equal((await call('PATCH', `/api/applications/${aliceAppId}`, { token: bob, body: { stage: 'rejected' } })).status, 404)
    // Composite FK: bob can't hang a connection / event off alice's company / application.
    assert.equal((await call('PUT', '/api/portal-connections', {
      token: bob, body: { company_id: aliceCompanyId, provider: 'greenhouse' },
    })).status, 400)
    assert.equal((await call('POST', '/api/portal-events', {
      token: bob, body: { type: 'sync', application_id: aliceAppId },
    })).status, 400)
  })

  test('demo import maps applications to companies by name', async () => {
    const res = await call('POST', '/api/import', {
      token: bob,
      body: {
        companies: [{ name: 'Figma', hue: 10 }, { name: 'Linear' }],
        applications: [
          { company_name: 'Figma', role: 'Designer', stage: 'phone', starred: true },
          { company_name: 'Linear', role: 'Engineer' },
          { company_name: 'Unknown Co', role: 'skipped' },
        ],
      },
    })
    assert.deepEqual(res.body, { companies: 2, applications: 2 })
  })

  test('profile onboarding flag round-trips', async () => {
    assert.equal((await call('GET', '/api/me', { token: alice })).body.onboarded_at, null)
    const at = new Date().toISOString()
    assert.equal((await call('PATCH', '/api/me', { token: alice, body: { onboarded_at: at } })).body.onboarded_at, at)
    assert.equal((await call('PATCH', '/api/me', { token: alice, body: { onboarded_at: null } })).body.onboarded_at, null)
  })

  test('only one current resume at a time', async () => {
    const a = await call('POST', '/api/resumes', { token: alice, body: { name: 'A', parsed_json: { basic: { name: 'Alice' } }, set_current: true } })
    const b = await call('POST', '/api/resumes', { token: alice, body: { name: 'B', parsed_json: [1, 2], set_current: true } })
    assert.equal(a.status, 201)
    assert.deepEqual(b.body.parsed_json, [1, 2])
    let list = (await call('GET', '/api/resumes', { token: alice })).body
    assert.deepEqual(list.filter((r: any) => r.is_current).map((r: any) => r.name), ['B'])

    assert.equal((await call('POST', `/api/resumes/${a.body.id}/current`, { token: alice })).status, 200)
    list = (await call('GET', '/api/resumes', { token: alice })).body
    assert.deepEqual(list.filter((r: any) => r.is_current).map((r: any) => r.name), ['A'])

    const renamed = await call('PATCH', `/api/resumes/${a.body.id}`, { token: alice, body: { name: 'A2' } })
    assert.equal(renamed.body.name, 'A2')
    assert.deepEqual(renamed.body.parsed_json, { basic: { name: 'Alice' } })
    assert.equal((await call('DELETE', `/api/resumes/${a.body.id}`, { token: bob })).status, 404)
    assert.equal((await call('DELETE', `/api/resumes/${a.body.id}`, { token: alice })).status, 204)
  })

  test('ai_runs insert', async () => {
    const res = await call('POST', '/api/ai-runs', {
      token: alice,
      body: { task: 'resume_match', provider: 'claude', prompt_text: 'p', response_text: 'r', parsed_json: [{ jd_id: 'x' }], parse_format: 'json' },
    })
    assert.equal(res.status, 201)
    assert.match(res.body.id, /^[0-9a-f-]{36}$/)
    assert.equal((await call('POST', '/api/ai-runs', { token: alice, body: { task: 'nope', provider: 'claude', prompt_text: 'p' } })).status, 400)
  })

  test('ai keys are write-only and encrypted at rest', async () => {
    const put = await call('PUT', '/api/ai-keys/claude', { token: alice, body: { secret: 'sk-ant-123', label: 'mine' } })
    assert.equal(put.status, 200)
    assert.equal(put.body.secret, undefined)
    await call('PUT', '/api/ai-keys/claude', { token: alice, body: { secret: 'sk-ant-456' } })
    const list = await call('GET', '/api/ai-keys', { token: alice })
    assert.equal(list.body.length, 1)
    assert.equal(JSON.stringify(list.body).includes('sk-ant'), false)
    const [{ secret_ciphertext }] = await sql`select secret_ciphertext from ai_provider_keys where id = ${put.body.id}`
    assert.equal(decryptSecret(baseConfig.secretsKey, secret_ciphertext), 'sk-ant-456')
    assert.equal((await call('PUT', '/api/ai-keys/other', { token: alice, body: { secret: 'x' } })).status, 400)
    assert.equal((await call('DELETE', `/api/ai-keys/${put.body.id}`, { token: bob })).status, 404)
    assert.equal((await call('DELETE', `/api/ai-keys/${put.body.id}`, { token: alice })).status, 204)
  })
})

describe('portal sync', () => {
  let carol: string
  let companyId: string

  before(async () => {
    carol = await signup('carol@example.com')
    const res = await call('POST', '/api/applications', {
      token: carol, body: { company: { name: 'Ramp' }, application: { role: 'Ops' } },
    })
    companyId = res.body.company_id
  })

  test('connection upsert is idempotent on (user, company, provider)', async () => {
    const a = await call('PUT', '/api/portal-connections', { token: carol, body: { company_id: companyId, provider: 'greenhouse' } })
    const b = await call('PUT', '/api/portal-connections', { token: carol, body: { company_id: companyId, provider: 'greenhouse', status: 'expired' } })
    assert.equal(a.body.id, b.body.id)
    assert.equal(b.body.status, 'expired')
    assert.equal((await call('GET', '/api/portal-connections', { token: carol })).body.length, 1)
  })

  test('portal-ingest upserts the connection and records the event', async () => {
    const one = await call('POST', '/api/portal-ingest', {
      token: carol, body: { provider: 'lever', event_type: 'sync', company_id: companyId, payload: { n: 1 } },
    })
    assert.equal(one.status, 201, JSON.stringify(one.body))
    const two = await call('POST', '/api/portal-ingest', {
      token: carol, body: { provider: 'lever', event_type: 'expired', company_id: companyId, status: 'expired' },
    })
    assert.equal(one.body.connection_id, two.body.connection_id)
    const bad = await call('POST', '/api/portal-ingest', { token: carol, body: { provider: 'myspace', event_type: 'sync' } })
    assert.equal(bad.status, 400)
    assert.ok(bad.body.fields.provider)
  })

  test('batch event push (extension shape) ignores body user_id', async () => {
    const res = await call('POST', '/api/portal-events', {
      token: carol,
      body: [
        { user_id: 'someone-else', type: 'status-change', payload_json: { company: 'Ramp', to: 'applied' } },
        { type: 'rejection', payload_json: {} },
      ],
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.inserted, 2)
    const feed = await call('GET', '/api/portal-events?limit=2', { token: carol })
    assert.equal(feed.body.length, 2)
    assert.ok(feed.body.every((e: any) => e.user_id === res.body.rows[0].user_id))
  })

  test('SSE stream delivers only the subscriber\'s own inserts', async () => {
    const dave = await signup('dave@example.com')
    const ac = new AbortController()
    const res = await app.request('/api/portal-events/stream', {
      headers: { Authorization: `Bearer ${carol}` },
      signal: ac.signal,
    })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const readUntil = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buf += decoder.decode(value)
      }
    }
    await readUntil('event: ready')

    await call('POST', '/api/portal-events', { token: dave, body: { type: 'sync', payload_json: { who: 'dave' } } })
    await call('POST', '/api/portal-events', { token: carol, body: { type: 'sync', payload_json: { who: 'carol' } } })
    await readUntil('"who":"carol"')
    assert.equal(buf.includes('"who":"dave"'), false)
    ac.abort()
    await reader.cancel().catch(() => {})
  })
})
