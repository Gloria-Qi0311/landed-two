// REST routes for the user-owned tables (replaces PostgREST + RLS). Mounted
// behind requireCloud: they only serve accounts with Landed Cloud sync on.
//
// Every query is scoped by the session's user_id. Rows come back in the same
// snake_case JSON shape PostgREST returned, so the web hooks' transform
// layer (toAppShape etc.) is unchanged. Bad enum values / foreign ids /
// cross-user references are rejected by Postgres (see migrations/0001) and
// mapped to 400 by the app-level error handler.
import { normalizeStage, parseInterviews, STAGE_VALUES } from '@landed/schema/pipeline'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Config } from '../config.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody, pick } from '../http.ts'
import { encryptSecret } from '../secrets.ts'

const APPLICATION_FIELDS = [
  'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at', 'next_step',
  'referral', 'source', 'job_id', 'portal_application_url', 'notes', 'starred', 'last_activity_at', 'interviews',
] as const
const APPLICATION_PATCH_FIELDS = [
  'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at', 'next_step',
  'referral', 'source', 'notes', 'starred', 'interviews',
] as const
const COMPANY_FIELDS = ['name', 'hue', 'logo_chars', 'sector', 'loc', 'portal_url'] as const

// Loosely-typed JSON row (request bodies, jsonb values) for the sql() helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(400, `${field} is required`)
  return v
}

/** Application columns from a request: stage normalized (legacy phone /
 *  onsite → interview, plus the round it stood for on create) and interview
 *  rounds validated. */
function applicationColumns(sql: Sql, input: Row, fields: readonly string[], opts: { create: boolean }): Row {
  const out: Row = pick(input, fields)
  if (out.stage !== undefined) {
    const n = normalizeStage(out.stage)
    if (!n) fail(400, `stage must be one of: ${STAGE_VALUES.join(', ')}`)
    out.stage = n.stage
    if (opts.create && n.round && out.interviews === undefined) out.interviews = [n.round]
  }
  if (out.interviews !== undefined) {
    const rounds = parseInterviews(out.interviews)
    if (!rounds) fail(400, 'interviews must be an array of rounds')
    out.interviews = sql.json(rounds)
  }
  return out
}

