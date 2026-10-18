// Portal-sync routes: connections, the events feed + live stream, and
// portal-ingest (ported from the former Supabase Edge Function).
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'
import type { PortalEventsHub } from '../realtime.ts'

const PROVIDERS = ['greenhouse', 'lever', 'workday', 'ashby', 'bamboohr', 'boss', 'smartrecruiters', 'other']
const STATUSES = ['active', 'syncing', 'expired', 'disconnected']
const EVENT_TYPES = ['status-change', 'new-event', 'expired', 'sync', 'rejection']
const MAX_BATCH = 500

// Loosely-typed JSON row (request bodies, jsonb values) for the sql() helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

type ConnectionInput = {
  company_id: string
  provider: string
  portal_host?: string | null
  status?: string
  last_sync_at?: string | null
  failure_reason?: string | null
}

// Single atomic upsert on the (user_id, company_id, provider) constraint —
// never SELECT-then-UPDATE-or-INSERT (see docs/data-and-sync.md).
async function upsertConnection(sql: Sql, userId: string, input: ConnectionInput) {
  const [row] = await sql`
    insert into portal_connections
      (user_id, company_id, provider, portal_host, status, last_sync_at, failure_reason)
    values (
      ${userId}, ${input.company_id}, ${input.provider}, ${input.portal_host ?? null},
      ${input.status ?? 'active'}, ${input.last_sync_at ?? null}, ${input.failure_reason ?? null}
    )
    on conflict (user_id, company_id, provider) do update set
      portal_host = excluded.portal_host,
      status = excluded.status,
      last_sync_at = excluded.last_sync_at,
      failure_reason = excluded.failure_reason
    returning *`
  return row
}

function eventRow(input: Row, userId: string) {
  const payload = input.payload_json ?? {}
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail(400, 'payload_json must be a JSON object')
  }
  return {
    user_id: userId,
    type: input.type,
    connection_id: input.connection_id ?? null,
    application_id: input.application_id ?? null,
    payload_json: payload,
  }
}

// Hand-rolled validator from the Edge Function, unchanged in behavior.
function validateIngest(raw: Row) {
  const errors: Record<string, string> = {}
  const optionalString = (k: string) => raw[k] !== undefined && typeof raw[k] !== 'string'
  if (typeof raw.provider !== 'string' || !PROVIDERS.includes(raw.provider)) {
    errors.provider = `must be one of: ${PROVIDERS.join(', ')}`
  }
  if (typeof raw.event_type !== 'string' || !EVENT_TYPES.includes(raw.event_type)) {
    errors.event_type = `must be one of: ${EVENT_TYPES.join(', ')}`
  }
  if (raw.company_id !== undefined && (typeof raw.company_id !== 'string' || raw.company_id.length === 0)) {
    errors.company_id = 'must be a non-empty string (uuid)'
  }
  if (raw.status !== undefined && (typeof raw.status !== 'string' || !STATUSES.includes(raw.status))) {
    errors.status = `must be one of: ${STATUSES.join(', ')}`
  }
  if (optionalString('portal_host')) errors.portal_host = 'must be a string'
  if (optionalString('failure_reason')) errors.failure_reason = 'must be a string'
  if (raw.application_id !== undefined && (typeof raw.application_id !== 'string' || raw.application_id.length === 0)) {
    errors.application_id = 'must be a non-empty string (uuid)'
  }
  if (raw.payload !== undefined && (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload))) {
    errors.payload = 'must be a JSON object'
  }
  if (Object.keys(errors).length > 0) fail(400, 'validation failed', { fields: errors })
}

export function portalRoutes(sql: Sql, hub: PortalEventsHub) {
  const app = new Hono<AppEnv>()

  app.get('/portal-connections', async (c) => {
    return c.json(await sql`
      select * from portal_connections where user_id = ${c.get('user').id}
      order by created_at desc`)
  })

  app.put('/portal-connections', async (c) => {
    const body = await jsonBody<ConnectionInput>(c)
    if (typeof body.company_id !== 'string' || typeof body.provider !== 'string') {
      fail(400, 'company_id and provider are required')
    }
    return c.json(await upsertConnection(sql, c.get('user').id, body))
  })

  app.get('/portal-events', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500)
    return c.json(await sql`
      select * from portal_events where user_id = ${c.get('user').id}
      order by created_at desc limit ${limit}`)
  })

  // Accepts one row or an array (the extension pushes its queue as a batch).
  // Any user_id in the body is ignored — ownership comes from the session.
  app.post('/portal-events', async (c) => {
    const body = await jsonBody<Row | Row[]>(c)
    const inputs = Array.isArray(body) ? body : [body]
    if (inputs.length === 0) return c.json({ inserted: 0, rows: [] }, 201)
    if (inputs.length > MAX_BATCH) fail(400, `batch too large (max ${MAX_BATCH})`)
    const userId = c.get('user').id
    const rows = inputs.map((r) => eventRow(r, userId))
    const inserted = await sql`
      insert into portal_events ${sql(rows.map((r) => ({ ...r, payload_json: sql.json(r.payload_json as Row) })))}
      returning *`
    return c.json({ inserted: inserted.length, rows: inserted }, 201)
  })

  // Server-sent events: one `portal_event` message per insert for this user.
  app.get('/portal-events/stream', (c) => {
    const userId = c.get('user').id
    return streamSSE(c, async (stream) => {
      const queue: Row[] = []
      let wake: (() => void) | null = null
      const unsubscribe = hub.subscribe(userId, (row) => {
        queue.push(row)
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted) {
        // Wait for an event or the 25s heartbeat (keeps Cloudflare's idle
        // timeout and any proxies from cutting the connection).
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, 25_000)
        })
        clearTimeout(timer)
        wake = null
        if (stream.aborted) break
        if (queue.length === 0) {
          await stream.write(': ping\n\n')
          continue
        }
        for (const row of queue.splice(0)) {
          await stream.writeSSE({ event: 'portal_event', data: JSON.stringify(row) })
        }
      }
      unsubscribe()
    })
  })

  // portal-ingest: one event + optional connection upsert in a transaction.
  // Returns { event_id, connection_id } — same contract as the Edge Function.
  app.post('/portal-ingest', async (c) => {
    const raw = await jsonBody(c)
    validateIngest(raw)
    const userId = c.get('user').id
    const result = await sql.begin(async (tx) => {
      let connectionId: string | null = null
      if (raw.company_id) {
        const conn = await upsertConnection(tx as unknown as Sql, userId, {
          company_id: raw.company_id as string,
          provider: raw.provider as string,
          portal_host: (raw.portal_host as string) ?? null,
          status: (raw.status as string) ?? 'active',
          last_sync_at: new Date().toISOString(),
          failure_reason: (raw.failure_reason as string) ?? null,
        })
        connectionId = conn.id as string
      }
      const row = eventRow({
        type: raw.event_type,
        connection_id: connectionId,
        application_id: raw.application_id ?? null,
        payload_json: raw.payload ?? {},
      }, userId)
      const [event] = await tx<{ id: string }[]>`
        insert into portal_events ${tx({ ...row, payload_json: tx.json(row.payload_json as Row) })}
        returning id`
      return { event_id: event.id, connection_id: connectionId }
    })
    return c.json(result, 201)
  })

  return app
}
