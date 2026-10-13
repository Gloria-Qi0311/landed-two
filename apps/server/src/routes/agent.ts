// Vendor-neutral inbox for observations from personal agents (Meta Muse,
// Claude, Codex…). Agents report facts; Landed decides what they mean — no
// agent ever mutates the pipeline directly.
//
// Two route groups deliberately use different credentials:
//   - account routes use a normal Landed session to create/revoke
//     connections, review observations and (sync-off accounts) pull the
//     relay inbox;
//   - the ingest route accepts only a narrow, hashed agent token.
//
// Local-first: for accounts with Cloud sync off the server is only a relay.
// It holds an observation until the user's browser pulls it into its local
// database (or 7 days), then keeps a payload-free receipt so agent retries
// stay idempotent. See migrations/0004_agent_relay.sql for the row states.
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const SCHEMA_VERSION = '0.1'
const DEFAULT_SCOPES = ['observations:write']
const HOLD_DAYS = 7
const RECEIPT_DAYS = 30
const MAX_ACTIVE_CONNECTIONS = 20
const RATE_LIMIT_PER_HOUR = 1000

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// ── Observation Schema v0.1 ───────────────────────────────────────────────
// Envelope: { schema_version, run_id, observation_type, observed_at, payload }
// plus the Idempotency-Key header. Payload fields per type are below; extra
// fields are kept (forward compatible) but never interpreted.

export const APPLICATION_STATUSES = ['applied', 'recruiter_response', 'assessment', 'interview', 'rejected', 'offer', 'other'] as const

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

function text(value: unknown, name: string, max = 200, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) fail(400, `${name} is required`)
    return undefined
  }
  if (typeof value !== 'string' || (required && !value.trim())) fail(400, `${name} must be a non-empty string`)
  if (value.length > max) fail(400, `${name} is too long (max ${max})`)
  return value
}

function timestamp(value: unknown, name: string, required = true) {
  const v = text(value, name, 40, required)
  if (v !== undefined && (!ISO_TIMESTAMP.test(v) || !Number.isFinite(Date.parse(v)))) {
    fail(400, `${name} must be an ISO 8601 timestamp with a time zone, e.g. 2026-10-09T12:00:00Z`)
  }
  return v
}

