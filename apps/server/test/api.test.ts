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
import { RuntimeHub } from '../src/runtime-hub.ts'
import { purgeAgentRelay } from '../src/routes/agent.ts'
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

async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers }
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

const EMPTY_SNAPSHOT = { format: 'landed-backup', version: 1, exported_at: new Date().toISOString(), profile: { onboarded_at: null } }

/** New account (token mode). Landed is local-first, so accounts start with
 *  Cloud sync off; most tests exercise Cloud data routes and turn it on. */
async function signup(email: string, password = 'correct horse battery', opts: { cloud?: boolean } = {}): Promise<string> {
  const res = await call('POST', '/api/auth/signup', { body: { email, password, mode: 'token' } })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  if (opts.cloud !== false) {
    const on = await call('POST', '/api/cloud/enable', { token: res.body.token, body: EMPTY_SNAPSHOT })
    assert.equal(on.status, 200, JSON.stringify(on.body))
  }
  return res.body.token
}

before(async () => {
  sql = connect(DB_URL)
  await sql.unsafe('drop schema public cascade; create schema public;')
  await migrate(sql)
  hub = new PortalEventsHub(sql)
  await hub.start()
  app = createApp(sql, baseConfig, hub, new RuntimeHub())
})

after(async () => {
  await hub.stop()
  await sql.end()
})

