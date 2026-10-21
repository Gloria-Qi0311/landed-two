// Fill traces (Cloud accounts): the extension uploads what one autofill did,
// under the short ref its popup shows (packages/schema/src/fill-trace.ts).
// Mounted behind requireCloud — sync-off accounts keep theirs in the
// extension. The user's paired computer reads one by ref
// (routes/runtime.ts → GET /api/runtime/fill-traces/:ref).
import { FILL_TRACE_DAYS, normalizeFillTraceRef, parseFillTrace } from '@landed/schema/fill-trace'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

export function traceRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  // Create or replace (the outcome is added after the fill). Older than 30
  // days goes on the way in.
  app.put('/fill-traces/:ref', async (c) => {
    const ref = normalizeFillTraceRef(c.req.param('ref'))
    if (!ref) fail(404, 'no such trace')
    const trace = parseFillTrace(await jsonBody(c))
    if (!trace || trace.ref !== ref) fail(400, 'not a fill trace')
    const userId = c.get('user').id
    await sql`
      insert into fill_traces (user_id, ref, trace) values (${userId}, ${ref}, ${sql.json(trace)})
      on conflict (user_id, ref) do update set trace = excluded.trace`
    await sql`delete from fill_traces where user_id = ${userId} and created_at < now() - make_interval(days => ${FILL_TRACE_DAYS})`
    return c.body(null, 204)
  })

  app.get('/fill-traces/:ref', async (c) => {
    const ref = normalizeFillTraceRef(c.req.param('ref'))
    if (!ref) fail(404, 'no such trace')
    const [row] = await sql`select trace from fill_traces where user_id = ${c.get('user').id} and ref = ${ref}`
    if (!row) fail(404, 'no such trace')
    return c.json(row.trace)
  })

  return app
}

/** One trace by ref for this user, or null (the paired computer's read). */
export async function traceFor(sql: Sql, userId: string, rawRef: string) {
  const ref = normalizeFillTraceRef(rawRef)
  if (!ref) return null
  const [row] = await sql`select trace from fill_traces where user_id = ${userId} and ref = ${ref}`
  return row ? row.trace : null
}
