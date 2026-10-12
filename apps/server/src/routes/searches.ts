// Job searches: the direction the user confirmed in the Ask Agent chat (a
// brief) and how its last run went. Mounted behind requireCloud — sync-off
// accounts keep these in their browser. Runs happen on the user's computer
// (routes/runtime.ts, task kind `job_search`); results become job leads in
// the browser (apps/web/src/lib/inbox.ts → ingestFoundJobs).
import { parseBrief } from '@landed/schema/search-brief'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export const SEARCH_COLUMNS = [
  'id', 'brief', 'status', 'last_run_at', 'last_run_result', 'created_at', 'updated_at',
] as const
const STATUSES = ['active', 'archived']

export function searchRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()
  const cols = SEARCH_COLUMNS as unknown as string[]

  app.get('/job-searches', async (c) => {
    return c.json(await sql`
      select ${sql(cols)} from job_searches where user_id = ${c.get('user').id}
      order by created_at desc limit 50`)
  })

  // Confirm a brief: it becomes the active search; the previous one is archived.
  app.post('/job-searches', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<Row>(c)
    const brief = parseBrief(body.brief)
    if (!brief) fail(400, 'brief needs at least one role')
    const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : crypto.randomUUID()
    const row = await sql.begin(async (tx) => {
      await tx`
        update job_searches set status = 'archived', updated_at = now()
        where user_id = ${userId} and status = 'active'`
      const [created] = await tx`
        insert into job_searches (id, user_id, brief) values (${id}, ${userId}, ${tx.json(brief)})
        returning ${tx(cols)}`
      return created
    })
    return c.json(row, 201)
  })

  app.patch('/job-searches/:id', async (c) => {
    const body = await jsonBody<Row>(c)
    const patch: Row = {}
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) fail(400, `status must be one of: ${STATUSES.join(', ')}`)
      patch.status = body.status
    }
    if (body.last_run_at !== undefined) patch.last_run_at = body.last_run_at
    if (body.last_run_result !== undefined) {
      patch.last_run_result = body.last_run_result === null ? null : sql.json(body.last_run_result)
    }
    if (Object.keys(patch).length === 0) fail(400, 'nothing to update (allowed: status, last_run_at, last_run_result)')
    const [row] = await sql`
      update job_searches set ${sql(patch)}, updated_at = now()
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning ${sql(cols)}`
    if (!row) fail(404, 'search not found')
    return c.json(row)
  })

  return app
}
