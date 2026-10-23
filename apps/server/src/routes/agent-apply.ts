// Approved applications handed to connected personal agents (Muse, Today,
// and other task-capable connections). The signed-in browser enqueues one
// deliberately-scoped context snapshot; only the chosen connection sees it.
// A terminal result is kept until the browser stores it, then ack erases the
// copied context and resume bytes. This works for local-first accounts too.
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { parseResumeFile } from '@landed/schema/application-files'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

type Row = Record<string, unknown>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL = ['submitted', 'blocked', 'error'] as const
const BLOCKERS = ['login', 'account', 'captcha', 'answers', 'files', 'review', 'submit'] as const
const PUBLIC_COLUMNS = ['id', 'connection_id', 'application_id', 'lead_id', 'status', 'result', 'created_at', 'updated_at', 'completed_at']

const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const uuid = (v: unknown, name: string, optional = false): string | null => {
  if ((v === null || v === undefined || v === '') && optional) return null
  if (typeof v !== 'string' || !UUID.test(v)) fail(400, `${name} must be a uuid`)
  return v
}

function jobOf(raw: unknown) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {}
  const company = clean(r.company, 120)
  const role = clean(r.role, 200)
  const description = clean(r.description, 20_000)
  const url = clean(r.url, 2_000)
  let parsed: URL
  try { parsed = new URL(url) } catch { fail(400, 'job.url must be an absolute URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !company || !role) fail(400, 'job needs company, role and an http(s) URL')
  return { company, role, url, description }
}

function contextOf(raw: unknown): Row {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'context must be an object')
  // Keep the copied snapshot bounded independently of the request limit.
  const encoded = JSON.stringify(raw)
  if (encoded.length > 800_000) fail(400, 'context is too large')
  return JSON.parse(encoded) as Row
}

export type AgentApplyConnection = { id: string; user_id: string; display_name: string }

/** Tasks this exact connection may work on. Re-delivery is intentional until
 * a result arrives, so an interrupted agent can resume safely. */
export async function pendingApplyTasks(sql: Sql, conn: AgentApplyConnection, origin: string) {
  const rows = await sql<any[]>`
    select id, application_id, lead_id, job, context, resume_name, resume_mime, resume_key, submit_authorized, created_at
    from agent_apply_tasks
    where connection_id = ${conn.id} and user_id = ${conn.user_id}
      and status = 'pending' and acknowledged_at is null
    order by created_at limit 5`
  return rows.map((row) => ({
    id: `auto_apply:${row.id}`,
    task_id: row.id,
    title: `Apply to ${row.job.company} — ${row.job.role}`,
    submit_with: 'submit_application_result',
    instructions: [
      'Apply to this one approved job using your browser.',
      '- Use only facts in Landed context or facts you can verify from the application page. Never guess an answer.',
      '- Download and upload the supplied resume when the form asks for one.',
      '- The user already approved this one application, so submit it when every required field is answered and the page is unambiguous.',
      '- If a required question has no answer in context, leave it blank, stop this job, and return every missing question in unanswered.',
      '- Also stop for sign-in/account creation, CAPTCHA, a missing file, a review concern, or an unclear final submit control.',
      '- Always call submit_application_result exactly once with this task_id, even on an error.',
    ].join('\n'),
    application_id: row.application_id,
    lead_id: row.lead_id,
    job: row.job,
    context: row.context,
    resume: row.resume_name ? {
      name: row.resume_name,
      mime: row.resume_mime,
      download_url: `${origin}/api/agent/apply-files/${row.resume_key}`,
    } : null,
    submit_authorized: row.submit_authorized,
    created_at: row.created_at,
  }))
}

export async function submitApplyResult(sql: Sql, conn: AgentApplyConnection, raw: Row) {
  const taskId = uuid(raw.task_id, 'task_id')!
  const status = typeof raw.status === 'string' && (TERMINAL as readonly string[]).includes(raw.status) ? raw.status : null
  if (!status) fail(400, `status must be one of: ${TERMINAL.join(', ')}`)
  const message = clean(raw.message, 500) || null
  const blocker = typeof raw.blocker === 'string' && (BLOCKERS as readonly string[]).includes(raw.blocker) ? raw.blocker : null
  const unanswered = (Array.isArray(raw.unanswered) ? raw.unanswered : []).slice(0, 30).flatMap((item) => {
    const x = item && typeof item === 'object' ? item as Row : {}
    const question = clean(x.question, 300)
    if (!question) return []
    const key = x.key === null || typeof x.key === 'string' ? x.key : null
    const options = (Array.isArray(x.options) ? x.options : []).map((v) => clean(v, 200)).filter(Boolean).slice(0, 20)
    return [{ question, key, options }]
  })
  const normalizedStatus = unanswered.length && status === 'submitted' ? 'blocked' : status
  const result = {
    status: normalizedStatus,
    blocker: unanswered.length ? 'answers' : blocker,
    message: unanswered.length ? (message ?? `${unanswered.length} required question${unanswered.length === 1 ? '' : 's'} need an answer`) : message,
    unanswered,
    at: new Date().toISOString(),
  }
  const [row] = await sql<any[]>`
    update agent_apply_tasks
    set status = ${normalizedStatus}, result = ${sql.json(result)}, completed_at = now(), updated_at = now()
    where id = ${taskId} and connection_id = ${conn.id} and user_id = ${conn.user_id}
      and status = 'pending' and acknowledged_at is null
    returning id, application_id, status, result, completed_at`
  if (!row) {
    const [existing] = await sql<any[]>`
      select id, application_id, status, result, completed_at from agent_apply_tasks
      where id = ${taskId} and connection_id = ${conn.id} and user_id = ${conn.user_id}`
    if (!existing) fail(404, 'application task not found')
    return { duplicate: true, ...existing }
  }
  return { duplicate: false, ...row }
}

