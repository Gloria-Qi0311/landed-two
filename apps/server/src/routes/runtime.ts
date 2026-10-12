// Runtimes — the user's own computers running the Landed daemon (apps/daemon),
// which executes tasks with locally installed agent CLIs (Claude Code, Codex,
// Gemini CLI) on the user's own subscriptions. See runtime-hub.ts.
//
// Two route groups, two credentials:
//   - account routes (Landed session): pair/list/revoke computers, start a
//     task on one, stream its output;
//   - daemon routes (runtime token `landed_rt_…`, mounted at /api/runtime):
//     say hello, receive tasks over SSE, post output events.
// Both work whether or not Cloud sync is on: tasks and output are relayed in
// memory, never stored.
//
// Task kinds: `chat` (one Ask Agent turn) and `job_search` (search the web
// for jobs matching a confirmed brief; the result carries `jobs`). Each
// agent reports the kinds its daemon can run.
import { createHash, randomBytes } from 'node:crypto'
import { parseBrief, parseFoundJobs } from '@landed/schema/search-brief'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'
import type { Job, JobEvent, RuntimeHub } from '../runtime-hub.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
const UUID = /^[0-9a-f-]{36}$/i
const RUNTIME_COLUMNS = ['id', 'name', 'agents', 'daemon_version', 'last_seen_at', 'revoked_at', 'created_at']
const JOB_KINDS = new Set(['chat', 'job_search'])
/** Daemons from before agents reported their kinds can only chat. */
const LEGACY_KINDS = ['chat']
const MAX_MESSAGE = 20_000
const MAX_RUNTIMES = 10
const HEARTBEAT_MS = 25_000

function withOnline(hub: RuntimeHub, rows: Row[]) {
  return rows.map((r) => ({ ...r, online: !r.revoked_at && hub.isOnline(r.id) }))
}

// ── account routes ───────────────────────────────────────────────────────

export function runtimeAccountRoutes(sql: Sql, hub: RuntimeHub) {
  const app = new Hono<AppEnv>()

  app.get('/runtimes', async (c) => {
    const rows = await sql`
      select ${sql(RUNTIME_COLUMNS)} from runtimes where user_id = ${c.get('user').id} order by created_at desc`
    return c.json(withOnline(hub, rows))
  })

  // Pair a computer: returns the daemon token once (only its hash is kept).
  app.post('/runtimes', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<Row>(c)
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'My computer'
    // Pairings whose command was never run are useless (the key was shown
    // once); clear old ones so abandoned attempts don't pile up.
    await sql`
      delete from runtimes
      where user_id = ${userId} and last_seen_at is null and created_at < now() - interval '10 minutes'`
    const [{ active }] = await sql<{ active: number }[]>`
      select count(*)::int as active from runtimes where user_id = ${userId} and revoked_at is null`
    if (active >= MAX_RUNTIMES) fail(409, `at most ${MAX_RUNTIMES} connected computers — remove one first`)
    const token = `landed_rt_${randomBytes(32).toString('base64url')}`
    const [row] = await sql`
      insert into runtimes (user_id, name, token_hash) values (${userId}, ${name}, ${sha256(token)})
      returning ${sql(RUNTIME_COLUMNS)}`
    return c.json({ runtime: { ...row, online: false }, token }, 201)
  })

  app.post('/runtimes/:id/revoke', async (c) => {
    const [row] = await sql`
      update runtimes set revoked_at = coalesce(revoked_at, now())
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning ${sql(RUNTIME_COLUMNS)}`
    if (!row) fail(404, 'computer not found')
    hub.disconnect(row.id)
    return c.json({ ...row, online: false })
  })

  // Start a task on one of the user's computers.
  app.post('/runtime-jobs', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<Row>(c)
    if (!JOB_KINDS.has(body.kind)) fail(400, `kind must be one of: ${[...JOB_KINDS].join(', ')}`)
    const raw = body.input && typeof body.input === 'object' ? body.input : {}
    // Only validated fields reach the daemon — never the raw body.
    let input: Record<string, unknown>
    if (body.kind === 'chat') {
      if (typeof raw.message !== 'string' || !raw.message.trim()) fail(400, 'input.message is required')
      if (raw.message.length > MAX_MESSAGE) fail(400, `input.message is too long (max ${MAX_MESSAGE})`)
      if (typeof raw.conversation_id !== 'string' || !UUID.test(raw.conversation_id)) {
        fail(400, 'input.conversation_id must be a uuid')
      }
      input = { message: raw.message, conversation_id: raw.conversation_id }
    } else {
      const brief = parseBrief(raw.brief)
      if (!brief) fail(400, 'input.brief needs at least one role')
      if (typeof raw.search_id !== 'string' || !UUID.test(raw.search_id)) fail(400, 'input.search_id must be a uuid')
      input = { brief, search_id: raw.search_id }
    }
    const [runtime] = await sql<{ id: string; agents: { id: string; kinds?: string[] }[]; revoked_at: string | null }[]>`
      select id, agents, revoked_at from runtimes where id = ${String(body.runtime_id ?? '')} and user_id = ${userId}`
    if (!runtime || runtime.revoked_at) fail(404, 'computer not found')
    const agent = runtime.agents.find((a) => a.id === body.agent)
    if (!agent) fail(400, `that computer doesn't have ${String(body.agent)} installed`)
    if (!(agent.kinds ?? LEGACY_KINDS).includes(body.kind)) {
      fail(409, "The Landed daemon on that computer is out of date. Stop it and run `pnpm landed start` again.", { code: 'runtime_outdated' })
    }

    const job: Job = {
      id: crypto.randomUUID(), user_id: userId, runtime_id: runtime.id,
      agent: body.agent, kind: body.kind, input, created_at: Date.now(),
    }
    if (!hub.dispatch(job)) fail(409, 'That computer is offline — start the Landed daemon on it.', { code: 'runtime_offline' })
    return c.json({ job_id: job.id }, 202)
  })

  app.get('/runtime-jobs/:id/stream', (c) => {
    const userId = c.get('user').id
    return streamSSE(c, async (stream) => {
      const queue: JobEvent[] = []
      let wake: (() => void) | null = null
      const sub = hub.subscribe(c.req.param('id'), userId, (e) => {
        queue.push(e)
        wake?.()
      })
      if (!sub) {
        await stream.writeSSE({ event: 'job_event', data: JSON.stringify({ type: 'error', message: 'Task not found or expired.' }) })
        return
      }
      stream.onAbort(() => {
        sub.unsubscribe()
        wake?.()
      })
      queue.unshift(...sub.replay)
      let finished = false
      while (!stream.aborted && !finished) {
        for (const e of queue.splice(0)) {
          await stream.writeSSE({ event: 'job_event', data: JSON.stringify(e) })
          if (e.type === 'done' || e.type === 'error') finished = true
        }
        if (finished) break
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, HEARTBEAT_MS)
        })
        clearTimeout(timer)
        wake = null
        if (queue.length === 0 && !stream.aborted) await stream.write(': ping\n\n')
      }
      sub.unsubscribe()
    })
  })

  return app
}