describe('auth', () => {
  test('first-only signup closes after the first account', async () => {
    const closed = createApp(sql, { ...baseConfig, signup: 'first-only' }, hub, new RuntimeHub())
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

describe('agent observation inbox', () => {
  const obs = (over: Record<string, unknown> = {}) => ({
    schema_version: '0.1',
    run_id: 'muse-run-001',
    observation_type: 'job_discovered',
    observed_at: '2026-10-09T16:00:00-07:00',
    payload: { title: 'Test Product Manager', company: 'Acme Test Company', job_url: 'https://acme.test/jobs/1', source: 'muse' },
    ...over,
  })
  const submit = (token: string, key: string, body: unknown) =>
    call('POST', '/api/agent/observations', { token, headers: { 'Idempotency-Key': key }, body })

  async function connect(owner: string, name = 'Muse') {
    const created = await call('POST', '/api/agent-connections', { token: owner, body: { provider: 'Meta_Muse', display_name: name } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.match(created.body.token, /^landed_agent_/)
    assert.equal(created.body.connection.provider, 'meta_muse')
    return created.body as { token: string; connection: { id: string } }
  }

  test('narrow token, idempotent retries, conflicting reuse of a key', async () => {
    const owner = await signup('agent-owner@example.com')
    const { token } = await connect(owner)

    const first = await submit(token, 'muse-run-001:job-001', obs())
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.duplicate, false)
    const retry = await submit(token, 'muse-run-001:job-001', obs())
    assert.equal(retry.status, 200)
    assert.equal(retry.body.duplicate, true)
    assert.equal(retry.body.observation_id, first.body.observation_id)

    const conflict = await submit(token, 'muse-run-001:job-001', obs({ payload: { title: 'Other', company: 'Different Co' } }))
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'idempotency_conflict')

    assert.equal((await call('POST', '/api/agent/observations', { body: obs() })).status, 401)
    assert.equal((await call('GET', '/api/applications', { token })).status, 401, 'agent token is not a session')
  })

  test('schema v0.1 is enforced per observation type', async () => {
    const owner = await signup('schema-owner@example.com')
    const { token } = await connect(owner)
    const bad: [string, unknown][] = [
      ['no payload', { ...obs(), payload: undefined }],
      ['legacy job field', { ...obs(), payload: undefined, job: { title: 't', company: 'c' } }],
      ['missing company', obs({ payload: { title: 'PM' } })],
      ['non-http url', obs({ payload: { title: 'PM', company: 'X', job_url: 'javascript:alert(1)' } })],
      ['unknown type', obs({ observation_type: 'vibes' })],
      ['bad status', obs({ observation_type: 'application_status', payload: { status: 'ghosted?', company: 'X' } })],
      ['bad confidence', obs({ observation_type: 'application_status', payload: { status: 'interview', company: 'X', confidence: 7 } })],
      ['loose timestamp', obs({ observed_at: '2026' })],
      ['no time zone', obs({ observed_at: '2026-10-09T12:00:00' })],
      ['old schema', obs({ schema_version: '0.0' })],
    ]
    for (const [label, body] of bad) {
      const res = await submit(token, `bad-${label}`, body)
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`)
    }
    const status = await submit(token, 'gmail-1', obs({
      observation_type: 'application_status',
      payload: {
        status: 'interview', company: 'Acme', role: 'PM', confidence: 0.92,
        evidence: { source: 'gmail', message_id: '<abc@mail>', sender_domain: 'acme.com', subject: 'Interview invite', received_at: '2026-10-09T13:00:00Z' },
      },
    }))
    assert.equal(status.status, 201, JSON.stringify(status.body))
    assert.equal((await submit(token, 'err-1', obs({ observation_type: 'sync_error', payload: { message: 'Gmail auth expired' } }))).status, 201)
    const huge = obs({ payload: { title: 'PM', company: 'X', description: 'x'.repeat(70 * 1024) } })
    assert.equal((await submit(token, 'huge', huge)).status, 413)
  })

  test('revoked tokens stop working; connections are per user', async () => {
    const owner = await signup('revoke-owner@example.com')
    const other = await signup('revoke-other@example.com')
    const { token, connection } = await connect(owner)
    assert.equal((await call('POST', `/api/agent-connections/${connection.id}/revoke`, { token: other })).status, 404)
    assert.deepEqual((await call('GET', '/api/agent-connections', { token: other })).body, [])
    const revoked = await call('POST', `/api/agent-connections/${connection.id}/revoke`, { token: owner })
    assert.equal(revoked.status, 200)
    assert.ok(revoked.body.revoked_at)
    assert.equal((await submit(token, 'after-revoke', obs())).status, 401)
  })

  test('sync-off account: the server only relays until the browser picks it up', async () => {
    const owner = await signup('relay-owner@example.com', 'relay-password-1', { cloud: false })
    const { token } = await connect(owner)
    const first = await submit(token, 'relay-1', obs())
    assert.equal(first.status, 201)

    const inbox = await call('GET', '/api/agent-inbox', { token: owner })
    assert.equal(inbox.status, 200)
    assert.equal(inbox.body.length, 1)
    assert.equal(inbox.body[0].payload_json.payload.company, 'Acme Test Company')
    assert.equal(inbox.body[0].provider, 'meta_muse')

    const ack = await call('POST', '/api/agent-inbox/ack', { token: owner, body: { ids: [first.body.observation_id] } })
    assert.deepEqual(ack.body, { acked: 1 })
    assert.deepEqual((await call('GET', '/api/agent-inbox', { token: owner })).body, [])
    const [row] = await sql`select payload_json, delivered_at from agent_observations where id = ${first.body.observation_id}`
    assert.equal(row.payload_json, null, 'payload purged after delivery')
    assert.ok(row.delivered_at)

    // the receipt still makes retries idempotent and catches conflicting reuse
    assert.equal((await submit(token, 'relay-1', obs())).body.duplicate, true)
    assert.equal((await submit(token, 'relay-1', obs({ run_id: 'other-run' }))).status, 409)
  })

  test('sync-on account keeps observations in Cloud', async () => {
    const owner = await signup('cloud-agent@example.com')
    const { token } = await connect(owner)
    const res = await submit(token, 'cloud-1', obs())
    const [row] = await sql`select expires_at, payload_json from agent_observations where id = ${res.body.observation_id}`
    assert.equal(row.expires_at, null)
    assert.ok(row.payload_json)
    assert.deepEqual((await call('GET', '/api/agent-inbox', { token: owner })).body, [], 'nothing to relay')
    const exp = await call('GET', '/api/export', { token: owner })
    assert.deepEqual(exp.body.agent_observations.map((o: any) => o.id), [res.body.observation_id])
  })

  test('observations follow the data when sync is turned on and off', async () => {
    const owner = await signup('switch-agent@example.com', 'switch-password-1', { cloud: false })
    const { token, connection } = await connect(owner)
    const held = await submit(token, 'held-1', obs())
    const picked = await submit(token, 'picked-1', obs({ run_id: 'run-2' }))
    // the device pulled `picked` earlier, so the server only has its receipt
    const [pickedRow] = await call('GET', '/api/agent-inbox', { token: owner }).then((r) => r.body.filter((o: any) => o.id === picked.body.observation_id))
    await call('POST', '/api/agent-inbox/ack', { token: owner, body: { ids: [picked.body.observation_id] } })

    // turning sync on uploads the device copy of `picked` and promotes `held`
    const deviceSnapshot = { ...EMPTY_SNAPSHOT, agent_observations: [{ ...pickedRow }] }
    const on = await call('POST', '/api/cloud/enable', { token: owner, body: deviceSnapshot })
    assert.equal(on.status, 200, JSON.stringify(on.body))
    const rows = await sql`select id, payload_json is not null as has_payload, expires_at, payload_sha256 from agent_observations where connection_id = ${connection.id} order by created_at`
    assert.deepEqual(rows.map((r) => [r.id, r.has_payload, r.expires_at]), [
      [held.body.observation_id, true, null],
      [picked.body.observation_id, true, null],
    ])
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.payload_sha256)))
    assert.equal((await submit(token, 'picked-1', obs({ run_id: 'run-2' }))).body.duplicate, true)

    // turning sync off: export carries both, then the server keeps receipts only
    const exp = await call('GET', '/api/export', { token: owner })
    assert.equal(exp.body.agent_observations.length, 2)
    assert.equal((await call('POST', '/api/cloud/disable', { token: owner, body: { password: 'switch-password-1' } })).status, 200)
    const after = await sql`select count(*)::int as n from agent_observations where connection_id = ${connection.id} and payload_json is not null`
    assert.equal(after[0].n, 0)
    assert.equal((await submit(token, 'held-1', obs())).body.duplicate, true)
  })

  test('relay cleanup: unclaimed payloads expire, old receipts go away', async () => {
    const owner = await signup('purge-owner@example.com', 'purge-password-1', { cloud: false })
    const { token } = await connect(owner)
    const stale = await submit(token, 'stale-1', obs())
    const old = await submit(token, 'old-1', obs({ run_id: 'old' }))
    const fresh = await submit(token, 'fresh-1', obs({ run_id: 'fresh' }))
    await sql`update agent_observations set expires_at = now() - interval '1 minute' where id = ${stale.body.observation_id}`
    await sql`update agent_observations set payload_json = null, delivered_at = now() - interval '31 days' where id = ${old.body.observation_id}`
    await purgeAgentRelay(sql)
    const rows = await sql`select id, payload_json is not null as has_payload from agent_observations where id = any(${[stale.body.observation_id, old.body.observation_id, fresh.body.observation_id]}::uuid[])`
    const state = Object.fromEntries(rows.map((r) => [r.id, r.has_payload]))
    assert.equal(state[stale.body.observation_id], false, 'expired payload purged')
    assert.equal(old.body.observation_id in state, false, 'old receipt deleted')
    assert.equal(state[fresh.body.observation_id], true)
  })

  test('observation review list is scoped to the owner', async () => {
    const owner = await signup('review-owner@example.com')
    const other = await signup('review-other@example.com')
    const { token } = await connect(owner)
    await submit(token, 'review-1', obs())
    assert.equal((await call('GET', '/api/agent-observations', { token: owner })).body.length, 1)
    assert.deepEqual((await call('GET', '/api/agent-observations', { token: other })).body, [])
    assert.deepEqual((await call('GET', '/api/agent-inbox', { token: other })).body, [])
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
      body: { stage: 'oa', user_id: '00000000-0000-0000-0000-000000000000' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.stage, 'oa')
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

describe('sync: local device <-> Landed Cloud', () => {
  const uuid = () => crypto.randomUUID()
  const now = new Date().toISOString()

  // A snapshot as the web app's local store produces it (client-side ids).
  function deviceSnapshot() {
    const stripe = uuid(), figma = uuid(), app1 = uuid(), app2 = uuid(), conn = uuid()
    return {
      format: 'landed-backup', version: 1, exported_at: now,
      profile: { onboarded_at: now },
      companies: [
        { id: stripe, name: 'Stripe', hue: 250, logo_chars: 'St', created_at: now },
        { id: figma, name: 'Figma', created_at: now },
      ],
      applications: [
        { id: app1, company_id: stripe, role: 'PM', stage: 'onsite', starred: true, last_activity_at: now, created_at: now },
        { id: app2, company_id: figma, role: 'Designer', created_at: now },
        { id: uuid(), company_id: uuid(), role: 'orphan' },
      ],
      portal_connections: [{ id: conn, company_id: stripe, provider: 'greenhouse', status: 'active', created_at: now }],
      portal_events: [
        { id: uuid(), connection_id: conn, application_id: app1, type: 'status-change', payload_json: { to: 'onsite' }, created_at: now },
        { id: uuid(), connection_id: uuid(), application_id: uuid(), type: 'sync', payload_json: {}, created_at: now },
      ],
      resumes: [{ id: uuid(), name: 'Local CV', parsed_json: { basic: { name: 'Erin' } }, is_current: true, created_at: now }],
      ai_runs: [{ id: uuid(), task: 'jd_breakdown', provider: 'claude', prompt_text: 'p', parsed_json: [1], parse_format: 'json', created_at: now }],
    }
  }

  test('upload into an empty account, then export round-trips it', async () => {
    const erin = await signup('erin@example.com')
    const snap = deviceSnapshot()
    const up = await call('POST', '/api/sync/upload', { token: erin, body: snap })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.deepEqual(up.body, {
      companies: 2, companies_merged: 0, applications: 2, portal_connections: 1,
      portal_events: 2, resumes: 1, ai_runs: 1, agent_observations: 0, job_leads: 0, status_suggestions: 0,
      job_searches: 0,
    })

    const exp = await call('GET', '/api/export', { token: erin })
    assert.equal(exp.status, 200)
    assert.equal(exp.body.format, 'landed-backup')
    assert.equal(exp.body.profile.onboarded_at, now)
    assert.deepEqual(exp.body.applications.map((a: any) => a.id).sort(), [snap.applications[0].id, snap.applications[1].id].sort())
    const pm = exp.body.applications.find((a: any) => a.role === 'PM')
    assert.equal(pm.stage, 'interview', 'older backups: onsite → interview')
    assert.deepEqual(pm.interviews, [{ round: null, format: 'onsite', interviewers: [], at: null, note: null }])
    assert.equal(pm.starred, true)
    assert.equal(exp.body.resumes[0].is_current, true)
    assert.deepEqual(exp.body.ai_runs[0].parsed_json, [1])
    // dangling references from the device become null instead of failing
    const dangling = exp.body.portal_events.find((e: any) => e.type === 'sync')
    assert.equal(dangling.connection_id, null)
    assert.equal(dangling.application_id, null)
    assert.equal(exp.body.applications[0].user_id, undefined, 'export carries no user ids')

    // retrying the same upload is a no-op
    const again = await call('POST', '/api/sync/upload', { token: erin, body: snap })
    assert.equal(again.body.applications, 0)
    assert.equal(again.body.companies_merged, 2)
    assert.equal((await call('GET', '/api/applications', { token: erin })).body.length, 2)
  })

  test('a second device merges into existing cloud data', async () => {
    const fay = await signup('fay@example.com')
    await call('POST', '/api/resumes', { token: fay, body: { name: 'Cloud CV', set_current: true } })
    const existing = await call('POST', '/api/applications', {
      token: fay, body: { company: { name: 'Stripe' }, application: { role: 'Cloud role' } },
    })
    const up = await call('POST', '/api/sync/upload', { token: fay, body: deviceSnapshot() })
    assert.equal(up.body.companies_merged, 1, 'Stripe merged by name')
    assert.equal(up.body.companies, 1, 'Figma is new')

    const apps = (await call('GET', '/api/applications', { token: fay })).body
    assert.equal(apps.length, 3)
    assert.equal(apps.filter((a: any) => a.company_id === existing.body.company_id).length, 2)
    const resumes = (await call('GET', '/api/resumes', { token: fay })).body
    assert.deepEqual(resumes.filter((r: any) => r.is_current).map((r: any) => r.name), ['Cloud CV'])
  })

  test('bad snapshots are rejected atomically', async () => {
    const gus = await signup('gus@example.com')
    assert.equal((await call('POST', '/api/sync/upload', { token: gus, body: { format: 'nope' } })).status, 400)
    const snap = deviceSnapshot()
    snap.applications[1].stage = 'not-a-stage'
    assert.equal((await call('POST', '/api/sync/upload', { token: gus, body: snap })).status, 400)
    assert.deepEqual((await call('GET', '/api/companies', { token: gus })).body, [], 'nothing half-written')
  })

  test('delete account needs the password and removes everything', async () => {
    const hal = await signup('hal@example.com', 'hal-password-1')
    await call('POST', '/api/sync/upload', { token: hal, body: deviceSnapshot() })
    assert.equal((await call('DELETE', '/api/me', { token: hal, body: { password: 'wrong' } })).status, 403)
    assert.equal((await call('DELETE', '/api/me', { token: hal, body: { password: 'hal-password-1' } })).status, 204)
    assert.equal((await call('GET', '/api/me', { token: hal })).status, 401)
    const [{ n }] = await sql`select count(*)::int as n from users where email = 'hal@example.com'`
    assert.equal(n, 0)
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'hal@example.com', password: 'hal-password-1' } })).status, 401)
  })

  test('oversized bodies get 413', async () => {
    const ivy = await signup('ivy@example.com')
    const big = 'x'.repeat(3 * 1024 * 1024)
    assert.equal((await call('POST', '/api/ai-runs', { token: ivy, body: { task: 'jd_breakdown', provider: 'claude', prompt_text: big } })).status, 413)
  })
})

describe('local-first: Cloud sync is opt-in per account', () => {
  test('a new account has sync off and the API holds none of its data', async () => {
    const kim = await signup('kim@example.com', 'kim-password-1', { cloud: false })
    const session = await call('GET', '/api/auth/session', { token: kim })
    assert.equal(session.body.user.cloud_sync, false)
    assert.equal((await call('GET', '/api/me', { token: kim })).status, 200, 'account routes still work')

    for (const [method, path, body] of [
      ['GET', '/api/applications'], ['GET', '/api/resumes'], ['GET', '/api/export'],
      ['POST', '/api/applications', { company: { name: 'X' }, application: { role: 'r' } }],
      ['POST', '/api/portal-events', [{ type: 'sync' }]],
      ['POST', '/api/portal-ingest', { provider: 'greenhouse', event_type: 'sync' }],
      ['PUT', '/api/ai-keys/claude', { secret: 'sk' }],
    ] as const) {
      const res = await call(method, path, { token: kim, body })
      assert.equal(res.status, 409, `${method} ${path}`)
      assert.equal(res.body.code, 'cloud_off')
    }
    const [{ n }] = await sql`select count(*)::int as n from portal_events e join users u on u.id = e.user_id where u.email = 'kim@example.com'`
    assert.equal(n, 0)
  })

  test('enable uploads the device snapshot and turns sync on atomically', async () => {
    const lee = await signup('lee@example.com', 'lee-password-1', { cloud: false })
    const bad = await call('POST', '/api/cloud/enable', { token: lee, body: { format: 'nope' } })
    assert.equal(bad.status, 400)
    assert.equal((await call('GET', '/api/auth/session', { token: lee })).body.user.cloud_sync, false, 'failed upload leaves sync off')

    const snap = { ...EMPTY_SNAPSHOT, companies: [{ id: crypto.randomUUID(), name: 'Stripe' }] }
    const app = { id: crypto.randomUUID(), company_id: snap.companies[0].id, role: 'PM' }
    const on = await call('POST', '/api/cloud/enable', { token: lee, body: { ...snap, applications: [app] } })
    assert.equal(on.status, 200, JSON.stringify(on.body))
    assert.equal(on.body.uploaded.applications, 1)
    assert.equal((await call('GET', '/api/auth/session', { token: lee })).body.user.cloud_sync, true)
    assert.deepEqual((await call('GET', '/api/applications', { token: lee })).body.map((a: any) => a.id), [app.id])
  })

  test('disable deletes the Cloud copy but keeps the account', async () => {
    const mo = await signup('mo@example.com', 'mo-password-1')
    await call('POST', '/api/applications', { token: mo, body: { company: { name: 'Figma' }, application: { role: 'Designer' } } })
    await call('POST', '/api/resumes', { token: mo, body: { name: 'CV', set_current: true } })
    await call('POST', '/api/portal-events', { token: mo, body: [{ type: 'sync' }] })
    await call('PUT', '/api/ai-keys/claude', { token: mo, body: { secret: 'sk-ant' } })

    assert.equal((await call('POST', '/api/cloud/disable', { token: mo, body: { password: 'nope' } })).status, 403)
    assert.equal((await call('GET', '/api/applications', { token: mo })).body.length, 1, 'wrong password changes nothing')

    const off = await call('POST', '/api/cloud/disable', { token: mo, body: { password: 'mo-password-1' } })
    assert.equal(off.status, 200)
    const [{ id }] = await sql`select id from users where email = 'mo@example.com'`
    for (const table of ['companies', 'applications', 'resumes', 'portal_events', 'portal_connections', 'ai_runs', 'ai_provider_keys']) {
      const [{ n }] = await sql`select count(*)::int as n from ${sql(table)} where user_id = ${id}`
      assert.equal(n, 0, table)
    }
    assert.equal((await call('GET', '/api/applications', { token: mo })).status, 409)
    const login = await call('POST', '/api/auth/login', { body: { email: 'mo@example.com', password: 'mo-password-1' } })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.cloud_sync, false)
  })
})

describe('observation processing storage (Cloud)', () => {
  const lead = (over: Record<string, unknown> = {}) => ({
    fingerprint: 'greenhouse:111', ats_key: 'greenhouse:111', canonical_url: 'boards.greenhouse.io/acme/jobs/111',
    company_key: 'acme', title_key: 'product manager', company_name: 'Acme', title: 'Product Manager',
    job_url: 'https://boards.greenhouse.io/acme/jobs/111', location: 'Remote', description: null,
    sources: [{ connection_id: 'c', observation_id: 'o', provider: 'meta_muse', seen_at: '2026-10-09T12:00:00Z' }],
    status: 'new', application_id: null, first_seen_at: '2026-10-09T12:00:00Z', last_seen_at: '2026-10-09T12:00:00Z',
    ...over,
  })
  const suggestion = (over: Record<string, unknown> = {}) => ({
    dedupe_key: 'msg:<m1>:interview', kind: 'stage_change', state: 'pending', application_id: null, candidate_ids: [],
    company_name: 'Acme', role: 'PM', status: 'interview', proposed_stage: 'interview', previous_stage: null,
    confidence: 0.9, evidence: { source: 'gmail', subject: 'Interview' }, observation_ids: ['o1'], provider: 'meta_muse',
    resolved_at: null, ...over,
  })

  test('sync-off accounts keep these on the device', async () => {
    const off = await signup('proc-off@example.com', undefined, { cloud: false })
    for (const [method, path, body] of [
      ['GET', '/api/job-leads'], ['PUT', `/api/job-leads/${crypto.randomUUID()}`, lead()],
      ['GET', '/api/status-suggestions'], ['GET', '/api/agent-observations/pending'],
    ] as const) {
      assert.equal((await call(method, path, { token: off, body })).status, 409, `${method} ${path}`)
    }
  })

  test('leads: full upsert, patch, uniqueness per fingerprint, ownership', async () => {
    const owner = await signup('proc-leads@example.com')
    const other = await signup('proc-leads-other@example.com')
    const id = crypto.randomUUID()
    const put = await call('PUT', `/api/job-leads/${id}`, { token: owner, body: lead() })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.deepEqual(put.body.sources[0].provider, 'meta_muse')
    const merged = await call('PUT', `/api/job-leads/${id}`, { token: owner, body: lead({ sources: [...lead().sources, { connection_id: 'c2', observation_id: 'o2' }] }) })
    assert.equal(merged.body.sources.length, 2)

    assert.equal((await call('PUT', `/api/job-leads/${crypto.randomUUID()}`, { token: owner, body: lead() })).status, 409, 'same fingerprint, new id')
    assert.equal((await call('PUT', `/api/job-leads/${id}`, { token: other, body: lead() })).status, 404, "can't overwrite another user's lead")
    assert.equal((await call('PUT', `/api/job-leads/${crypto.randomUUID()}`, { token: owner, body: lead({ fingerprint: 'x', status: 'bogus' }) })).status, 400)

    const app = await call('POST', '/api/applications', { token: owner, body: { company: { name: 'Acme' }, application: { role: 'PM' } } })
    const patched = await call('PATCH', `/api/job-leads/${id}`, { token: owner, body: { status: 'saved', application_id: app.body.id } })
    assert.equal(patched.body.status, 'saved')
    assert.equal(patched.body.application_id, app.body.id)
    const foreignApp = await call('POST', '/api/applications', { token: other, body: { company: { name: 'X' }, application: { role: 'r' } } })
    assert.equal((await call('PATCH', `/api/job-leads/${id}`, { token: owner, body: { application_id: foreignApp.body.id } })).status, 400, 'composite FK')
    assert.deepEqual((await call('GET', '/api/job-leads', { token: other })).body, [])
    assert.equal((await call('GET', '/api/job-leads', { token: owner })).body.length, 1)
  })

  test('suggestions: upsert, resolve, one per dedupe key', async () => {
    const owner = await signup('proc-sugg@example.com')
    const id = crypto.randomUUID()
    const put = await call('PUT', `/api/status-suggestions/${id}`, { token: owner, body: suggestion() })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.proposed_stage, 'interview')
    assert.equal((await call('PUT', `/api/status-suggestions/${crypto.randomUUID()}`, { token: owner, body: suggestion() })).status, 409)
    assert.equal((await call('PUT', `/api/status-suggestions/${crypto.randomUUID()}`, { token: owner, body: suggestion({ dedupe_key: 'k2', proposed_stage: 'nope' }) })).status, 400)
    const resolved = await call('PATCH', `/api/status-suggestions/${id}`, { token: owner, body: { state: 'accepted', previous_stage: 'applied', resolved_at: new Date().toISOString() } })
    assert.equal(resolved.body.state, 'accepted')
    assert.equal(resolved.body.previous_stage, 'applied')
  })

  test('processing queue: pending observations oldest first, then marked', async () => {
    const owner = await signup('proc-queue@example.com')
    const { body: { token } } = await call('POST', '/api/agent-connections', { token: owner, body: { provider: 'meta_muse', display_name: 'Muse' } })
    const send = (key: string, title: string) => call('POST', '/api/agent/observations', {
      token, headers: { 'Idempotency-Key': key },
      body: { schema_version: '0.1', run_id: 'r', observation_type: 'job_discovered', observed_at: '2026-10-09T12:00:00Z', payload: { title, company: 'Acme' } },
    })
    const a = await send('k1', 'PM')
    await send('k2', 'Designer')
    const pending = await call('GET', '/api/agent-observations/pending', { token: owner })
    assert.deepEqual(pending.body.map((o: any) => o.payload_json.payload.title), ['PM', 'Designer'])
    assert.equal(pending.body[0].provider, 'meta_muse')
    const marked = await call('PATCH', `/api/agent-observations/${a.body.observation_id}`, { token: owner, body: { processing_status: 'processed', processing_result: { lead_id: 'l1' } } })
    assert.deepEqual(marked.body.processing_result, { lead_id: 'l1' })
    assert.equal((await call('GET', '/api/agent-observations/pending', { token: owner })).body.length, 1)
    assert.equal((await call('PATCH', `/api/agent-observations/${a.body.observation_id}`, { token: owner, body: { processing_status: 'done' } })).status, 400)
  })

  test('email watching is an account preference, off until the user turns it on', async () => {
    const owner = await signup('prefs-email@example.com', undefined, { cloud: false })
    const me = (await call('GET', '/api/me', { token: owner })).body
    assert.deepEqual([me.email_watch, me.email_checked_at], [false, null])
    const on = await call('PATCH', '/api/me', { token: owner, body: { email_watch: true, email_checked_at: '2026-10-11T10:00:00Z' } })
    assert.equal(on.body.email_watch, true)
    assert.equal(Date.parse(on.body.email_checked_at), Date.parse('2026-10-11T10:00:00Z'))
    assert.equal((await call('PATCH', '/api/me', { token: owner, body: { email_checked_at: 'yesterday' } })).status, 400)
    assert.equal((await call('PATCH', '/api/me', { token: owner, body: { email_watch: 1 } })).status, 400)
  })

  test('auto_apply_updates is an account preference, on by default', async () => {
    const owner = await signup('proc-pref@example.com', undefined, { cloud: false })
    assert.equal((await call('GET', '/api/me', { token: owner })).body.auto_apply_updates, true)
    assert.equal((await call('PATCH', '/api/me', { token: owner, body: { auto_apply_updates: false } })).body.auto_apply_updates, false)
    assert.equal((await call('PATCH', '/api/me', { token: owner, body: { auto_apply_updates: 'yes' } })).status, 400)
  })

  test('leads and suggestions travel in snapshots and leave with sync off', async () => {
    const owner = await signup('proc-snap@example.com', 'proc-snap-password')
    const appId = crypto.randomUUID()
    const companyId = crypto.randomUUID()
    const snap = {
      ...EMPTY_SNAPSHOT,
      companies: [{ id: companyId, name: 'Acme' }],
      applications: [{ id: appId, company_id: companyId, role: 'PM', stage: 'applied' }],
      job_leads: [{ id: crypto.randomUUID(), ...lead({ status: 'already_applied', application_id: appId }) }, { id: crypto.randomUUID(), ...lead({ fingerprint: 'job:x', application_id: crypto.randomUUID() }) }],
      status_suggestions: [{ id: crypto.randomUUID(), ...suggestion({ application_id: appId }) }],
    }
    const up = await call('POST', '/api/sync/upload', { token: owner, body: snap })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.equal(up.body.job_leads, 2)
    assert.equal(up.body.status_suggestions, 1)
    const leads = (await call('GET', '/api/job-leads', { token: owner })).body
    assert.deepEqual(leads.map((l: any) => l.application_id).sort(), [appId, null].sort(), 'dangling app refs become null')
    assert.equal((await call('POST', '/api/sync/upload', { token: owner, body: snap })).body.job_leads, 0, 'idempotent')

    const exp = await call('GET', '/api/export', { token: owner })
    assert.equal(exp.body.job_leads.length, 2)
    assert.equal(exp.body.status_suggestions.length, 1)
    await call('POST', '/api/cloud/disable', { token: owner, body: { password: 'proc-snap-password' } })
    const [{ n }] = await sql`select (select count(*) from job_leads l join users u on u.id = l.user_id where u.email = 'proc-snap@example.com')
      + (select count(*) from status_suggestions s join users u on u.id = s.user_id where u.email = 'proc-snap@example.com') as n`
    assert.equal(Number(n), 0)
  })
})

describe('runtimes: the user\'s own computer runs local agents', () => {
  function sse(path: string, token: string) {
    const ac = new AbortController()
    const res = app.request(path, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    let buf = ''
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const decoder = new TextDecoder()
    return {
      async until(needle: string) {
        if (!reader) reader = (await res).body!.getReader()
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`stream ended before ${needle}; got: ${buf}`)
          buf += decoder.decode(value)
        }
        return buf
      },
      async status() { return (await res).status },
      close() { ac.abort(); reader?.cancel().catch(() => {}) },
    }
  }
  const jobFrom = (buf: string) => JSON.parse(buf.split('event: job\ndata: ')[1].split('\n')[0])

  test('pair → hello → online → task round-trip → revoke', async () => {
    const owner = await signup('runtime-owner@example.com', undefined, { cloud: false })
    const other = await signup('runtime-other@example.com', undefined, { cloud: false })
    const paired = await call('POST', '/api/runtimes', { token: owner, body: { name: 'MacBook Pro' } })
    assert.equal(paired.status, 201)
    assert.match(paired.body.token, /^landed_rt_/)
    const rt = paired.body.token as string
    const id = paired.body.runtime.id as string
    assert.equal((await call('GET', '/api/applications', { token: rt })).status, 401, 'runtime token is not a session')

    const hello = await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', version: '2.1.284' }], daemon_version: '0.1.0' } })
    assert.equal(hello.status, 200)
    assert.deepEqual(hello.body.agents, [{ id: 'claude', label: 'Claude Code', version: '2.1.284', kinds: ['chat'], mail: null, browser: null }], 'old daemons can only chat')

    const send = (token: string, body: Record<string, unknown>) => call('POST', '/api/runtime-jobs', { token, body })
    const chat = { runtime_id: id, agent: 'claude', kind: 'chat', input: { conversation_id: crypto.randomUUID(), message: 'hi' } }
    const offline = await send(owner, chat)
    assert.equal(offline.status, 409)
    assert.equal(offline.body.code, 'runtime_offline')

    const daemon = sse('/api/runtime/stream', rt)
    await daemon.until('event: ready')
    assert.equal((await call('GET', '/api/runtimes', { token: owner })).body[0].online, true)
    assert.equal((await send(owner, { ...chat, agent: 'codex' })).status, 400, 'agent not installed there')
    assert.equal((await send(other, chat)).status, 404, "can't use someone else's computer")

    const started = await send(owner, chat)
    assert.equal(started.status, 202)
    const job = jobFrom(await daemon.until('event: job'))
    assert.deepEqual([job.id, job.agent, job.kind, job.input.message], [started.body.job_id, 'claude', 'chat', 'hi'])
    assert.equal(job.user_id, undefined, 'daemon never sees user ids')

    // the daemon streams output back; the web replays + follows it
    await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'started', agent: 'claude' }, { type: 'delta', text: 'po' }] } })
    const web = sse(`/api/runtime-jobs/${job.id}/stream`, owner)
    await web.until('"text":"po"')
    await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'delta', text: 'ng' }, { type: 'done', text: 'pong', session_id: 's1' }] } })
    const out = await web.until('"type":"done"')
    assert.ok(out.includes('"text":"ng"'))
    web.close()

    assert.equal((await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'delta', text: 'late' }] } })).status, 404, 'finished')
    const snoop = sse(`/api/runtime-jobs/${job.id}/stream`, other)
    assert.ok((await snoop.until('Task not found')).includes('error'))
    snoop.close()

    // revoking cuts the daemon off and kills its token
    const revoked = await call('POST', `/api/runtimes/${id}/revoke`, { token: owner })
    assert.equal(revoked.body.online, false)
    await assert.rejects(daemon.until('never'), /stream ended/)
    assert.equal((await call('POST', '/api/runtime/hello', { token: rt, body: {} })).status, 401)
    daemon.close()
  })

  test('abandoned pairings (command never run) are cleared on the next pairing', async () => {
    const owner = await signup('runtime-stale@example.com', undefined, { cloud: false })
    const stale = await call('POST', '/api/runtimes', { token: owner, body: { name: 'old attempt' } })
    const used = await call('POST', '/api/runtimes', { token: owner, body: { name: 'connected' } })
    await call('POST', '/api/runtime/hello', { token: used.body.token, body: { agents: [{ id: 'claude' }] } })
    await sql`update runtimes set created_at = now() - interval '1 hour' where id in (${stale.body.runtime.id}, ${used.body.runtime.id})`
    await call('POST', '/api/runtimes', { token: owner, body: { name: 'new attempt' } })
    const names = (await call('GET', '/api/runtimes', { token: owner })).body.map((r: any) => r.name).sort()
    assert.deepEqual(names, ['connected', 'new attempt'])
  })

  test('a daemon dropping mid-task fails the task instead of hanging', async () => {
    const owner = await signup('runtime-drop@example.com', undefined, { cloud: false })
    const { body: { token: rt, runtime } } = await call('POST', '/api/runtimes', { token: owner, body: {} })
    await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude' }] } })
    const daemon = sse('/api/runtime/stream', rt)
    await daemon.until('event: ready')
    const { body: { job_id } } = await call('POST', '/api/runtime-jobs', { token: owner, body: { runtime_id: runtime.id, agent: 'claude', kind: 'chat', input: { conversation_id: crypto.randomUUID(), message: 'hi' } } })
    await daemon.until('event: job')
    const web = sse(`/api/runtime-jobs/${job_id}/stream`, owner)
    daemon.close()
    assert.ok((await web.until('"type":"error"')).includes('disconnected'))
    web.close()
  })

  test('job_search: validated brief in, cleaned jobs out; old daemons are told to update', async () => {
    const owner = await signup('runtime-search@example.com', undefined, { cloud: false })
    const { body: { token: rt, runtime } } = await call('POST', '/api/runtimes', { token: owner, body: {} })
    const brief = { summary: 'AI PM new grad in the US', roles: ['AI Product Manager', '  '], locations: ['United States'], needs_sponsorship: true, remote: 'sideways', evil: 'rm -rf /' }
    const search = { runtime_id: runtime.id, agent: 'claude', kind: 'job_search', input: { brief, search_id: crypto.randomUUID(), extra: 'dropped' } }

    await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code' }] } })
    const daemon = sse('/api/runtime/stream', rt)
    await daemon.until('event: ready')
    const outdated = await call('POST', '/api/runtime-jobs', { token: owner, body: search })
    assert.equal(outdated.status, 409)
    assert.equal(outdated.body.code, 'runtime_outdated')

    await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', kinds: ['chat', 'job_search', 'shell'] }] } })
    assert.deepEqual((await call('GET', '/api/runtimes', { token: owner })).body[0].agents[0].kinds, ['chat', 'job_search'], 'unknown kinds dropped')
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: { ...search, input: { ...search.input, brief: { roles: [] } } } })).status, 400)
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: { ...search, kind: 'shell' } })).status, 400)

    const started = await call('POST', '/api/runtime-jobs', { token: owner, body: search })
    assert.equal(started.status, 202)
    const job = jobFrom(await daemon.until('event: job'))
    assert.deepEqual(Object.keys(job.input).sort(), ['brief', 'search_id'])
    assert.deepEqual(job.input.brief.roles, ['AI Product Manager'])
    assert.equal(job.input.brief.remote, 'any')
    assert.equal(job.input.brief.evil, undefined)

    const web = sse(`/api/runtime-jobs/${job.id}/stream`, owner)
    await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'done', text: 'Found 1', jobs: [
      { company: 'Acme AI', title: 'Associate PM', job_url: 'https://jobs.ashbyhq.com/acme/123', location: 'SF' },
      { company: 'Nope', title: 'PM', job_url: 'javascript:alert(1)' },
      { company: 'No title' },
    ] }] } })
    const done = JSON.parse((await web.until('"type":"done"')).split('data: ').pop()!.split('\n')[0])
    assert.equal(done.jobs.length, 2)
    assert.equal(done.jobs[0].job_url, 'https://jobs.ashbyhq.com/acme/123')
    assert.equal(done.jobs[1].job_url, null, 'non-http link dropped')
    web.close()
    daemon.close()
  })
})

describe('email_check: the user\'s agent reads their mailbox', () => {
  function sse(path: string, token: string) {
    const ac = new AbortController()
    const res = app.request(path, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    let buf = ''
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const decoder = new TextDecoder()
    return {
      async until(needle: string) {
        if (!reader) reader = (await res).body!.getReader()
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`stream ended before ${needle}; got: ${buf}`)
          buf += decoder.decode(value)
        }
        return buf
      },
      close() { ac.abort(); reader?.cancel().catch(() => {}) },
    }
  }

  test('only agents with a mailbox get it; input is minimal and bounded; findings are cleaned', async () => {
    const owner = await signup('runtime-email@example.com', undefined, { cloud: false })
    const { body: { token: rt, runtime } } = await call('POST', '/api/runtimes', { token: owner, body: {} })
    await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', kinds: ['chat', 'job_search'], mail: null }] } })
    const daemon = sse('/api/runtime/stream', rt)
    await daemon.until('event: ready')
    const check = {
      runtime_id: runtime.id, agent: 'claude', kind: 'email_check',
      input: { since: '2020-01-01T00:00:00Z', applications: [{ company: 'Figma', role: 'APM', stage: 'applied', notes: 'private', id: 'x' }, { company: 'Bad', role: 'r', stage: 'nope' }] },
    }
    const noMail = await call('POST', '/api/runtime-jobs', { token: owner, body: check })
    assert.equal(noMail.body.code, 'runtime_outdated', 'no mailbox → kind not offered')

    const hello = await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', kinds: ['chat', 'job_search', 'email_check'], mail: 'Gmail' }] } })
    assert.equal(hello.body.agents[0].mail, 'Gmail')
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: { ...check, input: { since: 'last week' } } })).status, 400)
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: check })).status, 202)
    const job = JSON.parse((await daemon.until('event: job')).split('event: job\ndata: ')[1].split('\n')[0])
    assert.deepEqual(job.input.applications, [{ company: 'Figma', role: 'APM', stage: 'applied' }], 'no notes or ids leave the browser')
    assert.ok(Date.parse(job.input.since) > Date.parse('2026-01-01'), 'look-back is clamped')

    const web = sse(`/api/runtime-jobs/${job.id}/stream`, owner)
    await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'done', text: '2 updates', findings: [
      { company: 'Figma', role: 'APM', status: 'assessment', confidence: 3, evidence: { message_id: 'm1', subject: 'Your Figma OA', received_at: '2026-10-10T09:00:00Z' } },
      { company: 'Nope', status: 'promoted' },
    ] }] } })
    const done = JSON.parse((await web.until('"type":"done"')).split('data: ').pop()!.split('\n')[0])
    assert.equal(done.findings.length, 1)
    assert.equal(done.findings[0].confidence, 1, 'clamped')
    assert.equal(done.findings[0].evidence.received_at, '2026-10-10T09:00:00.000Z')
    web.close()
    daemon.close()
  })
})

describe('pipeline: one interview stage with rounds', () => {
  test('legacy phone/onsite are normalized; rounds are validated; the migration moved old rows', async () => {
    const owner = await signup('pipeline@example.com')
    const add = (application: Record<string, unknown>) => call('POST', '/api/applications', { token: owner, body: { company: { name: 'Acme' }, application } })
    const phone = await add({ role: 'PM', stage: 'phone' })
    assert.equal(phone.status, 201, JSON.stringify(phone.body))
    assert.equal(phone.body.stage, 'interview')
    assert.deepEqual(phone.body.interviews, [{ round: null, format: 'remote', interviewers: [], at: null, note: null }])
    assert.equal((await add({ role: 'APM', stage: 'hired' })).status, 400)

    const plain = await add({ role: 'APM', stage: 'applied' })
    assert.deepEqual(plain.body.interviews, [])
    const tagged = await call('PATCH', `/api/applications/${plain.body.id}`, { token: owner, body: {
      stage: 'interview', interviews: [{ round: 4, format: 'remote', interviewers: ['leader', 'ceo', 'hr'] }, 'junk'],
    } })
    assert.deepEqual(tagged.body.interviews, [{ round: 4, format: 'remote', interviewers: ['leader', 'hr'], at: null, note: null }])
    assert.equal((await call('PATCH', `/api/applications/${plain.body.id}`, { token: owner, body: { interviews: 'many' } })).status, 400)
    assert.equal((await call('PATCH', `/api/applications/${plain.body.id}`, { token: owner, body: { stage: 'onsite' } })).body.stage, 'interview')

    // 0011 moved rows written before the interview stage existed
    const [old] = await sql`insert into applications (user_id, company_id, role, stage) values (${phone.body.user_id}, ${phone.body.company_id}, 'Legacy', 'onsite') returning id`
    const migration = (await import('node:fs')).readFileSync(new URL('../migrations/0011_interview_rounds.sql', import.meta.url), 'utf8')
    await sql.unsafe(migration.replace(/alter table applications add column interviews[^;]*;/, ''))
    const [row] = await sql`select stage, interviews from applications where id = ${old.id}`
    assert.equal(row.stage, 'interview')
    assert.equal(row.interviews[0].format, 'onsite')
  })
})

describe('portal_check: read-only look at candidate portals', () => {
  test('only agents with a browser get it; at most 5 http(s) items; results are cleaned', async () => {
    const owner = await signup('runtime-portal@example.com', undefined, { cloud: false })
    const { body: { token: rt, runtime } } = await call('POST', '/api/runtimes', { token: owner, body: {} })
    await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', kinds: ['chat'], browser: null }] } })
    const item = (ref: string, url = 'https://acme.wd5.myworkdayjobs.com/acme/job/123') => ({ ref, company: 'Acme', role: 'APM', stage: 'applied', url })
    const check = { runtime_id: runtime.id, agent: 'claude', kind: 'portal_check', input: { items: [item('1')] } }
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: check })).body.code, 'runtime_outdated', 'no browser → kind not offered')

    const hello = await call('POST', '/api/runtime/hello', { token: rt, body: { agents: [{ id: 'claude', label: 'Claude Code', kinds: ['chat', 'portal_check'], browser: 'Chrome' }] } })
    assert.equal(hello.body.agents[0].browser, 'Chrome')
    const daemonAbort = new AbortController()
    const daemon = await app.request('/api/runtime/stream', { headers: { Authorization: `Bearer ${rt}` }, signal: daemonAbort.signal })
    const reader = daemon.body!.getReader()
    let buf = ''
    const until = async (needle: string) => {
      while (!buf.includes(needle)) buf += new TextDecoder().decode((await reader.read()).value)
      return buf
    }
    await until('event: ready')
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: { ...check, input: { items: [item('1', 'javascript:alert(1)')] } } })).status, 400)
    const many = { ...check, input: { items: [1, 2, 3, 4, 5, 6, 7].map((n) => item(String(n))) } }
    assert.equal((await call('POST', '/api/runtime-jobs', { token: owner, body: many })).status, 202)
    const job = JSON.parse((await until('event: job')).split('event: job\ndata: ')[1].split('\n')[0])
    assert.equal(job.input.items.length, 5, 'capped at 5')

    const res = await call('POST', `/api/runtime/jobs/${job.id}/events`, { token: rt, body: { events: [{ type: 'done', text: 'checked', results: [
      { ref: '1', outcome: 'status_found', status: 'rejected', status_text: 'No longer under consideration', confidence: 0.9 },
      { ref: '2', outcome: 'status_found', status: 'promoted' },
      { ref: '3', outcome: 'hacked' },
    ] }] } })
    assert.equal(res.status, 200)
    reader.cancel().catch(() => {})
    daemonAbort.abort()
  })
})

describe('job searches (Cloud)', () => {
  const brief = { summary: 'AI PM, US', roles: ['AI Product Manager'], locations: ['United States'], needs_sponsorship: true }

  test('sync-off accounts keep searches on the device', async () => {
    const off = await signup('search-off@example.com', undefined, { cloud: false })
    assert.equal((await call('GET', '/api/job-searches', { token: off })).status, 409)
    assert.equal((await call('POST', '/api/job-searches', { token: off, body: { brief } })).status, 409)
  })

  test('confirming a brief archives the previous one; runs are recorded; ownership', async () => {
    const owner = await signup('search-owner@example.com')
    const other = await signup('search-other@example.com')
    assert.equal((await call('POST', '/api/job-searches', { token: owner, body: { brief: { roles: [] } } })).status, 400)

    const first = await call('POST', '/api/job-searches', { token: owner, body: { brief } })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.status, 'active')
    assert.equal(first.body.brief.remote, 'any', 'brief is normalized')
    const second = await call('POST', '/api/job-searches', { token: owner, body: { brief: { ...brief, roles: ['APM'] } } })
    const list = (await call('GET', '/api/job-searches', { token: owner })).body
    assert.deepEqual(list.map((s: any) => [s.id, s.status]), [[second.body.id, 'active'], [first.body.id, 'archived']])

    const ran = await call('PATCH', `/api/job-searches/${second.body.id}`, { token: owner, body: { last_run_at: '2026-10-11T10:00:00Z', last_run_result: { found: 12, added: 9 } } })
    assert.equal(ran.status, 200)
    assert.deepEqual(ran.body.last_run_result, { found: 12, added: 9 })
    assert.equal((await call('PATCH', `/api/job-searches/${second.body.id}`, { token: owner, body: { status: 'paused' } })).status, 400)
    assert.equal((await call('PATCH', `/api/job-searches/${second.body.id}`, { token: other, body: { status: 'archived' } })).status, 404)
    assert.equal((await call('GET', '/api/job-searches', { token: other })).body.length, 0)

    // snapshots carry searches; an uploaded active one yields to the current one
    const snap = (await call('GET', '/api/export', { token: owner })).body
    assert.equal(snap.job_searches.length, 2)
    const fresh = await signup('search-fresh@example.com')
    await call('POST', '/api/job-searches', { token: fresh, body: { brief } })
    // (as from a device: ids are the device's own)
    const device = { ...snap, job_searches: snap.job_searches.map((s: any) => ({ ...s, id: crypto.randomUUID() })) }
    const up = await call('POST', '/api/sync/upload', { token: fresh, body: device })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.equal(up.body.job_searches, 2)
    const statuses = (await call('GET', '/api/job-searches', { token: fresh })).body.map((s: any) => s.status).sort()
    assert.deepEqual(statuses, ['active', 'archived', 'archived'])
  })
})