export function agentApplyAccountRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/agent-apply-tasks', async (c) => {
    return c.json(await sql`
      select ${sql(PUBLIC_COLUMNS)} from agent_apply_tasks
      where user_id = ${c.get('user').id} and acknowledged_at is null
      order by created_at`)
  })

  app.post('/agent-apply-tasks', async (c) => {
    const body = await jsonBody<Row>(c)
    const userId = c.get('user').id
    const id = uuid(body.id, 'id')!
    const connectionId = uuid(body.connection_id, 'connection_id')!
    const applicationId = uuid(body.application_id, 'application_id')!
    const leadId = uuid(body.lead_id, 'lead_id', true)
    if (body.submit_authorized !== true) fail(400, 'submit_authorized must be true')
    const job = jobOf(body.job)
    const context = contextOf(body.context)
    const [connection] = await sql`
      select id from agent_connections
      where id = ${connectionId} and user_id = ${userId} and revoked_at is null and 'tasks:read' = any(scopes)`
    if (!connection) fail(404, 'connected personal agent not found')

    let resume: ReturnType<typeof parseResumeFile> | null = null
    if (body.resume != null) {
      resume = parseResumeFile(body.resume)
      if (!resume.ok) fail(400, resume.error)
    }
    const [existing] = await sql<any[]>`
      select ${sql(PUBLIC_COLUMNS)} from agent_apply_tasks
      where user_id = ${userId} and application_id = ${applicationId} and acknowledged_at is null`
    if (existing) return c.json(existing)
    const f = resume?.ok ? resume.file : null
    const [row] = await sql`
      insert into agent_apply_tasks
        (id, user_id, connection_id, application_id, lead_id, job, context,
         resume_name, resume_mime, resume_data, submit_authorized)
      values
        (${id}, ${userId}, ${connectionId}, ${applicationId}, ${leadId}, ${sql.json(job)}, ${sql.json(context as never)},
         ${f?.name ?? null}, ${f?.mime ?? null}, ${f?.data ?? null}, true)
      returning ${sql(PUBLIC_COLUMNS)}`
    return c.json(row, 201)
  })

  app.post('/agent-apply-tasks/:id/ack', async (c) => {
    const id = uuid(c.req.param('id'), 'id')!
    const [row] = await sql`
      update agent_apply_tasks
      set acknowledged_at = now(), context = '{}'::jsonb, resume_data = null, updated_at = now()
      where id = ${id} and user_id = ${c.get('user').id}
        and status in ('submitted', 'blocked', 'error')
      returning id`
    if (!row) fail(404, 'completed application task not found')
    return c.json({ acknowledged: true })
  })

  // The user answered every question this task returned. Refresh just the
  // shared answers in its context and offer the same authorized job again;
  // the resume and the rest of the job snapshot stay unchanged.
  app.post('/agent-apply-tasks/:id/retry', async (c) => {
    const id = uuid(c.req.param('id'), 'id')!
    const body = await jsonBody<Row>(c)
    const answers = contextOf(body.application_answers)
    const [row] = await sql`
      update agent_apply_tasks
      set status = 'pending', result = null, completed_at = null, updated_at = now(),
          context = jsonb_set(context, '{application_answers}', ${sql.json(answers as never)}, true)
      where id = ${id} and user_id = ${c.get('user').id}
        and status = 'blocked' and result->>'blocker' = 'answers' and acknowledged_at is null
      returning ${sql(PUBLIC_COLUMNS)}`
    if (!row) fail(404, 'application task is not waiting for answers')
    return c.json(row)
  })

  return app
}

/** Unguessable, task-scoped file URL so an OAuth agent can hand the resume to
 * its browser without exposing its bearer token to that browser. */
export function agentApplyDownloadRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()
  app.get('/agent/apply-files/:key', async (c) => {
    const key = uuid(c.req.param('key'), 'key')!
    const [row] = await sql<any[]>`
      select resume_name, resume_mime, resume_data from agent_apply_tasks
      where resume_key = ${key} and acknowledged_at is null
        and created_at > now() - interval '7 days'`
    if (!row?.resume_data) fail(404, 'resume file not found')
    c.header('Content-Type', row.resume_mime || 'application/octet-stream')
    c.header('Content-Disposition', `attachment; filename="${String(row.resume_name).replace(/["\\\r\n]/g, '_')}"`)
    c.header('Cache-Control', 'private, no-store')
    return c.body(Buffer.from(row.resume_data, 'base64'))
  })
  return app
}

/** Hourly cleanup: a personal agent that never picks up a task must not keep
 * its copied resume/context forever. Let the browser surface an error first;
 * acknowledged rows and abandoned old rows are then removed. */
export async function purgeAgentApplyTasks(sql: Sql) {
  const expired = {
    status: 'error', blocker: null, message: 'The personal agent did not pick up this application within 7 days.', unanswered: [], at: new Date().toISOString(),
  }
  await sql`
    update agent_apply_tasks
    set status = 'error', result = ${sql.json(expired)}, completed_at = now(), updated_at = now(), resume_data = null
    where status = 'pending' and acknowledged_at is null and created_at < now() - interval '7 days'`
  await sql`
    delete from agent_apply_tasks
    where acknowledged_at < now() - interval '7 days'
       or created_at < now() - interval '30 days'`
}

