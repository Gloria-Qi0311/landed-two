// Agent chat history (Cloud accounts). Mounted behind requireCloud — sync-off
// accounts keep conversations in their browser. The browser sends the whole
// conversation after each turn (full upsert); the turns themselves never
// pass through here on their way to the agent (that's the runtime relay).
import { parseConversation } from '@landed/schema/conversation'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

export const CONVERSATION_COLUMNS = ['id', 'title', 'turns', 'created_at', 'updated_at'] as const

export function conversationRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()
  const cols = CONVERSATION_COLUMNS as unknown as string[]

  app.get('/agent-conversations', async (c) => {
    return c.json(await sql`
      select ${sql(cols)} from agent_conversations where user_id = ${c.get('user').id}
      order by updated_at desc limit 500`)
  })

  app.put('/agent-conversations/:id', async (c) => {
    const userId = c.get('user').id
    const conv = parseConversation({ ...(await jsonBody(c)), id: c.req.param('id') })
    if (!conv) fail(400, 'not a conversation')
    const [row] = await sql`
      insert into agent_conversations (id, user_id, title, turns, created_at, updated_at)
      values (${conv.id}, ${userId}, ${conv.title}, ${sql.json(conv.turns)}, ${conv.created_at ?? new Date().toISOString()}, now())
      on conflict (id) do update set title = excluded.title, turns = excluded.turns, updated_at = now()
      where agent_conversations.user_id = ${userId}
      returning ${sql(cols)}`
    // No row back: the id belongs to someone else.
    if (!row) fail(404, 'conversation not found')
    return c.json(row)
  })

  app.delete('/agent-conversations/:id', async (c) => {
    const [row] = await sql`
      delete from agent_conversations where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning id`
    if (!row) fail(404, 'conversation not found')
    return c.body(null, 204)
  })

  return app
}