// ── daemon routes ────────────────────────────────────────────────────────

async function runtimeFromToken(sql: Sql, c: Context) {
  const header = c.req.header('Authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) fail(401, 'runtime token required')
  const [runtime] = await sql<{ id: string; user_id: string; revoked_at: string | null }[]>`
    select id, user_id, revoked_at from runtimes where token_hash = ${sha256(token)}`
  if (!runtime || runtime.revoked_at) fail(401, 'this computer was disconnected from Landed — pair it again')
  return runtime
}

function cleanAgents(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a) => a && typeof a.id === 'string')
    .slice(0, 10)
    .map((a) => ({
      id: String(a.id).slice(0, 40),
      label: typeof a.label === 'string' ? a.label.slice(0, 80) : String(a.id),
      version: typeof a.version === 'string' ? a.version.slice(0, 80) : null,
      kinds: Array.isArray(a.kinds) ? a.kinds.filter((k: unknown) => typeof k === 'string' && JOB_KINDS.has(k)) : LEGACY_KINDS,
    }))
}

const EVENT_TYPES = new Set(['started', 'delta', 'tool', 'done', 'error'])

export function runtimeDaemonRoutes(sql: Sql, hub: RuntimeHub) {
  const app = new Hono<AppEnv>()

  app.post('/hello', async (c) => {
    const runtime = await runtimeFromToken(sql, c)
    const body = await jsonBody<Row>(c)
    const [row] = await sql`
      update runtimes set
        agents = ${sql.json(cleanAgents(body.agents))},
        daemon_version = ${typeof body.daemon_version === 'string' ? body.daemon_version.slice(0, 40) : null},
        name = coalesce(${typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null}, name),
        last_seen_at = now()
      where id = ${runtime.id}
      returning ${sql(RUNTIME_COLUMNS)}`
    return c.json(row)
  })

  // Tasks for this computer, as server-sent events.
  app.get('/stream', async (c) => {
    const runtime = await runtimeFromToken(sql, c)
    return streamSSE(c, async (stream) => {
      const queue: Job[] = []
      let wake: (() => void) | null = null
      let closed = false
      const disconnect = hub.connect(runtime.id, {
        send: (job) => {
          queue.push(job)
          wake?.()
        },
        close: () => {
          closed = true
          wake?.()
        },
      })
      stream.onAbort(() => wake?.())
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted && !closed) {
        for (const job of queue.splice(0)) {
          const { user_id: _u, ...forDaemon } = job
          await stream.writeSSE({ event: 'job', data: JSON.stringify(forDaemon) })
        }
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, HEARTBEAT_MS)
        })
        clearTimeout(timer)
        wake = null
        if (queue.length === 0 && !stream.aborted && !closed) {
          await stream.write(': ping\n\n')
          await sql`update runtimes set last_seen_at = now() where id = ${runtime.id}`
        }
      }
      disconnect()
      if (closed) await stream.close()
    })
  })

  app.post('/jobs/:id/events', async (c) => {
    const runtime = await runtimeFromToken(sql, c)
    const body = await jsonBody<Row>(c)
    const events = (Array.isArray(body.events) ? body.events : [])
      .filter((e: Row) => e && EVENT_TYPES.has(e.type))
      .slice(0, 500)
      .map((e: Row): JobEvent => {
        switch (e.type) {
          case 'delta': return { type: 'delta', text: String(e.text ?? '').slice(0, 20_000) }
          case 'tool': return { type: 'tool', name: String(e.name ?? '').slice(0, 80) }
          case 'done': return {
            type: 'done',
            text: String(e.text ?? '').slice(0, 200_000),
            session_id: typeof e.session_id === 'string' ? e.session_id : undefined,
            ...(Array.isArray(e.jobs) ? { jobs: parseFoundJobs(e.jobs) } : {}),
          }
          case 'error': return { type: 'error', message: String(e.message ?? 'Task failed').slice(0, 2000) }
          default: return { type: 'started', agent: String(e.agent ?? '') }
        }
      })
    if (!hub.push(c.req.param('id'), runtime.id, events)) fail(404, 'unknown or finished task')
    return c.json({ ok: true })
  })

  return app
}
