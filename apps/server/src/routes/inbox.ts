// Cloud storage for what the observation processor produces: job leads (the
// "to apply" list) and status suggestions (the review queue), plus marking
// observations processed. Mounted behind requireCloud — sync-off accounts
// keep these in their browser. The processing itself runs in the browser
// (packages/observation-processor); these routes just store results.
import { readLeadQueueFields } from '@landed/schema/lead-queue'
import { parseDeadline } from '@landed/schema/pipeline'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export const LEAD_COLUMNS = [
  'id', 'fingerprint', 'ats_key', 'canonical_url', 'company_key', 'title_key', 'company_name', 'title',
  'job_url', 'location', 'description', 'sources', 'status', 'application_id', 'first_seen_at', 'last_seen_at',
  'created_at', 'deadline', 'posted_at', 'closed_at', 'screen', 'fit', 'dedupe',
] as const

export const SUGGESTION_COLUMNS = [
  'id', 'dedupe_key', 'kind', 'state', 'application_id', 'candidate_ids', 'company_name', 'role', 'status',
  'proposed_stage', 'previous_stage', 'confidence', 'evidence', 'observation_ids', 'provider', 'created_at',
  'resolved_at',
] as const

const JSON_COLUMNS = new Set(['sources', 'candidate_ids', 'evidence', 'observation_ids', 'processing_result', 'screen', 'fit', 'dedupe'])
const PROCESSING_STATUSES = ['pending', 'processed', 'needs-review', 'rejected']

/** Pick the given columns from a request body (null when absent), wrapping
 *  jsonb columns. `id` and `created_at` come from the URL / defaults. */
function columns(sql: Sql, body: Row, cols: readonly string[]): Row {
  const out: Row = {}
  for (const col of cols) {
    if (col === 'id' || col === 'created_at') continue
    const v = body[col] ?? null
    out[col] = JSON_COLUMNS.has(col) && v !== null ? sql.json(v) : v
  }
  return out
}

function upsert(sql: Sql, table: string, cols: readonly string[]) {
  return async (userId: string, id: string, body: Row) => {
    const values: Row = { ...columns(sql, body, cols), id, user_id: userId }
    const updates = Object.keys(values).filter((k) => k !== 'id' && k !== 'user_id')
    const [row] = await sql`
      insert into ${sql(table)} ${sql(values)}
      on conflict (id) do update set ${sql(Object.fromEntries(updates.map((k) => [k, values[k]])))}
      where ${sql(table)}.user_id = ${userId}
      returning ${sql(cols as unknown as string[])}`
    // No row back: the id exists but belongs to someone else.
    if (!row) fail(404, `${table} row not found`)
    return row
  }
}

/** The apply-queue fields in a lead write (docs/leads-model.md), validated
 *  exactly like the local store: null clears, anything else must parse. */
function leadQueue(body: Row): Row {
  const read = readLeadQueueFields(body)
  if (!read.ok) fail(400, read.error.message)
  return read.fields
}

export function inboxRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()
  const saveLead = upsert(sql, 'job_leads', LEAD_COLUMNS)
  const saveSuggestion = upsert(sql, 'status_suggestions', SUGGESTION_COLUMNS)

  app.get('/job-leads', async (c) => {
    return c.json(await sql`
      select ${sql(LEAD_COLUMNS as unknown as string[])} from job_leads
      where user_id = ${c.get('user').id} order by last_seen_at desc`)
  })

  // Full-record upsert: the processor merges in the browser and sends the result.
  app.put('/job-leads/:id', async (c) => {
    const body = await jsonBody(c)
    return c.json(await saveLead(c.get('user').id, c.req.param('id'), { ...body, ...leadQueue(body) }))
  })

  app.patch('/job-leads/:id', async (c) => {
    const body = await jsonBody(c)
    const patch: Row = {}
    if (body.status !== undefined) patch.status = body.status
    if (body.application_id !== undefined) patch.application_id = body.application_id
    if (body.deadline !== undefined) {
      patch.deadline = body.deadline === null || body.deadline === '' ? null : parseDeadline(body.deadline)
      if (body.deadline && !patch.deadline) fail(400, 'deadline must be a date')
    }
    for (const [k, v] of Object.entries(leadQueue(body))) patch[k] = JSON_COLUMNS.has(k) && v !== null ? sql.json(v) : v
    if (Object.keys(patch).length === 0) {
      fail(400, 'nothing to update (allowed: status, application_id, deadline, posted_at, closed_at, screen, fit, dedupe)')
    }
    const [row] = await sql`
      update job_leads set ${sql(patch)} where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning ${sql(LEAD_COLUMNS as unknown as string[])}`
    if (!row) fail(404, 'lead not found')
    return c.json(row)
  })

  app.get('/status-suggestions', async (c) => {
    return c.json(await sql`
      select ${sql(SUGGESTION_COLUMNS as unknown as string[])} from status_suggestions
      where user_id = ${c.get('user').id} order by created_at desc limit 500`)
  })

  app.put('/status-suggestions/:id', async (c) => {
    return c.json(await saveSuggestion(c.get('user').id, c.req.param('id'), await jsonBody(c)))
  })

  app.patch('/status-suggestions/:id', async (c) => {
    const body = await jsonBody(c)
    const patch: Row = {}
    for (const k of ['state', 'application_id', 'proposed_stage', 'previous_stage', 'resolved_at']) {
      if (body[k] !== undefined) patch[k] = body[k]
    }
    if (Object.keys(patch).length === 0) fail(400, 'nothing to update')
    const [row] = await sql`
      update status_suggestions set ${sql(patch)} where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning ${sql(SUGGESTION_COLUMNS as unknown as string[])}`
    if (!row) fail(404, 'suggestion not found')
    return c.json(row)
  })

  // Cloud processing queue: pending observations, oldest first.
  app.get('/agent-observations/pending', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500)
    return c.json(await sql`
      select o.*, c.provider, c.display_name
      from agent_observations o
      join agent_connections c on c.id = o.connection_id and c.user_id = o.user_id
      where o.user_id = ${c.get('user').id} and o.processing_status = 'pending' and o.payload_json is not null
      order by o.created_at limit ${limit}`)
  })

  app.patch('/agent-observations/:id', async (c) => {
    const body = await jsonBody<Row>(c)
    if (!PROCESSING_STATUSES.includes(body.processing_status)) {
      fail(400, `processing_status must be one of: ${PROCESSING_STATUSES.join(', ')}`)
    }
    const [row] = await sql`
      update agent_observations
      set processing_status = ${body.processing_status},
          processing_result = ${body.processing_result == null ? null : sql.json(body.processing_result)}
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning id, processing_status, processing_result`
    if (!row) fail(404, 'observation not found')
    return c.json(row)
  })

  return app
}
