// Cloud agents: OAuth (dynamic registration + PKCE + refresh) and the MCP
// server, end to end against a real Postgres. Wipes and re-migrates the
// database at TEST_DATABASE_URL (default: local landed_test).
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { connect, type Sql } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { PortalEventsHub } from '../src/realtime.ts'
import { RuntimeHub } from '../src/runtime-hub.ts'

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/landed_test'
const config: Config = {
  databaseUrl: DB_URL, host: '127.0.0.1', port: 0, secretsKey: randomBytes(32), cookieSecure: false, signup: 'open', webDist: null,
}

let sql: Sql
let hub: PortalEventsHub
let app: ReturnType<typeof createApp>

type Res = { status: number; body: any; headers: Headers }

async function call(method: string, path: string, opts: { token?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers }
  let body: string | undefined
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(path, { method, headers, body })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

async function signup(email: string): Promise<string> {
  const res = await call('POST', '/api/auth/signup', { body: { email, password: 'correct horse battery', mode: 'token' } })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.token
}

const REDIRECT = 'https://agent.example/oauth/callback'
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/oauth/register', { body: { client_name: 'Test Agent', redirect_uris: [REDIRECT], ...extra } })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body as { client_id: string; client_secret?: string }
}

/** The consent page's approve call → the code in the redirect. */
async function authorize(session: string, clientId: string, challenge: string) {
  const res = await call('POST', '/api/oauth/approve', {
    token: session,
    body: { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', decision: 'allow' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const url = new URL(res.body.redirect)
  assert.equal(url.origin + url.pathname, REDIRECT)
  assert.equal(url.searchParams.get('state'), 'xyz')
  assert.equal(url.searchParams.get('iss'), 'http://localhost')
  return url.searchParams.get('code')!
}

async function connectAgent(session: string) {
  const client = await register()
  const { verifier, challenge } = pkce()
  const code = await authorize(session, client.client_id, challenge)
  const res = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { client, access: res.body.access_token as string, refresh: res.body.refresh_token as string }
}

let rpcId = 1
async function rpc(token: string, method: string, params?: unknown) {
  return call('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) } })
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.result as { content: { text: string }[]; structuredContent?: any; isError?: boolean }
}

before(async () => {
  sql = connect(DB_URL)
  await sql.unsafe('drop schema public cascade; create schema public;')
  await migrate(sql)
  hub = new PortalEventsHub(sql)
  await hub.start()
  app = createApp(sql, config, hub, new RuntimeHub())
})

after(async () => {
  await hub.stop()
  await sql.end()
})

describe('discovery', () => {
  test('metadata points clients at the authorization server and the consent page', async () => {
    const pr = await call('GET', '/.well-known/oauth-protected-resource/mcp')
    assert.equal(pr.status, 200)
    assert.equal(pr.body.resource, 'http://localhost/mcp')
    assert.deepEqual(pr.body.authorization_servers, ['http://localhost'])
    const as = await call('GET', '/.well-known/oauth-authorization-server')
    assert.equal(as.body.authorization_endpoint, 'http://localhost/authorize-agent')
    assert.equal(as.body.token_endpoint, 'http://localhost/oauth/token')
    assert.equal(as.body.registration_endpoint, 'http://localhost/oauth/register')
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256'])
    // Behind a proxy, the public origin comes from X-Forwarded-*.
    const proxied = await call('GET', '/.well-known/oauth-authorization-server', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'landed.example.com' } })
    assert.equal(proxied.body.issuer, 'https://landed.example.com')
  })

  test('/mcp without a token: 401 that says where to authorize', async () => {
    const res = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/)
    const bad = await call('POST', '/mcp', { token: 'landed_mcp_nope', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })
    assert.equal(bad.status, 401)
  })
})

describe('authorization', () => {
  test('registration: https redirects (or http on localhost) only', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'myapp://cb', 'https://x.example/cb#frag']) {
      const res = await call('POST', '/oauth/register', { body: { client_name: 'x', redirect_uris: [uri] } })
      assert.equal(res.status, 400, uri)
      assert.equal(res.body.error, 'invalid_redirect_uri')
    }
    const local = await call('POST', '/oauth/register', { body: { redirect_uris: ['http://localhost:33418/callback'] } })
    assert.equal(local.status, 201)
    assert.equal(local.body.client_name, 'AI agent')
    assert.equal(local.body.token_endpoint_auth_method, 'none')
    assert.equal(local.body.client_secret, undefined)
  })

  test('consent: checks the client, the redirect and PKCE; deny goes back with access_denied', async () => {
    const session = await signup('consent@example.com')
    const client = await register()
    const { challenge } = pkce()
    const q = (extra: Record<string, string> = {}) => new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', ...extra })
    const info = await call('GET', `/api/oauth/authorize-info?${q()}`, { token: session })
    assert.deepEqual(info.body, { client_name: 'Test Agent', redirect_host: 'agent.example' })
    assert.equal((await call('GET', `/api/oauth/authorize-info?${q({ redirect_uri: 'https://evil.example/cb' })}`, { token: session })).status, 400)
    assert.equal((await call('GET', `/api/oauth/authorize-info?${q({ code_challenge_method: 'plain' })}`, { token: session })).status, 400)
    assert.equal((await call('GET', `/api/oauth/authorize-info?${q()}`)).status, 401) // signed-in only

    const denied = await call('POST', '/api/oauth/approve', { token: session, body: { ...Object.fromEntries(q()), state: 's', decision: 'deny' } })
    const url = new URL(denied.body.redirect)
    assert.equal(url.searchParams.get('error'), 'access_denied')
    assert.equal(url.searchParams.get('code'), null)
  })

  test('code exchange: PKCE must match, and a code works once', async () => {
    const session = await signup('pkce@example.com')
    const client = await register()
    const { verifier, challenge } = pkce()
    const code = await authorize(session, client.client_id, challenge)
    const wrong = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id } })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error, 'invalid_grant')
    const reused = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id } })
    assert.equal(reused.body.error, 'invalid_grant') // the failed attempt used it up

    const code2 = await authorize(session, client.client_id, challenge)
    const other = await register()
    const stolen = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: other.client_id } })
    assert.equal(stolen.body.error, 'invalid_grant') // another client can't use it
  })

  test('confidential clients must send their secret', async () => {
    const session = await signup('secret@example.com')
    const client = await register({ token_endpoint_auth_method: 'client_secret_basic' })
    assert.match(client.client_secret!, /^landed_secret_/)
    const { verifier, challenge } = pkce()
    const code = await authorize(session, client.client_id, challenge)
    const noSecret = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id } })
    assert.equal(noSecret.status, 401)
    assert.equal(noSecret.body.error, 'invalid_client')
    const code2 = await authorize(session, client.client_id, challenge)
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
    const ok = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: code2, code_verifier: verifier }, headers: { Authorization: `Basic ${basic}` } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
  })
})

