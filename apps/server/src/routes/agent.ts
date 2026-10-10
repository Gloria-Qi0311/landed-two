// Vendor-neutral inbox for observations from personal agents.
//
// Two route groups deliberately use different credentials:
//   - account routes use a normal Landed session to create/revoke connections
//     and review observations;
//   - ingest routes accept only a narrow, hashed agent token.
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

const SCHEMA_VERSION = '0.1'
const OBSERVATION_TYPES = new Set(['job_discovered', 'application_status', 'sync_error'])
const DEFAULT_SCOPES = ['observations:write']
const MAX_TEXT = 200

// Request bodies are validated field-by-field before persistence. The sql
// helper's JSON type is intentionally broader than Record<string, unknown>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function requiredText(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim()) fail(400, `${name} is required`)
  if (value.length > max) fail(400, `${name} is too long (max ${max})`)
  return value
}

function readBearer(header: string | undefined): string {
  if (!header?.toLowerCase().startsWith('bearer ')) fail(401, 'agent token required')
  const token = header.slice(7).trim()
  if (!token) fail(401, 'agent token required')
  return token
}

function validateObservation(raw: Row, headerKey: string | undefined) {
  const schemaVersion = requiredText(raw.schema_version, 'schema_version', 20)
  if (schemaVersion !== SCHEMA_VERSION) fail(400, `unsupported schema_version (expected ${SCHEMA_VERSION})`)
  const runId = requiredText(raw.run_id, 'run_id')
  const observationType = requiredText(raw.observation_type, 'observation_type', 80)
  if (!OBSERVATION_TYPES.has(observationType)) {
    fail(400, `unsupported observation_type: ${observationType}`)
  }
  const observedAt = requiredText(raw.observed_at, 'observed_at', 80)
  if (!Number.isFinite(Date.parse(observedAt))) fail(400, 'observed_at must be an ISO timestamp')
  const idempotencyKey = requiredText(headerKey ?? raw.idempotency_key, 'Idempotency-Key')
  return { schemaVersion, runId, observationType, observedAt, idempotencyKey }
}

export function agentAccountRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/agent-connections', async (c) => {
    return c.json(await sql`
      select id, provider, display_name, scopes, last_seen_at, revoked_at, created_at
      from agent_connections where user_id = ${c.get('user').id}
      order by created_at desc`)
  })

  app.post('/agent-connections', async (c) => {
    const body = await jsonBody<Row>(c)
    const provider = requiredText(body.provider, 'provider', 80)
    const displayName = requiredText(body.display_name, 'display_name', 120)
    const token = `landed_agent_${randomBytes(32).toString('base64url')}`
    const [row] = await sql`
      insert into agent_connections (user_id, provider, display_name, token_hash, scopes)
      values (${c.get('user').id}, ${provider}, ${displayName}, ${sha256(token)}, ${DEFAULT_SCOPES})
      returning id, provider, display_name, scopes, last_seen_at, revoked_at, created_at`
    return c.json({ connection: row, token }, 201)
  })

  app.get('/agent-observations', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500)
    return c.json(await sql`
      select o.*, c.provider, c.display_name
      from agent_observations o
      join agent_connections c on c.id = o.connection_id and c.user_id = o.user_id
      where o.user_id = ${c.get('user').id}
      order by o.created_at desc limit ${limit}`)
  })

  return app
}

export function agentIngestRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.post('/observations', async (c) => {
    const token = readBearer(c.req.header('Authorization'))
    const [connection] = await sql<{
      id: string
      user_id: string
      scopes: string[]
      revoked_at: string | null
    }[]>`
      select id, user_id, scopes, revoked_at
      from agent_connections where token_hash = ${sha256(token)}`
    if (!connection || connection.revoked_at) fail(401, 'invalid or revoked agent token')
    if (!connection.scopes.includes('observations:write')) fail(403, 'token lacks observations:write scope')

    const raw = await jsonBody<Row>(c)
    const parsed = validateObservation(raw, c.req.header('Idempotency-Key'))
    const inserted = await sql<{ id: string; created_at: string }[]>`
      insert into agent_observations (
        user_id, connection_id, idempotency_key, schema_version, run_id,
        observation_type, payload_json, observed_at
      ) values (
        ${connection.user_id}, ${connection.id}, ${parsed.idempotencyKey},
        ${parsed.schemaVersion}, ${parsed.runId}, ${parsed.observationType},
        ${sql.json(raw)}, ${parsed.observedAt}
      )
      on conflict (connection_id, idempotency_key) do nothing
      returning id, created_at`

    await sql`update agent_connections set last_seen_at = now() where id = ${connection.id}`

    if (inserted[0]) {
      return c.json({
        accepted: true,
        duplicate: false,
        observation_id: inserted[0].id,
        created_at: inserted[0].created_at,
      }, 201)
    }

    const [existing] = await sql<{ id: string; created_at: string; same_payload: boolean }[]>`
      select id, created_at, payload_json = ${sql.json(raw)} as same_payload
      from agent_observations
      where connection_id = ${connection.id} and idempotency_key = ${parsed.idempotencyKey}`
    if (!existing.same_payload) {
      fail(409, 'Idempotency-Key was already used with a different payload', {
        observation_id: existing.id,
      })
    }
    return c.json({
      accepted: true,
      duplicate: true,
      observation_id: existing.id,
      created_at: existing.created_at,
    })
  })

  return app
}
