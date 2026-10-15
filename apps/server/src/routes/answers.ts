// Application answers (Cloud accounts): one row per account. Mounted behind
// requireCloud — sync-off accounts keep theirs in the browser. The browser
// sends the whole object on save; it's validated like everywhere else
// (parseApplicationAnswers) and the row's id is kept from the first save.
import { parseApplicationAnswers } from '@landed/schema/application-answers'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

export const ANSWER_COLUMNS = ['id', 'answers', 'created_at', 'updated_at'] as const

export function answerRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()
  const cols = ANSWER_COLUMNS as unknown as string[]

  app.get('/application-answers', async (c) => {
    const [row] = await sql`select ${sql(cols)} from application_answers where user_id = ${c.get('user').id}`
    return c.json(row ?? null)
  })

  app.put('/application-answers', async (c) => {
    const body = await jsonBody<{ id?: unknown; answers?: unknown }>(c)
    const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null
    if (!id) fail(400, 'id must be a uuid')
    const answers = parseApplicationAnswers(body.answers)
    const [row] = await sql`
      insert into application_answers (id, user_id, answers)
      values (${id}, ${c.get('user').id}, ${sql.json(answers)})
      on conflict (user_id) do update set answers = excluded.answers, updated_at = now()
      returning ${sql(cols)}`
    return c.json(row)
  })

  return app
}