describe('MCP', () => {
  test('a connected agent gets tasks and hands results back through the relay', async () => {
    const session = await signup('mcp@example.com')
    const { access } = await connectAgent(session)

    const init = await rpc(access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.body.result.protocolVersion, '2025-06-18')
    assert.equal(init.body.result.serverInfo.name, 'landed')
    const note = await call('POST', '/mcp', { token: access, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    assert.equal(note.status, 202)
    const tools = await rpc(access, 'tools/list')
    assert.deepEqual(tools.body.result.tools.map((t: { name: string }) => t.name), ['get_tasks', 'submit_jobs', 'submit_email_updates', 'submit_application_result'])
    assert.equal((await rpc(access, 'nope/method')).body.error.code, -32601)

    // No automation on yet; then on, but nothing shared yet.
    let tasks = await tool(access, 'get_tasks')
    assert.deepEqual(tasks.structuredContent.tasks, [])
    assert.match(tasks.structuredContent.note, /Workflow page/)
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true } } } })
    tasks = await tool(access, 'get_tasks')
    assert.deepEqual(tasks.structuredContent.tasks, [])
    assert.match(tasks.structuredContent.note, /open Landed/)

    // The browser shares the briefing; the user turns email checks on.
    const shared = await call('PUT', '/api/agent-briefing', {
      token: session,
      body: { brief: { summary: 'Backend roles in Seattle', roles: ['Backend Engineer'], locations: ['Seattle, WA'] }, applications: [{ company: 'Blorp', role: 'Engineer', stage: 'applied' }, { company: '', role: 'x', stage: 'applied' }] },
    })
    assert.equal(shared.status, 200)
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true }, email_check: { enabled: true } } } })
    tasks = await tool(access, 'get_tasks')
    const [search, email] = tasks.structuredContent.tasks
    assert.equal(search.id, 'job_search')
    assert.equal(search.submit_with, 'submit_jobs')
    assert.match(search.instructions, /Backend Engineer/)
    assert.equal(email.id, 'email_check')
    assert.deepEqual(email.applications, [{ company: 'Blorp', role: 'Engineer', stage: 'applied' }])
    assert.ok(Date.now() - Date.parse(email.since) > 13 * 86_400_000) // first check looks back two weeks
    assert.ok(email.instructions.includes(`after:${Math.floor(Date.parse(email.since) / 1000)}`)) // exact, not a date
    assert.match(tasks.content[0].text, /submit with submit_jobs/)

    // Find new jobs set to search without cloud agents: only the email check is theirs.
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true, sources: { agents: ['claude'], cloud_agents: false } }, email_check: { enabled: true } } } })
    tasks = await tool(access, 'get_tasks')
    assert.deepEqual(tasks.structuredContent.tasks.map((t: { id: string }) => t.id), ['email_check'])
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true, sources: { agents: ['claude'], cloud_agents: false } }, email_check: { enabled: false } } } })
    assert.match((await tool(access, 'get_tasks')).structuredContent.note, /don't use this agent/)

    // Or leave out just this agent: it gets no search; another one would.
    const mine = (await call('GET', '/api/agent-connections', { token: session })).body.filter((c: { revoked_at: string | null }) => !c.revoked_at).map((c: { id: string }) => c.id)
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true, sources: { agents: ['claude'], cloud_skip: mine } }, email_check: { enabled: true } } } })
    assert.deepEqual((await tool(access, 'get_tasks')).structuredContent.tasks.map((t: { id: string }) => t.id), ['email_check'])
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true, sources: { agents: ['claude'], cloud_skip: ['00000000-0000-4000-8000-000000000000'] } }, email_check: { enabled: true } } } })
    assert.deepEqual((await tool(access, 'get_tasks')).structuredContent.tasks.map((t: { id: string }) => t.id), ['job_search', 'email_check'])

    // Check email can leave this agent out too.
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: false }, email_check: { enabled: true, readers: { agents: ['claude'], cloud_skip: mine } } } } })
    tasks = await tool(access, 'get_tasks')
    assert.deepEqual(tasks.structuredContent.tasks, [])
    assert.match(tasks.structuredContent.note, /don't use this agent/)
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: false }, email_check: { enabled: true, readers: { agents: [], cloud_skip: [] } } } } })
    assert.deepEqual((await tool(access, 'get_tasks')).structuredContent.tasks.map((t: { id: string }) => t.id), ['email_check'], 'no computer agent ticked: the cloud agents still read it')
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true }, email_check: { enabled: true } } } })

    // Jobs: invalid ones dropped, repeats recognized.
    const jobs = [
      { company: 'Blorp', title: 'Backend Engineer', job_url: 'https://jobs.example/blorp/1', location: 'Seattle, WA', why: 'fits', deadline: null },
      { company: '', title: 'no company' },
    ]
    let r = await tool(access, 'submit_jobs', { summary: 's', jobs })
    assert.equal(r.structuredContent.added, 1)
    r = await tool(access, 'submit_jobs', { jobs })
    assert.equal(r.structuredContent.duplicates, 1)
    assert.equal((await tool(access, 'submit_jobs', { jobs: [{ company: '' }] })).isError, true)

    // Email updates; the next check starts where this one stopped.
    const until = new Date(Date.now() - 60_000).toISOString()
    r = await tool(access, 'submit_email_updates', {
      checked_until: until,
      updates: [{ company: 'Blorp', role: 'Engineer', status: 'interview', confidence: 0.9, interview_at: '2026-11-02T10:00:00-07:00', interview_format: 'remote', evidence: { message_id: 'm-1', subject: 'Interview', received_at: '2026-10-12T09:00:00Z', sender_domain: 'blorp.example' } }],
    })
    assert.equal(r.structuredContent.added, 1, JSON.stringify(r))
    tasks = await tool(access, 'get_tasks')
    assert.equal(tasks.structuredContent.tasks[1].since, new Date(Date.parse(until) - 3_600_000).toISOString())

    // Sync-off account: the reports wait in the relay for the browser.
    const inbox = await call('GET', '/api/agent-inbox', { token: session })
    const types = inbox.body.map((o: any) => o.observation_type).sort()
    assert.deepEqual(types, ['application_status', 'job_discovered'])
    const job = inbox.body.find((o: any) => o.observation_type === 'job_discovered')
    assert.equal(job.payload_json.payload.source, 'Test Agent')
    assert.equal(job.payload_json.payload.description, 'fits')
    assert.equal(job.provider, 'mcp')
    const status = inbox.body.find((o: any) => o.observation_type === 'application_status')
    assert.equal(status.payload_json.payload.evidence.source, 'email')
    assert.equal(status.payload_json.payload.interview_at, '2026-11-02T17:00:00.000Z')
  })

  test('a selected personal agent gets one approved application, shared context and missing questions return to Landed', async () => {
    const session = await signup('personal-apply@example.com')
    const { access } = await connectAgent(session)
    const connection = (await call('GET', '/api/agent-connections', { token: session })).body.find((c: any) => !c.revoked_at)
    const taskId = randomUUID()
    const applicationId = randomUUID()
    const resumeId = randomUUID()
    const queued = await call('POST', '/api/agent-apply-tasks', {
      token: session,
      body: {
        id: taskId,
        connection_id: connection.id,
        application_id: applicationId,
        lead_id: randomUUID(),
        submit_authorized: true,
        job: { company: 'Acme', role: 'Product Manager', url: 'https://jobs.example/acme/pm', description: 'Build payments.' },
        context: {
          selected_resume: { version: 2, basic: { name: 'A Person' }, skills: ['SQL'] },
          application_answers: { work_authorized: 'yes', needs_sponsorship: 'no' },
        },
        resume: { id: randomUUID(), resume_id: resumeId, name: 'pm.pdf', data: Buffer.from('%PDF-test').toString('base64') },
      },
    })
    assert.equal(queued.status, 201, JSON.stringify(queued.body))

    const other = await call('POST', '/api/agent-connections', {
      token: session, body: { provider: 'today', display_name: 'Today' },
    })
    assert.deepEqual((await tool(other.body.token, 'get_tasks')).structuredContent.tasks, [], 'a different connected agent cannot read the task')

    let tasks = await tool(access, 'get_tasks')
    const apply = tasks.structuredContent.tasks[0]
    assert.equal(apply.id, `auto_apply:${taskId}`)
    assert.equal(apply.submit_with, 'submit_application_result')
    assert.equal(apply.submit_authorized, true)
    assert.equal(apply.context.application_answers.work_authorized, 'yes')
    assert.match(apply.resume.download_url, new RegExp(`/api/agent/apply-files/`))
    const download = await app.request(new URL(apply.resume.download_url).pathname)
    assert.equal(download.status, 200)
    assert.equal(await download.text(), '%PDF-test')

    const result = await tool(access, 'submit_application_result', {
      task_id: taskId,
      status: 'submitted',
      unanswered: [{ question: 'What is your shirt size?', key: null, options: ['S', 'M', 'L'] }],
    })
    assert.equal(result.structuredContent.status, 'blocked', 'unanswered required fields prevent submission')
    assert.equal(result.structuredContent.result.blocker, 'answers')
    tasks = await tool(access, 'get_tasks')
    assert.deepEqual(tasks.structuredContent.tasks, [])

    const waiting = await call('GET', '/api/agent-apply-tasks', { token: session })
    assert.equal(waiting.body[0].application_id, applicationId)
    assert.equal(waiting.body[0].result.unanswered[0].question, 'What is your shirt size?')
    const retried = await call('POST', `/api/agent-apply-tasks/${taskId}/retry`, {
      token: session,
      body: { application_answers: { custom: [{ question: 'What is your shirt size?', answer: 'M' }] } },
    })
    assert.equal(retried.body.status, 'pending')
    tasks = await tool(access, 'get_tasks')
    assert.equal(tasks.structuredContent.tasks[0].context.application_answers.custom[0].answer, 'M')
    const submitted = await tool(access, 'submit_application_result', { task_id: taskId, status: 'submitted' })
    assert.equal(submitted.structuredContent.status, 'submitted')
    assert.equal((await call('POST', `/api/agent-apply-tasks/${taskId}/ack`, { token: session })).status, 200)
    assert.deepEqual((await call('GET', '/api/agent-apply-tasks', { token: session })).body, [])
    assert.equal((await app.request(new URL(apply.resume.download_url).pathname)).status, 404)

    const reapproved = await call('POST', '/api/agent-apply-tasks', {
      token: session,
      body: {
        id: randomUUID(), connection_id: connection.id, application_id: applicationId,
        submit_authorized: true,
        job: { company: 'Acme', role: 'Product Manager', url: 'https://jobs.example/acme/pm', description: '' },
        context: { application_answers: {} },
      },
    })
    assert.equal(reapproved.status, 201, 'an acknowledged application can be explicitly approved again')
  })

  test('refresh rotates both tokens; disconnecting ends access and deletes the briefing', async () => {
    const session = await signup('refresh@example.com')
    const { client, access, refresh } = await connectAgent(session)
    await call('PUT', '/api/agent-briefing', { token: session, body: { brief: { roles: ['PM'] }, applications: [] } })

    const next = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id } })
    assert.equal(next.status, 200, JSON.stringify(next.body))
    assert.equal((await rpc(access, 'ping')).status, 401) // the old access token is gone
    assert.equal((await rpc(next.body.access_token, 'ping')).status, 200)
    const again = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id } })
    assert.equal(again.body.error, 'invalid_grant')

    const [conn] = (await call('GET', '/api/agent-connections', { token: session })).body
    assert.equal(conn.provider, 'mcp')
    assert.equal(conn.display_name, 'Test Agent')
    await call('POST', `/api/agent-connections/${conn.id}/revoke`, { token: session })
    assert.equal((await rpc(next.body.access_token, 'ping')).status, 401)
    assert.equal((await call('GET', '/api/agent-briefing', { token: session })).body, null)
    const refused = await call('PUT', '/api/agent-briefing', { token: session, body: { brief: null, applications: [] } })
    assert.equal(refused.status, 409) // nothing is stored without a connected cloud agent
  })

  test('personal agents (a token, no OAuth): the same tasks over MCP or plain HTTP', async () => {
    const session = await signup('tokenconn@example.com')
    const created = await call('POST', '/api/agent-connections', { token: session, body: { provider: 'meta_muse', display_name: 'Muse' } })
    const token = created.body.token
    assert.deepEqual(created.body.connection.scopes, ['observations:write', 'tasks:read'])
    await call('PUT', '/api/agent-briefing', { token: session, body: { brief: { roles: ['Product Manager'], locations: ['Remote'] }, applications: [] } })
    await call('PATCH', '/api/me', { token: session, body: { automations: { job_search: { enabled: true } } } })

    // MCP with the token as a Bearer header (Muse builds connectors from a URL + key).
    const viaMcp = await tool(token, 'get_tasks')
    assert.equal(viaMcp.structuredContent.tasks[0].id, 'job_search')

    // Plain HTTP.
    const tasks = await call('GET', '/api/agent/tasks', { token })
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body))
    assert.equal(tasks.body.tasks[0].submit_with, 'submit_jobs')
    assert.match(tasks.body.tasks[0].instructions, /Product Manager/)
    const jobs = await call('POST', '/api/agent/jobs', { token, body: { jobs: [{ company: 'Blorp', title: 'PM', job_url: 'https://jobs.example/blorp/2' }] } })
    assert.equal(jobs.status, 200)
    assert.equal(jobs.body.added, 1)
    assert.match(jobs.body.message, /1 new/)
    const bad = await call('POST', '/api/agent/jobs', { token, body: { jobs: [{ title: 'no company' }] } })
    assert.equal(bad.status, 400)
    const email = await call('POST', '/api/agent/email-updates', { token, body: { updates: [] } })
    assert.equal(email.status, 200)
    assert.equal(email.body.received, 0)
    assert.equal((await call('GET', '/api/agent/tasks')).status, 401)
    // The observations endpoint still works with the same token.
    const obs = await call('POST', '/api/agent/observations', {
      token, headers: { 'Idempotency-Key': 'k1' },
      body: { schema_version: '0.1', run_id: 'r', observation_type: 'sync_error', observed_at: '2026-10-13T12:00:00Z', payload: { message: 'hi' } },
    })
    assert.equal(obs.status, 201)

    // A connection from before tasks existed can still report, not read.
    await sql`update agent_connections set scopes = array['observations:write'] where id = ${created.body.connection.id}`
    assert.equal((await tool(token, 'get_tasks')).isError, true)
    assert.equal((await call('GET', '/api/agent/tasks', { token })).status, 403)
    assert.equal((await call('POST', '/api/agent/jobs', { token, body: { jobs: [{ company: 'Blorp', title: 'PM2', job_url: 'https://jobs.example/blorp/3' }] } })).status, 200)
  })
})
