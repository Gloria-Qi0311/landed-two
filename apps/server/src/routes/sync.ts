// Moving data between this device and Landed Cloud.
//
// Landed is local-first: the web app keeps data in the browser (IndexedDB)
// until the user turns on Landed Cloud. These routes move a whole snapshot
// across that boundary, in the same `landed-backup` format the web app uses
// for backup files:
//
//   GET    /export        cloud → snapshot (download, "leave Cloud", backup)
//   POST   /sync/upload   snapshot → cloud (turning Cloud on / merging a device)
//   DELETE /me            delete the account and all its rows (password re-check)
//
// Upload keeps the client-generated ids, so it is idempotent: re-sending the
// same snapshot inserts nothing new. Companies merge by name and portal
// connections by (company, provider), so signing in on a second device that
// has its own data merges rather than duplicates.
import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE, verifyPassword, type AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

// Loosely-typed JSON row (request bodies, jsonb values) for the sql() helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export const BACKUP_FORMAT = 'landed-backup'
export const BACKUP_VERSION = 1

const TABLES = ['companies', 'applications', 'resumes', 'portal_connections', 'portal_events', 'ai_runs'] as const
const MAX_ROWS_PER_TABLE = 20_000
const CHUNK = 500

const COLUMNS = {
  companies: ['id', 'name', 'hue', 'logo_chars', 'sector', 'loc', 'portal_url', 'created_at'],
  applications: [
    'id', 'company_id', 'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at',
    'next_step', 'referral', 'source', 'job_id', 'portal_application_url', 'notes', 'starred',
    'last_activity_at', 'created_at',
  ],
  portal_connections: [
    'id', 'company_id', 'provider', 'portal_host', 'status', 'last_sync_at', 'last_seen_login_at',
    'failure_reason', 'created_at',
  ],
  portal_events: ['id', 'connection_id', 'application_id', 'type', 'payload_json', 'created_at'],
  resumes: ['id', 'name', 'file_path', 'parsed_json', 'is_current', 'created_at'],
  ai_runs: ['id', 'task', 'provider', 'prompt_text', 'response_text', 'parsed_json', 'parse_format', 'created_at'],
} as const

// NOT NULL columns get their DB default when a snapshot row omits them, so
// multi-row inserts (which need every column present) don't trip on null.
function defaults(now: string): Row {
  return {
    created_at: now, last_activity_at: now, referral: false, starred: false, stage: 'saved',
    status: 'active', payload_json: {}, is_current: false,
  }
}

const JSON_COLUMNS = new Set(['payload_json', 'parsed_json'])

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK))
  return out
}