function httpUrl(value: unknown, name: string) {
  const v = text(value, name, 2000, false)
  if (v === undefined) return
  let url: URL
  try {
    url = new URL(v)
  } catch {
    fail(400, `${name} must be an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(400, `${name} must be an http(s) URL`)
}

function object(value: unknown, name: string, required = true): Row | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(400, `${name} must be an object`)
  return value as Row
}

const PAYLOAD_VALIDATORS: Record<string, (p: Row) => void> = {
  job_discovered(p) {
    text(p.title, 'payload.title')
    text(p.company, 'payload.company')
    httpUrl(p.job_url, 'payload.job_url')
    text(p.location, 'payload.location', 200, false)
    text(p.source, 'payload.source', 80, false)
    text(p.description, 'payload.description', 20_000, false)
    text(p.deadline, 'payload.deadline', 80, false)
  },
  application_status(p) {
    const status = text(p.status, 'payload.status', 40)!
    if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) {
      fail(400, `payload.status must be one of: ${APPLICATION_STATUSES.join(', ')}`)
    }
    text(p.company, 'payload.company')
    text(p.role, 'payload.role', 200, false)
    httpUrl(p.job_url, 'payload.job_url')
    if (p.confidence !== undefined && (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1)) {
      fail(400, 'payload.confidence must be a number between 0 and 1')
    }
    timestamp(p.interview_at, 'payload.interview_at', false)
    if (p.interview_format !== undefined && !['onsite', 'remote'].includes(p.interview_format)) {
      fail(400, 'payload.interview_format must be onsite or remote')
    }
    const ev = object(p.evidence, 'payload.evidence', false)
    if (ev) {
      text(ev.source, 'payload.evidence.source', 80)
      text(ev.message_id, 'payload.evidence.message_id', 500, false)
      text(ev.thread_id, 'payload.evidence.thread_id', 500, false)
      text(ev.sender_domain, 'payload.evidence.sender_domain', 255, false)
      text(ev.subject, 'payload.evidence.subject', 500, false)
      timestamp(ev.received_at, 'payload.evidence.received_at', false)
      text(ev.summary, 'payload.evidence.summary', 2000, false)
    }
  },
  sync_error(p) {
    text(p.message, 'payload.message', 2000)
    text(p.source, 'payload.source', 80, false)
  },
}

export function validateObservation(raw: Row, headerKey: string | undefined) {
  const schemaVersion = text(raw.schema_version, 'schema_version', 20)!
  if (schemaVersion !== SCHEMA_VERSION) fail(400, `unsupported schema_version (expected ${SCHEMA_VERSION})`)
  const runId = text(raw.run_id, 'run_id')!
  const observationType = text(raw.observation_type, 'observation_type', 80)!
  const validatePayload = PAYLOAD_VALIDATORS[observationType]
  if (!validatePayload) {
    fail(400, `unsupported observation_type (expected one of: ${Object.keys(PAYLOAD_VALIDATORS).join(', ')})`)
  }
  const observedAt = timestamp(raw.observed_at, 'observed_at')!
  validatePayload(object(raw.payload, 'payload')!)
  const idempotencyKey = text(headerKey ?? raw.idempotency_key, 'Idempotency-Key')!
  return { schemaVersion, runId, observationType, observedAt, idempotencyKey }
}

// ── per-connection rate limit (in-memory; single server process) ─────────

const recent = new Map<string, number[]>()
function overRateLimit(connectionId: string): boolean {
  const cutoff = Date.now() - 3_600_000
  const hits = (recent.get(connectionId) ?? []).filter((t) => t > cutoff)
  if (hits.length >= RATE_LIMIT_PER_HOUR) {
    recent.set(connectionId, hits)
    return true
  }
  hits.push(Date.now())
  recent.set(connectionId, hits)
  return false
}

// ── routes ───────────────────────────────────────────────────────────────

const CONNECTION_COLUMNS = ['id', 'provider', 'display_name', 'scopes', 'last_seen_at', 'revoked_at', 'created_at']
const INBOX_COLUMNS = [
  'id', 'connection_id', 'idempotency_key', 'schema_version', 'run_id', 'observation_type',
  'payload_json', 'payload_sha256', 'observed_at', 'processing_status', 'created_at',
]

export function agentAccountRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/agent-connections', async (c) => {
    return c.json(await sql`
      select ${sql(CONNECTION_COLUMNS)} from agent_connections
      where user_id = ${c.get('user').id} order by created_at desc`)
  })

  app.post('/agent-connections', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<Row>(c)
    const provider = text(body.provider, 'provider', 40)!.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) fail(400, 'provider may use a-z, 0-9, _ and - only')
    const displayName = text(body.display_name, 'display_name', 120)!.trim()
    const [{ active }] = await sql<{ active: number }[]>`
      select count(*)::int as active from agent_connections where user_id = ${userId} and revoked_at is null`
    if (active >= MAX_ACTIVE_CONNECTIONS) fail(409, `at most ${MAX_ACTIVE_CONNECTIONS} active agent connections — revoke one first`)
    const token = `landed_agent_${randomBytes(32).toString('base64url')}`
    const [row] = await sql`
      insert into agent_connections (user_id, provider, display_name, token_hash, scopes)
      values (${userId}, ${provider}, ${displayName}, ${sha256(token)}, ${DEFAULT_SCOPES})
      returning ${sql(CONNECTION_COLUMNS)}`
    // The token is shown exactly once; only its hash is stored.
    return c.json({ connection: row, token }, 201)
  })

  app.post('/agent-connections/:id/revoke', async (c) => {
    const [row] = await sql`
      update agent_connections set revoked_at = coalesce(revoked_at, now())
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning ${sql(CONNECTION_COLUMNS)}`
    if (!row) fail(404, 'agent connection not found')
    return c.json(row)
  })

  // Review/debug list. Receipts (delivered to a device, or expired) come back
  // with payload_json null — the content lives on the user's device now.
  app.get('/agent-observations', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500)
    return c.json(await sql`
      select o.*, c.provider, c.display_name
      from agent_observations o
      join agent_connections c on c.id = o.connection_id and c.user_id = o.user_id
      where o.user_id = ${c.get('user').id}
      order by o.created_at desc limit ${limit}`)
  })

  // Relay inbox (sync-off accounts): held observations, oldest first. The
  // browser stores them locally, then acks so the server purges the payload.
  app.get('/agent-inbox', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500)
    return c.json(await sql`
      select ${sql(INBOX_COLUMNS.map((col) => `o.${col}`))}, c.provider, c.display_name
      from agent_observations o
      join agent_connections c on c.id = o.connection_id and c.user_id = o.user_id
      where o.user_id = ${c.get('user').id} and o.payload_json is not null and o.expires_at is not null
      order by o.created_at limit ${limit}`)
  })

  app.post('/agent-inbox/ack', async (c) => {
    const ids = (await jsonBody<Row>(c)).ids
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string')) {
      fail(400, 'ids must be an array of up to 500 observation ids')
    }
    const acked = await sql`
      update agent_observations set payload_json = null, delivered_at = now()
      where user_id = ${c.get('user').id} and id = any(${ids}::uuid[])
        and payload_json is not null and expires_at is not null
      returning id`
    return c.json({ acked: acked.length })
  })

  return app
}

export function agentIngestRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.post('/observations', async (c) => {
    const header = c.req.header('Authorization')
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (!token) fail(401, 'agent token required (Authorization: Bearer landed_agent_…)')
    const [connection] = await sql<{ id: string; user_id: string; scopes: string[]; revoked_at: string | null; cloud_sync: boolean }[]>`
      select c.id, c.user_id, c.scopes, c.revoked_at, u.cloud_sync
      from agent_connections c join users u on u.id = c.user_id
      where c.token_hash = ${sha256(token)}`
    if (!connection || connection.revoked_at) fail(401, 'invalid or revoked agent token')
    if (!connection.scopes.includes('observations:write')) fail(403, 'token lacks observations:write scope')
    if (overRateLimit(connection.id)) {
      c.header('Retry-After', '3600')
      fail(429, `rate limit: at most ${RATE_LIMIT_PER_HOUR} observations per hour per connection`)
    }

    const raw = await jsonBody<Row>(c)
    const parsed = validateObservation(raw, c.req.header('Idempotency-Key'))
    // Sync-off accounts: hold only until the browser picks it up (local-first).
    const expiresAt = connection.cloud_sync ? null : new Date(Date.now() + HOLD_DAYS * 86_400_000)
    const body = sql.json(raw)
    const inserted = await sql<{ id: string; created_at: string }[]>`
      insert into agent_observations (
        user_id, connection_id, idempotency_key, schema_version, run_id,
        observation_type, payload_json, payload_sha256, observed_at, expires_at
      ) values (
        ${connection.user_id}, ${connection.id}, ${parsed.idempotencyKey},
        ${parsed.schemaVersion}, ${parsed.runId}, ${parsed.observationType},
        ${body}, encode(sha256(convert_to(${body}::jsonb::text, 'UTF8')), 'hex'),
        ${parsed.observedAt}, ${expiresAt}
      )
      on conflict (connection_id, idempotency_key) do nothing
      returning id, created_at`

    await sql`update agent_connections set last_seen_at = now() where id = ${connection.id}`

    if (inserted[0]) {
      return c.json({ accepted: true, duplicate: false, observation_id: inserted[0].id, created_at: inserted[0].created_at }, 201)
    }

    // Retry with the same key: fine if the body is identical (compared by
    // hash, so it still works after the payload was delivered and purged).
    const [existing] = await sql<{ id: string; created_at: string; same: boolean }[]>`
      select id, created_at,
        payload_sha256 = encode(sha256(convert_to(${body}::jsonb::text, 'UTF8')), 'hex') as same
      from agent_observations
      where connection_id = ${connection.id} and idempotency_key = ${parsed.idempotencyKey}`
    if (!existing.same) {
      fail(409, 'Idempotency-Key was already used with a different body — use a new key for new observations', {
        code: 'idempotency_conflict',
        observation_id: existing.id,
      })
    }
    return c.json({ accepted: true, duplicate: true, observation_id: existing.id, created_at: existing.created_at })
  })

  return app
}

/** Hourly: purge held payloads nobody picked up within HOLD_DAYS, and drop
 *  payload-free receipts after RECEIPT_DAYS. */
export async function purgeAgentRelay(sql: Sql) {
  await sql`
    update agent_observations set payload_json = null
    where payload_json is not null and expires_at is not null and expires_at < now()`
  await sql`
    delete from agent_observations
    where payload_json is null
      and coalesce(delivered_at, expires_at, created_at) < now() - make_interval(days => ${RECEIPT_DAYS})`
}