export function dataRoutes(sql: Sql, config: Config) {
  const app = new Hono<AppEnv>()

  // ── companies + applications ──────────────────────────────────────────

  app.get('/companies', async (c) => {
    return c.json(await sql`select * from companies where user_id = ${c.get('user').id}`)
  })

  app.get('/applications', async (c) => {
    return c.json(await sql`
      select * from applications where user_id = ${c.get('user').id}
      order by last_activity_at desc`)
  })

  // Create an application, finding-or-creating its company by name in the
  // same transaction. Body: { company: {name, hue?, ...}, application: {role, ...} }
  app.post('/applications', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<{ company?: Row; application?: Row }>(c)
    const company = body.company ?? {}
    const application = body.application ?? {}
    const name = requireString(company.name, 'company.name').trim()
    requireString(application.role, 'application.role')

    const row = await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`
        select id from companies where user_id = ${userId} and name = ${name}
        order by created_at limit 1`
      const companyId = existing?.id ?? (await tx<{ id: string }[]>`
        insert into companies ${tx({ ...pick(company, COMPANY_FIELDS), name, user_id: userId })}
        returning id`)[0].id
      const [inserted] = await tx`
        insert into applications ${tx({ ...applicationColumns(sql, application, APPLICATION_FIELDS, { create: true }), user_id: userId, company_id: companyId })}
        returning *`
      return inserted
    })
    return c.json(row, 201)
  })

  app.patch('/applications/:id', async (c) => {
    const patch = applicationColumns(sql, await jsonBody(c), APPLICATION_PATCH_FIELDS, { create: false })
    const [row] = await sql`
      update applications set ${sql({ ...patch, last_activity_at: new Date().toISOString() })}
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning *`
    if (!row) fail(404, 'application not found')
    return c.json(row)
  })

  // Bulk import (demo data). Body: { companies: [{name, ...}], applications:
  // [{company_name, role, ...}] } — applications reference companies by name.
  app.post('/import', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody<{ companies?: Row[]; applications?: Row[] }>(c)
    const companies = Array.isArray(body.companies) ? body.companies : []
    const applications = Array.isArray(body.applications) ? body.applications : []
    if (companies.length > 500 || applications.length > 2000) fail(400, 'import too large')

    const counts = await sql.begin(async (tx) => {
      const nameToId = new Map<string, string>()
      for (const co of companies) {
        const name = requireString(co.name, 'companies[].name').trim()
        const [row] = await tx<{ id: string }[]>`
          insert into companies ${tx({ ...pick(co, COMPANY_FIELDS), name, user_id: userId })}
          returning id`
        nameToId.set(name, row.id)
      }
      let inserted = 0
      for (const a of applications) {
        const companyId = nameToId.get(String(a.company_name ?? '').trim())
        if (!companyId) continue
        requireString(a.role, 'applications[].role')
        await tx`
          insert into applications ${tx({ ...applicationColumns(sql, a, APPLICATION_FIELDS, { create: true }), user_id: userId, company_id: companyId })}`
        inserted++
      }
      return { companies: nameToId.size, applications: inserted }
    })
    return c.json(counts, 201)
  })

  // ── resumes ───────────────────────────────────────────────────────────
  // At most one is_current per user (partial unique index). Promotion
  // demotes + promotes in one transaction, which also closes the multi-tab
  // race the client-side two-step had.

  app.get('/resumes', async (c) => {
    return c.json(await sql`
      select * from resumes where user_id = ${c.get('user').id}
      order by created_at desc`)
  })

  app.post('/resumes', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody(c)
    const name = requireString(body.name, 'name')
    const setCurrent = body.set_current === true
    const row = await sql.begin(async (tx) => {
      if (setCurrent) await tx`update resumes set is_current = false where user_id = ${userId} and is_current`
      const [inserted] = await tx`
        insert into resumes (user_id, name, parsed_json, is_current)
        values (${userId}, ${name}, ${body.parsed_json == null ? null : tx.json(body.parsed_json as Row)}, ${setCurrent})
        returning *`
      return inserted
    })
    return c.json(row, 201)
  })

  app.patch('/resumes/:id', async (c) => {
    const body = await jsonBody(c)
    const patch: Row = {}
    if (body.name !== undefined) patch.name = requireString(body.name, 'name')
    if (body.parsed_json !== undefined) patch.parsed_json = body.parsed_json === null ? null : sql.json(body.parsed_json as Row)
    if (Object.keys(patch).length === 0) fail(400, 'nothing to update (allowed: name, parsed_json)')
    const [row] = await sql`
      update resumes set ${sql(patch)}
      where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning *`
    if (!row) fail(404, 'resume not found')
    return c.json(row)
  })

  app.delete('/resumes/:id', async (c) => {
    const [row] = await sql`
      delete from resumes where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning id`
    if (!row) fail(404, 'resume not found')
    return c.body(null, 204)
  })

  app.post('/resumes/:id/current', async (c) => {
    const userId = c.get('user').id
    const id = c.req.param('id')
    const row = await sql.begin(async (tx) => {
      await tx`update resumes set is_current = false where user_id = ${userId} and is_current and id <> ${id}`
      const [updated] = await tx`
        update resumes set is_current = true where id = ${id} and user_id = ${userId}
        returning *`
      if (!updated) fail(404, 'resume not found')
      return updated
    })
    return c.json(row)
  })

  // ── ai_runs ───────────────────────────────────────────────────────────

  app.post('/ai-runs', async (c) => {
    const body = await jsonBody(c)
    const [row] = await sql<{ id: string }[]>`
      insert into ai_runs (user_id, task, provider, prompt_text, response_text, parsed_json, parse_format)
      values (
        ${c.get('user').id}, ${body.task as string}, ${body.provider as string},
        ${requireString(body.prompt_text, 'prompt_text')},
        ${(body.response_text as string) ?? null},
        ${body.parsed_json == null ? null : sql.json(body.parsed_json as Row)},
        ${(body.parse_format as string) ?? null}
      )
      returning id`
    return c.json(row, 201)
  })

  // ── ai_provider_keys (write-only secrets) ─────────────────────────────

  app.get('/ai-keys', async (c) => {
    return c.json(await sql`
      select id, provider, label, last_used_at, created_at from ai_provider_keys
      where user_id = ${c.get('user').id} order by provider`)
  })

  // Create or rotate the key for (user, provider). Never returns the secret.
  app.put('/ai-keys/:provider', async (c) => {
    const body = await jsonBody(c)
    const secret = typeof body.secret === 'string' ? body.secret.trim() : ''
    if (!secret) fail(400, 'secret must not be empty')
    if (secret.length > 4096) fail(400, 'secret too long (max 4096 chars)')
    const label = typeof body.label === 'string' ? body.label : null
    const [row] = await sql`
      insert into ai_provider_keys (user_id, provider, secret_ciphertext, label)
      values (${c.get('user').id}, ${c.req.param('provider')}, ${encryptSecret(config.secretsKey, secret)}, ${label})
      on conflict (user_id, provider) do update
        set secret_ciphertext = excluded.secret_ciphertext, label = excluded.label, created_at = now()
      returning id, provider, label, last_used_at, created_at`
    return c.json(row)
  })

  app.delete('/ai-keys/:id', async (c) => {
    const [row] = await sql`
      delete from ai_provider_keys where id = ${c.req.param('id')} and user_id = ${c.get('user').id}
      returning id`
    if (!row) fail(404, 'key not found')
    return c.body(null, 204)
  })

  return app
}