export function syncRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/export', async (c) => {
    const userId = c.get('user').id
    const [profile] = await sql`select onboarded_at from users where id = ${userId}`
    const snapshot: Row = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      profile: { onboarded_at: profile.onboarded_at },
    }
    for (const table of TABLES) {
      const rows = await sql`select ${sql(COLUMNS[table] as unknown as string[])} from ${sql(table)} where user_id = ${userId}`
      snapshot[table] = rows
    }
    return c.json(snapshot)
  })

  app.post('/sync/upload', async (c) => {
    const userId = c.get('user').id
    const snap = await jsonBody<Row>(c)
    if (snap.format !== BACKUP_FORMAT || snap.version !== BACKUP_VERSION) {
      fail(400, `not a ${BACKUP_FORMAT} v${BACKUP_VERSION} snapshot`)
    }
    for (const table of TABLES) {
      if (snap[table] !== undefined && !Array.isArray(snap[table])) fail(400, `${table} must be an array`)
      if ((snap[table]?.length ?? 0) > MAX_ROWS_PER_TABLE) fail(400, `${table}: too many rows`)
    }
    const list = (t: typeof TABLES[number]): Row[] => (snap[t] ?? []).filter((r: unknown) => r && typeof r === 'object')
    const now = new Date().toISOString()
    const base = defaults(now)

    const normalize = (table: keyof typeof COLUMNS, r: Row, overrides: Row) => {
      const out: Row = { user_id: userId }
      for (const col of COLUMNS[table]) {
        const v = col in overrides ? overrides[col] : (r[col] ?? base[col] ?? null)
        out[col] = JSON_COLUMNS.has(col) && v !== null ? sql.json(v) : v
      }
      return out
    }

    // Insert one chunk; rows whose id already exists are skipped, which is
    // what makes a retried upload a no-op.
    const insertRows = async (tx: Sql, table: string, rows: Row[]) => {
      let n = 0
      for (const chunk of chunks(rows)) {
        const res = await tx`insert into ${tx(table)} ${tx(chunk)} on conflict (id) do nothing returning id`
        n += res.length
      }
      return n
    }

    const result = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql
      const counts: Row = {}

      // companies — merge by name onto the user's existing rows
      const companyId = new Map<string, string>()
      const existing = await tx<{ id: string; name: string }[]>`select id, name from companies where user_id = ${userId}`
      const byName = new Map(existing.map((r) => [r.name, r.id]))
      let merged = 0
      const newCompanies: Row[] = []
      for (const r of list('companies')) {
        if (typeof r.id !== 'string' || typeof r.name !== 'string' || !r.name.trim()) fail(400, 'companies[] need id + name')
        const hit = byName.get(r.name)
        if (hit) { companyId.set(r.id, hit); merged++; continue }
        byName.set(r.name, r.id)
        companyId.set(r.id, r.id)
        newCompanies.push(normalize('companies', r, {}))
      }
      counts.companies = await insertRows(tx, 'companies', newCompanies)
      counts.companies_merged = merged

      // applications — re-pointed at the merged company ids
      const appIds = new Set<string>()
      const apps: Row[] = []
      for (const r of list('applications')) {
        const cid = companyId.get(r.company_id)
        if (!cid) continue // orphan: its company isn't in the snapshot
        appIds.add(r.id)
        apps.push(normalize('applications', r, { company_id: cid }))
      }
      counts.applications = await insertRows(tx, 'applications', apps)

      // portal_connections — merge on (company, provider)
      const connectionId = new Map<string, string>()
      const existingConns = await tx<{ id: string; company_id: string; provider: string }[]>`
        select id, company_id, provider from portal_connections where user_id = ${userId}`
      const connKey = new Map(existingConns.map((r) => [`${r.company_id}|${r.provider}`, r.id]))
      const conns: Row[] = []
      for (const r of list('portal_connections')) {
        const cid = companyId.get(r.company_id)
        if (!cid) continue
        const key = `${cid}|${r.provider}`
        const hit = connKey.get(key)
        if (hit) { connectionId.set(r.id, hit); continue }
        connKey.set(key, r.id)
        connectionId.set(r.id, r.id)
        conns.push(normalize('portal_connections', r, { company_id: cid }))
      }
      counts.portal_connections = await insertRows(tx, 'portal_connections', conns)

      // portal_events — references outside the snapshot become null
      counts.portal_events = await insertRows(tx, 'portal_events', list('portal_events').map((r) =>
        normalize('portal_events', r, {
          connection_id: connectionId.get(r.connection_id) ?? null,
          application_id: appIds.has(r.application_id) ? r.application_id : null,
        })))

      // resumes — the cloud's current resume wins; uploaded ones join as non-current
      const [{ has_current }] = await tx<{ has_current: boolean }[]>`
        select exists (select 1 from resumes where user_id = ${userId} and is_current) as has_current`
      let currentTaken = has_current
      counts.resumes = await insertRows(tx, 'resumes', list('resumes').map((r) => {
        const isCurrent = r.is_current === true && !currentTaken
        if (isCurrent) currentTaken = true
        return normalize('resumes', r, { is_current: isCurrent })
      }))

      counts.ai_runs = await insertRows(tx, 'ai_runs', list('ai_runs').map((r) => normalize('ai_runs', r, {})))

      const onboarded = snap.profile?.onboarded_at
      if (typeof onboarded === 'string') {
        await tx`update users set onboarded_at = coalesce(onboarded_at, ${onboarded}) where id = ${userId}`
      }
      return counts
    })
    return c.json(result, 201)
  })

  // Delete the account and every row it owns (ON DELETE CASCADE). Requires
  // the password again so a stolen session alone can't wipe the account.
  app.delete('/me', async (c) => {
    const userId = c.get('user').id
    const body = await jsonBody(c)
    const [row] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${userId}`
    if (typeof body.password !== 'string' || !(await verifyPassword(body.password, row.password_hash))) {
      fail(403, 'wrong password')
    }
    await sql`delete from users where id = ${userId}`
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  return app
}
