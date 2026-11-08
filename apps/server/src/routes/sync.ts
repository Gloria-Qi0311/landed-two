// Whole-account snapshots for Landed Cloud.
//
// Landed is local-first: the web app keeps data in the browser (IndexedDB)
// until the user turns on Landed Cloud sync (routes/account.ts). These
// routes move a whole snapshot across that boundary, in the same
// `landed-backup` format the web app uses for backup files:
//
//   GET    /export        cloud → snapshot (backup, turning sync off)
//   POST   /sync/upload   snapshot → cloud (restoring a backup into Cloud)
//
// uploadSnapshot() is also what turning sync on runs (POST /cloud/enable).
//
// Upload keeps the client-generated ids, so it is idempotent: re-sending the
// same snapshot inserts nothing new. Companies merge by name and portal
// connections by (company, provider), so signing in on a second device that
// has its own data merges rather than duplicates.
import { parseSourceRuns } from '@landed/schema/automation'
import { parseDirections, parseMasterResume, parseResumeChoice } from '@landed/schema/master-resume'
import { parseOpenAnswers } from '@landed/schema/open-answers'
import { leadQueueDefaults } from '@landed/schema/lead-queue'
import { normalizeStage, parseInterviews } from '@landed/schema/pipeline'
import { parseBrief } from '@landed/schema/search-brief'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'
import { LEAD_COLUMNS, SUGGESTION_COLUMNS } from './inbox.ts'
import { SEARCH_COLUMNS } from './searches.ts'
import { CONVERSATION_COLUMNS } from './conversations.ts'
import { parseConversation } from '@landed/schema/conversation'
import { parseApplicationAnswers } from '@landed/schema/application-answers'
import { ANSWER_COLUMNS } from './answers.ts'
import { FILE_COLUMNS, RESUME_FILE_COLUMNS } from './files.ts'
import { parseApplicationFile, parseResumeFile } from '@landed/schema/application-files'

// Loosely-typed JSON row (request bodies, jsonb values) for the sql() helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export const BACKUP_FORMAT = 'landed-backup'
export const BACKUP_VERSION = 1

const TABLES = [
  'companies', 'applications', 'resumes', 'portal_connections', 'portal_events', 'ai_runs',
  'job_leads', 'status_suggestions', 'job_searches', 'agent_conversations', 'application_answers', 'application_files',
  'resume_files',
] as const
const MAX_ROWS_PER_TABLE = 20_000
const CHUNK = 500

const COLUMNS = {
  companies: ['id', 'name', 'hue', 'logo_chars', 'sector', 'loc', 'portal_url', 'created_at'],
  applications: [
    'id', 'company_id', 'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at',
    'next_step', 'referral', 'source', 'job_id', 'portal_application_url', 'notes', 'starred',
    'last_activity_at', 'created_at', 'interviews', 'deadline', 'resume_choice', 'open_answers',
  ],
  portal_connections: [
    'id', 'company_id', 'provider', 'portal_host', 'status', 'last_sync_at', 'last_seen_login_at',
    'failure_reason', 'created_at',
  ],
  portal_events: ['id', 'connection_id', 'application_id', 'type', 'payload_json', 'created_at'],
  resumes: ['id', 'name', 'file_path', 'parsed_json', 'is_current', 'created_at', 'kind', 'master_json', 'target_json', 'directions'],
  ai_runs: ['id', 'task', 'provider', 'prompt_text', 'response_text', 'parsed_json', 'parse_format', 'created_at'],
  job_leads: LEAD_COLUMNS,
  status_suggestions: SUGGESTION_COLUMNS,
  job_searches: SEARCH_COLUMNS,
  agent_conversations: CONVERSATION_COLUMNS,
  application_answers: ANSWER_COLUMNS,
  application_files: FILE_COLUMNS,
  resume_files: RESUME_FILE_COLUMNS,
} as const

// NOT NULL columns get their DB default when a snapshot row omits them, so
// multi-row inserts (which need every column present) don't trip on null.
function defaults(now: string): Row {
  return {
    created_at: now, last_activity_at: now, referral: false, starred: false, stage: 'saved',
    status: 'active', payload_json: {}, is_current: false, processing_status: 'pending',
    sources: [], candidate_ids: [], evidence: {}, observation_ids: [], state: 'pending', updated_at: now,
    interviews: [], kind: 'source',
  }
}

const JSON_COLUMNS = new Set([
  'payload_json', 'parsed_json', 'processing_result', 'sources', 'candidate_ids', 'evidence', 'observation_ids',
  'brief', 'last_run_result', 'source_runs', 'interviews', 'master_json', 'target_json', 'turns', 'answers', 'screen', 'fit', 'dedupe', 'rank', 'resume_choice', 'open_answers',
])

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK))
  return out
}

/** Validate + merge a snapshot into the user's Cloud rows. Run it inside a
 *  transaction (`tx`) so a bad row rejects the whole upload. */
export async function uploadSnapshot(tx: Sql, userId: string, snap: Row): Promise<Row> {
  if (snap.format !== BACKUP_FORMAT || snap.version !== BACKUP_VERSION) {
    fail(400, `not a ${BACKUP_FORMAT} v${BACKUP_VERSION} snapshot`)
  }
  for (const table of TABLES) {
    if (snap[table] !== undefined && !Array.isArray(snap[table])) fail(400, `${table} must be an array`)
    if ((snap[table]?.length ?? 0) > MAX_ROWS_PER_TABLE) fail(400, `${table}: too many rows`)
  }
  const list = (t: typeof TABLES[number]): Row[] => (snap[t] ?? []).filter((r: unknown) => r && typeof r === 'object')
  const base = defaults(new Date().toISOString())

  const normalize = (table: keyof typeof COLUMNS, r: Row, overrides: Row) => {
    const out: Row = { user_id: userId }
    for (const col of COLUMNS[table]) {
      const v = col in overrides ? overrides[col] : (r[col] ?? base[col] ?? null)
      out[col] = JSON_COLUMNS.has(col) && v !== null ? tx.json(v) : v
    }
    return out
  }

  // Insert in chunks; rows whose id already exists are skipped, which is
  // what makes a retried upload a no-op. `anyConflict` also skips rows that
  // collide on another unique key (a lead/suggestion the account already has).
  const insertRows = async (table: string, rows: Row[], anyConflict = false) => {
    let n = 0
    for (const chunk of chunks(rows)) {
      const res = anyConflict
        ? await tx`insert into ${tx(table)} ${tx(chunk)} on conflict do nothing returning id`
        : await tx`insert into ${tx(table)} ${tx(chunk)} on conflict (id) do nothing returning id`
      n += res.length
    }
    return n
  }

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
  counts.companies = await insertRows('companies', newCompanies)
  counts.companies_merged = merged

  // applications — re-pointed at the merged company ids
  const appIds = new Set<string>()
  const apps: Row[] = []
  for (const r of list('applications')) {
    const cid = companyId.get(r.company_id)
    if (!cid) continue // orphan: its company isn't in the snapshot
    appIds.add(r.id)
    // Older backups: phone/onsite → interview (+ the round it stood for).
    const stage = normalizeStage(r.stage ?? 'saved')
    if (!stage) fail(400, `applications[]: unknown stage ${JSON.stringify(r.stage)}`)
    const interviews = parseInterviews(r.interviews) ?? (stage.round ? [stage.round] : [])
    apps.push(normalize('applications', r, { company_id: cid, stage: stage.stage, interviews, resume_choice: parseResumeChoice(r.resume_choice) ?? null, open_answers: parseOpenAnswers(r.open_answers) ?? null }))
  }
  counts.applications = await insertRows('applications', apps)

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
  counts.portal_connections = await insertRows('portal_connections', conns)

  // portal_events — references outside the snapshot become null
  counts.portal_events = await insertRows('portal_events', list('portal_events').map((r) =>
    normalize('portal_events', r, {
      connection_id: connectionId.get(r.connection_id) ?? null,
      application_id: appIds.has(r.application_id) ? r.application_id : null,
    })))

  // resumes — the cloud's current resume wins; uploaded ones join as non-current
  const [{ has_current }] = await tx<{ has_current: boolean }[]>`
    select exists (select 1 from resumes where user_id = ${userId} and is_current) as has_current`
  let currentTaken = has_current
  // ...and the cloud's master wins too (one per account); an uploaded master
  // arrives as a version so nothing is lost.
  const [{ has_master }] = await tx<{ has_master: boolean }[]>`
    select exists (select 1 from resumes where user_id = ${userId} and kind = 'master') as has_master`
  let masterTaken = has_master
  counts.resumes = await insertRows('resumes', list('resumes').map((r) => {
    const isCurrent = r.is_current === true && !currentTaken
    if (isCurrent) currentTaken = true
    let kind = ['source', 'master', 'version'].includes(r.kind) ? r.kind : 'source'
    const master = kind === 'master' ? parseMasterResume(r.master_json) : null
    if (kind === 'master' && (masterTaken || !master)) kind = 'version'
    if (kind === 'master') masterTaken = true
    return normalize('resumes', r, { is_current: isCurrent, kind, master_json: kind === 'master' ? master : null, directions: parseDirections(r.directions) ?? [] })
  }))

  counts.ai_runs = await insertRows('ai_runs', list('ai_runs').map((r) => normalize('ai_runs', r, {})))

  // processor output — application refs outside the snapshot become null
  const appRef = (id: unknown) => (typeof id === 'string' && appIds.has(id) ? id : null)
  counts.job_leads = await insertRows('job_leads', list('job_leads')
    .filter((r) => typeof r.fingerprint === 'string')
    // Backups from before the queue fields (0021) have none; unreadable ones become null.
    .map((r) => normalize('job_leads', r, { application_id: appRef(r.application_id), ...leadQueueDefaults(r) })), true)
  const stageOf = (v: unknown) => (v == null ? null : normalizeStage(v)?.stage ?? null)
  counts.status_suggestions = await insertRows('status_suggestions', list('status_suggestions')
    .filter((r) => typeof r.dedupe_key === 'string')
    .map((r) => normalize('status_suggestions', r, {
      application_id: appRef(r.application_id), proposed_stage: stageOf(r.proposed_stage), previous_stage: stageOf(r.previous_stage),
    })), true)

  // searches — an uploaded active search loses to the account's current one
  // (one active per account), so it arrives archived instead.
  const [{ has_active }] = await tx<{ has_active: boolean }[]>`
    select exists (select 1 from job_searches where user_id = ${userId} and status = 'active') as has_active`
  let activeTaken = has_active
  counts.job_searches = await insertRows('job_searches', list('job_searches')
    .filter((r) => parseBrief(r.brief))
    .map((r) => {
      const active = r.status === 'active' && !activeTaken
      if (active) activeTaken = true
      const runs = parseSourceRuns(r.source_runs)
      return normalize('job_searches', r, {
        brief: parseBrief(r.brief), status: active ? 'active' : 'archived', source_runs: Object.keys(runs).length ? runs : null,
      })
    }), true)

  // chat history — validated like a PUT; an id the account already has is kept as is
  counts.agent_conversations = await insertRows('agent_conversations', list('agent_conversations')
    .map((r) => parseConversation(r))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => normalize('agent_conversations', c, { turns: c.turns, updated_at: c.updated_at ?? base.created_at })))

  // application answers — one per account; the account's own copy wins
  counts.application_answers = await insertRows('application_answers', list('application_answers').slice(0, 1)
    .filter((r) => typeof r.id === 'string')
    .map((r) => normalize('application_answers', r, { answers: parseApplicationAnswers(r.answers), updated_at: r.updated_at ?? base.created_at })), true)

  // files for the extension — one per kind; the account's own copy wins
  counts.application_files = await insertRows('application_files', list('application_files')
    .map((r) => parseApplicationFile(r))
    .flatMap((p) => (p.ok ? [p.file] : []))
    .filter((f, i, all) => all.findIndex((x) => x.kind === f.kind) === i)
    .map((f) => normalize('application_files', f, {})), true)

  // each uploaded resume's own file — only for resumes in this upload, one each
  const resumeIds = new Set(list('resumes').map((r) => r.id))
  counts.resume_files = await insertRows('resume_files', list('resume_files')
    .map((r) => parseResumeFile(r))
    .flatMap((p) => (p.ok && resumeIds.has(p.file.resume_id) ? [p.file] : []))
    .filter((f, i, all) => all.findIndex((x) => x.resume_id === f.resume_id) === i)
    .map((f) => normalize('resume_files', f, {})), true)

  const onboarded = snap.profile?.onboarded_at
  if (typeof onboarded === 'string') {
    await tx`update users set onboarded_at = coalesce(onboarded_at, ${onboarded}) where id = ${userId}`
  }
  return counts
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
      snapshot[table] = await sql`
        select ${sql(COLUMNS[table] as unknown as string[])} from ${sql(table)}
        where user_id = ${userId}`
    }
    return c.json(snapshot)
  })

  app.post('/sync/upload', async (c) => {
    const snap = await jsonBody<Row>(c)
    const userId = c.get('user').id
    const result = await sql.begin((tx) => uploadSnapshot(tx as unknown as Sql, userId, snap))
    return c.json(result, 201)
  })

  return app
}
