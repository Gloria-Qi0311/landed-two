// Local store — every row lives in this browser's IndexedDB (via Dexie), one
// database per account. This is the default: nothing leaves the device
// until the account turns on Landed Cloud sync.
//
// It mirrors the server's semantics (apps/server/src/routes/*) closely —
// same defaults, same enum checks, same "reference must exist" rules — so a
// device's data always uploads cleanly when the user turns Cloud on.
import Dexie, { type Table } from 'dexie'
import { parseConversation } from '@landed/schema/conversation'
import { parseApplicationAnswers } from '@landed/schema/application-answers'
import { parseApplicationFile } from '@landed/schema/application-files'
import { parseMasterResume, parseTailorNotes, parseTarget } from '@landed/schema/master-resume'
import { leadQueueDefaults, readLeadQueueFields } from '@landed/schema/lead-queue'
import { normalizeStage, orderRounds, parseDeadline, parseInterviews, sortRounds, STAGE_VALUES } from '@landed/schema/pipeline'
import { parseBrief } from '@landed/schema/search-brief'
import { companyKey, titleKey } from '@landed/observation-processor'
import {
  APPLICATION_PATCH_FIELDS, BACKUP_FORMAT, BACKUP_VERSION, SNAPSHOT_TABLES,
  type AiRunInput, type ApplicationInput, type DbAgentObservation, type DbApplicationAnswers, type DbApplicationFile, type DbConversation, type DbJobLead, type DbJobSearch, type DbSuggestion, type ApplicationPatch, type CompanyInput, type ConnectionInput,
  type DataStore, type DbAiRun, type DbApplication, type DbCompany, type DbPortalConnection,
  type DbPortalEvent, type DbResume, type DemoImport, type PortalEventInput, type Snapshot,
} from './types'

const LOCAL_USER = 'local'

const REMOTES = ['Remote', 'Hybrid', 'On-site']
const PROVIDERS = ['greenhouse', 'lever', 'workday', 'ashby', 'bamboohr', 'boss', 'smartrecruiters', 'other']
const STATUSES = ['active', 'syncing', 'expired', 'disconnected']
const EVENT_TYPES = ['status-change', 'new-event', 'expired', 'sync', 'rejection']
const AI_TASKS = ['resume_match', 'jd_breakdown', 'resume_tailor']
const AI_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'other']
const PARSE_FORMATS = ['json', 'markdown', 'heuristic', 'failed']

export class LocalStoreError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function oneOf(value: unknown, allowed: string[], field: string) {
  if (value != null && !allowed.includes(value as string)) {
    throw new LocalStoreError(400, `${field} must be one of: ${allowed.join(', ')}`)
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new LocalStoreError(400, `${field} is required`)
  return value
}

// Strictly increasing timestamps: two writes in the same millisecond still
// get distinct, ordered created_at / last_activity_at values, so "newest
// first" lists are deterministic (the server gets this from now()'s µs).
let lastTs = 0
const now = () => {
  lastTs = Math.max(Date.now(), lastTs + 1)
  return new Date(lastTs).toISOString()
}
const uuid = () => crypto.randomUUID()

// v1 shipped a `meta` table (device profile); profile moved to the account
// on the server. The table stays in the schema — Dexie versions are
// append-only — but nothing reads or writes it.
type Meta = { key: string; value: unknown }

class LandedDB extends Dexie {
  companies!: Table<DbCompany, string>
  applications!: Table<DbApplication, string>
  resumes!: Table<DbResume, string>
  portal_connections!: Table<DbPortalConnection, string>
  portal_events!: Table<DbPortalEvent, string>
  ai_runs!: Table<DbAiRun, string>
  meta!: Table<Meta, string>
  agent_observations!: Table<DbAgentObservation, string>
  job_leads!: Table<DbJobLead, string>
  status_suggestions!: Table<DbSuggestion, string>
  job_searches!: Table<DbJobSearch, string>
  agent_conversations!: Table<DbConversation, string>
  application_answers!: Table<DbApplicationAnswers, string>
  application_files!: Table<DbApplicationFile & { data: string }, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      companies: 'id, name',
      applications: 'id, company_id, last_activity_at',
      resumes: 'id, created_at',
      portal_connections: 'id, [company_id+provider]',
      portal_events: 'id, created_at',
      ai_runs: 'id',
      meta: 'key',
    })
    // v2: raw inbox of agent reports, pulled from the server's relay.
    this.version(2).stores({
      agent_observations: 'id, created_at, &[connection_id+idempotency_key]',
    })
    // v3: observation processor output + a processing-status index.
    this.version(3).stores({
      agent_observations: 'id, created_at, &[connection_id+idempotency_key], processing_status',
      job_leads: 'id, &fingerprint, status, last_seen_at',
      status_suggestions: 'id, &dedupe_key, state, created_at',
    })
    // v4: job search briefs confirmed in the Agent chat.
    this.version(4).stores({
      job_searches: 'id, status, created_at',
    })
    // v5: one `interview` stage with interview rounds replaces phone + onsite.
    this.version(5).stores({}).upgrade(async (tx) => {
      await tx.table('applications').toCollection().modify((a: DbApplication) => {
        const n = normalizeStage(a.stage)
        a.interviews = parseInterviews(a.interviews) ?? (n?.round ? [n.round] : [])
        if (n) a.stage = n.stage
      })
      await tx.table('status_suggestions').toCollection().modify((s: DbSuggestion) => {
        if (s.proposed_stage) s.proposed_stage = normalizeStage(s.proposed_stage)?.stage ?? s.proposed_stage
        if (s.previous_stage) s.previous_stage = normalizeStage(s.previous_stage)?.stage ?? s.previous_stage
      })
    })
    // v6: My Resume kinds — everything uploaded so far is a source.
    this.version(6).stores({}).upgrade(async (tx) => {
      await tx.table('resumes').toCollection().modify((r: DbResume) => {
        r.kind ??= 'source'
        r.master_json ??= null
        r.target_json ??= null
      })
    })
    // v7: Agent chat history.
    this.version(7).stores({
      agent_conversations: 'id, updated_at',
    })
    // v8: company and title keys keep non-Latin names — they used to come
    // out empty, so every Chinese company's leads matched each other.
    this.version(8).stores({}).upgrade(async (tx) => {
      await tx.table('job_leads').toCollection().modify((l: DbJobLead) => {
        l.company_key = companyKey(l.company_name)
        l.title_key = titleKey(l.title)
      })
    })
    // v9: interview rounds from emails read newest first were numbered
    // backwards — number rounds that all have a time by that time.
    this.version(9).stores({}).upgrade(async (tx) => {
      await tx.table('applications').toCollection().modify((a: DbApplication) => {
        if (Array.isArray(a.interviews)) a.interviews = orderRounds(a.interviews)
      })
    })
    // v10: again with the final rule — numbers that disagree with the times
    // restart from 1 (v9 kept the lowest number), listed by round.
    this.version(10).stores({}).upgrade(async (tx) => {
      await tx.table('applications').toCollection().modify((a: DbApplication) => {
        if (Array.isArray(a.interviews)) a.interviews = sortRounds(orderRounds(a.interviews))
      })
    })
    // v11: answers to the questions forms ask that a resume doesn't.
    this.version(11).stores({
      application_answers: 'id',
    })
    // v12: the resume / cover letter files the extension uploads.
    this.version(12).stores({
      application_files: 'id, &kind',
    })
    // v13: the apply queue's fields on leads (docs/leads-model.md): posted
    // and closed dates, hard-filter result, fit score. Empty until the
    // supply track fills them.
    this.version(13).stores({}).upgrade(async (tx) => {
      await tx.table('job_leads').toCollection().modify((l: DbJobLead) => {
        Object.assign(l, leadQueueDefaults(l as unknown as Record<string, unknown>))
      })
    })
  }
}

/** The queue fields in a lead write, validated like the server (400). */
function leadQueueOf(input: Record<string, unknown>) {
  const read = readLeadQueueFields(input)
  if (!read.ok) throw new LocalStoreError(400, read.error.message)
  return read.fields
}

/** master_json / target_json validated like the server does (null clears). */
function resumeExtras(input: { master_json?: unknown; target_json?: unknown }) {
  const out: Partial<Pick<DbResume, 'master_json' | 'target_json'>> = {}
  if (input.master_json !== undefined) {
    const m = input.master_json === null ? null : parseMasterResume(input.master_json)
    if (input.master_json !== null && !m) throw new LocalStoreError(400, 'master_json is not a master resume')
    out.master_json = m
  }
  if (input.target_json !== undefined) {
    const t = input.target_json === null ? null : parseTarget(input.target_json)
    if (input.target_json !== null && !t) throw new LocalStoreError(400, 'target_json needs a role')
    out.target_json = t && { ...t, notes: parseTailorNotes((input.target_json as { notes?: unknown }).notes) }
  }
  return out
}

function companyRow(input: CompanyInput, at: string): DbCompany {
  const name = required(input.name, 'company name').trim()
  if (input.hue != null && (input.hue < 0 || input.hue > 360)) throw new LocalStoreError(400, 'hue must be 0–360')
  if (input.logo_chars != null && input.logo_chars.length > 2) throw new LocalStoreError(400, 'logo_chars is at most 2 characters')
  return {
    id: uuid(), user_id: LOCAL_USER, name,
    hue: input.hue ?? null, logo_chars: input.logo_chars ?? null, sector: input.sector ?? null,
    loc: input.loc ?? null, portal_url: input.portal_url ?? null, created_at: at,
  }
}

/** Same rules as the server: legacy phone/onsite → interview (+ the round
 *  it stood for), interview rounds validated. */
function stageAndRounds(stage: unknown, interviews: unknown, create: boolean) {
  const n = stage === undefined ? undefined : normalizeStage(stage)
  if (n === null) throw new LocalStoreError(400, `stage must be one of: ${STAGE_VALUES.join(', ')}`)
  let rounds = interviews === undefined ? undefined : parseInterviews(interviews)
  if (rounds === null) throw new LocalStoreError(400, 'interviews must be an array of rounds')
  if (create && rounds === undefined && n?.round) rounds = [n.round]
  return { stage: n?.stage, interviews: rounds }
}

/** Same as the server: "" / null clears, anything else must read as a date. */
function deadlineOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const d = parseDeadline(v)
  if (!d) throw new LocalStoreError(400, 'deadline must be a date')
  return d
}

function applicationRow(companyId: string, input: ApplicationInput, at: string): DbApplication {
  required(input.role, 'role')
  const { stage, interviews } = stageAndRounds(input.stage, input.interviews, true)
  oneOf(input.remote, REMOTES, 'remote')
  return {
    id: uuid(), user_id: LOCAL_USER, company_id: companyId,
    role: input.role, team: input.team ?? null, stage: stage ?? 'saved', interviews: interviews ?? [],
    deadline: deadlineOf(input.deadline) ?? null,
    salary: input.salary ?? null, location: input.location ?? null, remote: input.remote ?? null,
    applied_at: input.applied_at ?? null, next_step: input.next_step ?? null,
    referral: input.referral ?? false, source: input.source ?? null, job_id: input.job_id ?? null,
    portal_application_url: input.portal_application_url ?? null, notes: input.notes ?? null,
    starred: input.starred ?? false, last_activity_at: input.last_activity_at ?? at, created_at: at,
  }
}

const byDesc = <T>(key: keyof T) => (a: T, b: T) => String(b[key]).localeCompare(String(a[key]))
const strip = <T extends { user_id: string }>({ user_id: _, ...rest }: T) => rest

export type LocalStore = DataStore & {
  /** Store observations pulled from the server's relay inbox; returns the ids
   *  now safely on this device (to ack). Re-deliveries are ignored. */
  receiveAgentObservations(rows: DbAgentObservation[]): Promise<string[]>
  /** True when this device holds no rows (profile flags don't count). */
  isEmpty(): Promise<boolean>
  /** Replace everything on this device with a snapshot (backup restore, leaving Cloud). */
  replaceWith(snapshot: Snapshot): Promise<void>
  clearAll(): Promise<void>
}

export function createLocalStore(dbName = 'landed'): LocalStore {
  const db = new LandedDB(dbName)

  // Live portal-event inserts: same-tab listeners directly, other tabs via
  // BroadcastChannel (the payload is the full row).
  const listeners = new Set<(row: DbPortalEvent) => void>()
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`${dbName}:portal-events`) : null
  channel?.addEventListener('message', (e) => listeners.forEach((l) => l(e.data as DbPortalEvent)))
  const emit = (row: DbPortalEvent) => {
    listeners.forEach((l) => l(row))
    channel?.postMessage(row)
  }

  // Ask the browser not to evict our data under storage pressure. Done on
  // first write rather than on load: Firefox shows a permission prompt.
  let persistAsked = false
  const askPersist = () => {
    if (persistAsked || typeof navigator === 'undefined' || !navigator.storage?.persist) return
    persistAsked = true
    navigator.storage.persist().catch(() => {})
  }

  const store: LocalStore = {
    kind: 'local',

    async listCompanies() {
      return db.companies.toArray()
    },
    async listApplications() {
      return (await db.applications.toArray()).sort(byDesc('last_activity_at'))
    },
    async addApplication(company, application) {
      askPersist()
      return db.transaction('rw', db.companies, db.applications, async () => {
        const at = now()
        const name = required(company.name, 'company name').trim()
        let co = await db.companies.where('name').equals(name).first()
        if (!co) {
          co = companyRow({ ...company, name }, at)
          await db.companies.add(co)
        }
        const row = applicationRow(co.id, application, at)
        await db.applications.add(row)
        return row
      })
    },
    async deleteApplication(id) {
      await db.transaction('rw', [db.applications, db.portal_events, db.job_leads, db.status_suggestions], async () => {
        if (!(await db.applications.get(id))) throw new LocalStoreError(404, 'application not found')
        await db.applications.delete(id)
        await db.portal_events.filter((e) => e.application_id === id).delete()
        await db.job_leads.filter((l) => l.application_id === id).modify({ application_id: null })
        await db.status_suggestions.filter((x) => x.application_id === id && x.state === 'pending').delete()
        await db.status_suggestions.filter((x) => x.application_id === id).modify({ application_id: null })
      })
    },
    async updateApplication(id, patch) {
      return db.transaction('rw', db.applications, async () => {
        const row = await db.applications.get(id)
        if (!row) throw new LocalStoreError(404, 'application not found')
        const clean: ApplicationPatch = {}
        for (const k of APPLICATION_PATCH_FIELDS) if (patch[k] !== undefined) (clean as Record<string, unknown>)[k] = patch[k]
        const { stage, interviews } = stageAndRounds(clean.stage, clean.interviews, false)
        if (stage) clean.stage = stage
        if (interviews) clean.interviews = interviews
        if (clean.deadline !== undefined) clean.deadline = deadlineOf(clean.deadline) ?? null
        oneOf(clean.remote, REMOTES, 'remote')
        if (clean.role !== undefined) required(clean.role, 'role')
        const next = { ...row, ...clean, last_activity_at: now() }
        await db.applications.put(next)
        return next
      })
    },
    async importDemo(data: DemoImport) {
      askPersist()
      return db.transaction('rw', db.companies, db.applications, async () => {
        const at = now()
        const nameToId = new Map<string, string>()
        for (const co of data.companies) {
          const row = companyRow(co, at)
          await db.companies.add(row)
          nameToId.set(row.name, row.id)
        }
        let applications = 0
        for (const { company_name, ...a } of data.applications) {
          const cid = nameToId.get(company_name.trim())
          if (!cid) continue
          await db.applications.add(applicationRow(cid, a, at))
          applications++
        }
        return { companies: nameToId.size, applications }
      })
    },

    async listResumes() {
      return (await db.resumes.toArray()).sort(byDesc('created_at'))
    },
    async addResume(input) {
      const { name, parsed_json, set_current } = input
      const kind = input.kind ?? 'source'
      oneOf(kind, ['source', 'master', 'version'], 'kind')
      const extras = resumeExtras(input)
      if (kind === 'master' && !extras.master_json) throw new LocalStoreError(400, 'a master resume needs master_json')
      askPersist()
      return db.transaction('rw', db.resumes, async () => {
        if (kind === 'master' && (await db.resumes.filter((r) => r.kind === 'master').count())) {
          throw new LocalStoreError(409, 'there is already a master resume')
        }
        if (set_current) await db.resumes.filter((r) => r.is_current).modify({ is_current: false })
        const row: DbResume = {
          id: uuid(), user_id: LOCAL_USER, name: required(name, 'name'), file_path: null,
          parsed_json: parsed_json ?? null, is_current: !!set_current, created_at: now(),
          kind, master_json: null, target_json: null, ...extras,
        }
        await db.resumes.add(row)
        return row
      })
    },
    async updateResume(id, patch) {
      return db.transaction('rw', db.resumes, async () => {
        const row = await db.resumes.get(id)
        if (!row) throw new LocalStoreError(404, 'resume not found')
        const next = { ...row }
        if (patch.name !== undefined) next.name = required(patch.name, 'name')
        if (patch.parsed_json !== undefined) next.parsed_json = patch.parsed_json
        Object.assign(next, resumeExtras(patch))
        await db.resumes.put(next)
        return next
      })
    },
    async deleteResume(id) {
      if (!(await db.resumes.get(id))) throw new LocalStoreError(404, 'resume not found')
      await db.resumes.delete(id)
    },
    async setCurrentResume(id) {
      return db.transaction('rw', db.resumes, async () => {
        const row = await db.resumes.get(id)
        if (!row) throw new LocalStoreError(404, 'resume not found')
        await db.resumes.filter((r) => r.is_current && r.id !== id).modify({ is_current: false })
        const next = { ...row, is_current: true }
        await db.resumes.put(next)
        return next
      })
    },

    async listPortalConnections() {
      return (await db.portal_connections.toArray()).sort(byDesc('created_at'))
    },
    async upsertPortalConnection(input: ConnectionInput) {
      oneOf(input.provider, PROVIDERS, 'provider')
      oneOf(input.status, STATUSES, 'status')
      return db.transaction('rw', db.companies, db.portal_connections, async () => {
        if (!(await db.companies.get(input.company_id))) throw new LocalStoreError(400, 'unknown company_id')
        const existing = await db.portal_connections
          .where('[company_id+provider]').equals([input.company_id, input.provider]).first()
        const fields = {
          portal_host: input.portal_host ?? null,
          status: input.status ?? 'active',
          last_sync_at: input.last_sync_at ?? null,
          failure_reason: input.failure_reason ?? null,
        }
        const row: DbPortalConnection = existing
          ? { ...existing, ...fields }
          : {
              id: uuid(), user_id: LOCAL_USER, company_id: input.company_id, provider: input.provider,
              last_seen_login_at: null, created_at: now(), ...fields,
            }
        await db.portal_connections.put(row)
        return row
      })
    },
    async listPortalEvents(limit) {
      return db.portal_events.orderBy('created_at').reverse().limit(limit).toArray()
    },
    async addPortalEvents(inputs: PortalEventInput[]) {
      const rows = await db.transaction('rw', db.portal_events, db.portal_connections, db.applications, async () => {
        const out: DbPortalEvent[] = []
        for (const r of inputs) {
          oneOf(r.type, EVENT_TYPES, 'type')
          const payload = r.payload_json ?? {}
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            throw new LocalStoreError(400, 'payload_json must be a JSON object')
          }
          if (r.connection_id && !(await db.portal_connections.get(r.connection_id))) throw new LocalStoreError(400, 'unknown connection_id')
          if (r.application_id && !(await db.applications.get(r.application_id))) throw new LocalStoreError(400, 'unknown application_id')
          out.push({
            id: uuid(), user_id: LOCAL_USER, connection_id: r.connection_id ?? null,
            application_id: r.application_id ?? null, type: r.type, payload_json: payload, created_at: now(),
          })
        }
        await db.portal_events.bulkAdd(out)
        return out
      })
      rows.forEach(emit)
      return rows
    },
    subscribePortalEvents(onInsert) {
      listeners.add(onInsert)
      return () => listeners.delete(onInsert)
    },

    async addAiRun(input: AiRunInput) {
      oneOf(input.task, AI_TASKS, 'task')
      oneOf(input.provider, AI_PROVIDERS, 'provider')
      oneOf(input.parse_format, PARSE_FORMATS, 'parse_format')
      const row: DbAiRun = {
        id: uuid(), user_id: LOCAL_USER, task: input.task, provider: input.provider,
        prompt_text: required(input.prompt_text, 'prompt_text'), response_text: input.response_text ?? null,
        parsed_json: input.parsed_json ?? null, parse_format: input.parse_format ?? null, created_at: now(),
      }
      await db.ai_runs.add(row)
      return { id: row.id }
    },

    async listAgentObservations(limit) {
      return db.agent_observations.orderBy('created_at').reverse().limit(limit).toArray()
    },
    async listPendingObservations(limit) {
      return (await db.agent_observations.where('processing_status').equals('pending').sortBy('created_at')).slice(0, limit)
    },
    async markObservation(id, processing_status, processing_result) {
      const n = await db.agent_observations.update(id, { processing_status, processing_result })
      if (!n) throw new LocalStoreError(404, 'observation not found')
    },

    async listJobLeads() {
      return (await db.job_leads.toArray()).sort(byDesc('last_seen_at'))
    },
    async saveJobLead(lead) {
      const queue = leadQueueOf(lead)
      const row = { ...lead, ...leadQueueDefaults({}), ...queue, user_id: LOCAL_USER }
      return db.transaction('rw', db.job_leads, async () => {
        const clash = await db.job_leads.where('fingerprint').equals(row.fingerprint).first()
        if (clash && clash.id !== row.id) throw new LocalStoreError(409, 'a lead with this fingerprint already exists')
        await db.job_leads.put(row)
        return row
      })
    },
    async updateJobLead(id, patch) {
      return db.transaction('rw', db.job_leads, async () => {
        const row = await db.job_leads.get(id)
        if (!row) throw new LocalStoreError(404, 'lead not found')
        const next = {
          ...row, ...patch,
          ...(patch.deadline !== undefined ? { deadline: deadlineOf(patch.deadline) ?? null } : {}),
          ...leadQueueOf(patch),
        }
        await db.job_leads.put(next)
        return next
      })
    },

    async listSuggestions() {
      return (await db.status_suggestions.toArray()).sort(byDesc('created_at'))
    },
    async saveSuggestion(s) {
      const row = { ...s, user_id: LOCAL_USER }
      return db.transaction('rw', db.status_suggestions, async () => {
        const clash = await db.status_suggestions.where('dedupe_key').equals(row.dedupe_key).first()
        if (clash && clash.id !== row.id) throw new LocalStoreError(409, 'a suggestion for this email already exists')
        await db.status_suggestions.put(row)
        return row
      })
    },
    async updateSuggestion(id, patch) {
      return db.transaction('rw', db.status_suggestions, async () => {
        const row = await db.status_suggestions.get(id)
        if (!row) throw new LocalStoreError(404, 'suggestion not found')
        const next = { ...row, ...patch }
        await db.status_suggestions.put(next)
        return next
      })
    },

    async listJobSearches() {
      return (await db.job_searches.toArray()).sort(byDesc('created_at'))
    },
    async addJobSearch(input) {
      askPersist()
      const brief = parseBrief(input)
      if (!brief) throw new LocalStoreError(400, 'brief needs at least one role')
      return db.transaction('rw', db.job_searches, async () => {
        const at = now()
        const active = await db.job_searches.where('status').equals('active').toArray()
        for (const s of active) await db.job_searches.put({ ...s, status: 'archived', updated_at: at })
        const row: DbJobSearch = {
          id: uuid(), user_id: LOCAL_USER, brief, status: 'active',
          last_run_at: null, last_run_result: null, created_at: now(), updated_at: at,
        }
        await db.job_searches.add(row)
        return row
      })
    },
    async updateJobSearch(id, patch) {
      oneOf(patch.status, ['active', 'archived'], 'status')
      return db.transaction('rw', db.job_searches, async () => {
        const row = await db.job_searches.get(id)
        if (!row) throw new LocalStoreError(404, 'search not found')
        const next: DbJobSearch = { ...row, ...patch, updated_at: now() }
        await db.job_searches.put(next)
        return next
      })
    },

    async listConversations() {
      return (await db.agent_conversations.toArray()).sort(byDesc('updated_at'))
    },
    async saveConversation(input) {
      const conv = parseConversation(input)
      if (!conv) throw new LocalStoreError(400, 'not a conversation')
      askPersist()
      return db.transaction('rw', db.agent_conversations, async () => {
        const existing = await db.agent_conversations.get(conv.id)
        const at = now()
        const row: DbConversation = {
          id: conv.id, user_id: LOCAL_USER, title: conv.title, turns: conv.turns,
          created_at: existing?.created_at ?? conv.created_at ?? at, updated_at: at,
        }
        await db.agent_conversations.put(row)
        return row
      })
    },
    async deleteConversation(id) {
      if (!(await db.agent_conversations.get(id))) throw new LocalStoreError(404, 'conversation not found')
      await db.agent_conversations.delete(id)
    },

    async getApplicationAnswers() {
      return (await db.application_answers.toArray())[0] ?? null
    },
    async listApplicationFiles() {
      return (await db.application_files.toArray()).map(({ data: _, ...meta }) => meta).sort((a, b) => a.kind.localeCompare(b.kind))
    },
    async getApplicationFileData(kind) {
      const row = await db.application_files.where('kind').equals(kind).first()
      return row ? { id: row.id, data: row.data } : null
    },
    async saveApplicationFile(input) {
      const parsed = parseApplicationFile({ ...input, id: uuid(), created_at: undefined })
      if (!parsed.ok) throw new LocalStoreError(400, parsed.error)
      askPersist()
      const row = { ...parsed.file, user_id: LOCAL_USER }
      await db.transaction('rw', db.application_files, async () => {
        await db.application_files.where('kind').equals(row.kind).delete()
        await db.application_files.add(row)
      })
      const { data: _, ...meta } = row
      return meta
    },
    async deleteApplicationFile(kind) {
      await db.application_files.where('kind').equals(kind).delete()
    },
    async saveApplicationAnswers(input) {
      const answers = parseApplicationAnswers(input)
      askPersist()
      return db.transaction('rw', db.application_answers, async () => {
        const existing = (await db.application_answers.toArray())[0]
        const at = now()
        const row: DbApplicationAnswers = {
          id: existing?.id ?? uuid(), user_id: LOCAL_USER, answers, created_at: existing?.created_at ?? at, updated_at: at,
        }
        await db.application_answers.put(row)
        return row
      })
    },

    async receiveAgentObservations(rows) {
      return db.transaction('rw', db.agent_observations, async () => {
        const stored: string[] = []
        for (const r of rows) {
          const dup = await db.agent_observations
            .where('[connection_id+idempotency_key]').equals([r.connection_id, r.idempotency_key]).first()
          // provider/display_name are kept: leads and the review queue show
          // which agent reported what.
          if (!dup) await db.agent_observations.add({ ...r, user_id: LOCAL_USER })
          stored.push(r.id)
        }
        return stored
      })
    },

    async exportSnapshot(): Promise<Snapshot> {
      return db.transaction('r', SNAPSHOT_TABLES.map((t) => db[t]), async () => ({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: now(),
        profile: { onboarded_at: null }, // account-level, lives on the server
        companies: (await db.companies.toArray()).map(strip),
        applications: (await db.applications.toArray()).map(strip),
        resumes: (await db.resumes.toArray()).map(strip),
        portal_connections: (await db.portal_connections.toArray()).map(strip),
        portal_events: (await db.portal_events.toArray()).map(strip),
        ai_runs: (await db.ai_runs.toArray()).map(strip),
        agent_observations: (await db.agent_observations.toArray()).map(strip),
        job_leads: (await db.job_leads.toArray()).map(strip),
        status_suggestions: (await db.status_suggestions.toArray()).map(strip),
        job_searches: (await db.job_searches.toArray()).map(strip),
        agent_conversations: (await db.agent_conversations.toArray()).map(strip),
        application_answers: (await db.application_answers.toArray()).map(strip),
        application_files: (await db.application_files.toArray()).map(strip),
      }))
    },

    async isEmpty() {
      const counts = await Promise.all(SNAPSHOT_TABLES.map((t) => db[t].count()))
      return counts.every((n) => n === 0)
    },
    async replaceWith(snapshot) {
      askPersist()
      await db.transaction('rw', SNAPSHOT_TABLES.map((t) => db[t]), async () => {
        for (const t of SNAPSHOT_TABLES) await db[t].clear()
        const own = <T,>(rows: T[] | undefined) => (rows ?? []).map((r) => ({ ...r, user_id: LOCAL_USER }))
        await db.companies.bulkAdd(own(snapshot.companies) as DbCompany[])
        // Older backups: phone/onsite → interview (+ round), rounds validated.
        await db.applications.bulkAdd((own(snapshot.applications) as DbApplication[]).map((a) => {
          const n = normalizeStage(a.stage)
          return { ...a, stage: n?.stage ?? 'saved', interviews: parseInterviews(a.interviews) ?? (n?.round ? [n.round] : []) }
        }))
        await db.resumes.bulkAdd((own(snapshot.resumes) as DbResume[]).map((r) => ({
          ...r, kind: r.kind ?? 'source', master_json: r.master_json ?? null, target_json: r.target_json ?? null,
        })))
        await db.portal_connections.bulkAdd(own(snapshot.portal_connections) as DbPortalConnection[])
        await db.portal_events.bulkAdd(own(snapshot.portal_events) as DbPortalEvent[])
        await db.ai_runs.bulkAdd(own(snapshot.ai_runs) as DbAiRun[])
        await db.agent_observations.bulkAdd(own(snapshot.agent_observations) as DbAgentObservation[])
        // Backups from before the queue fields: present, and null when unreadable.
        await db.job_leads.bulkAdd((own(snapshot.job_leads) as DbJobLead[]).map((l) => ({ ...l, ...leadQueueDefaults(l) })))
        await db.status_suggestions.bulkAdd(own(snapshot.status_suggestions) as DbSuggestion[])
        await db.job_searches.bulkAdd(own(snapshot.job_searches) as DbJobSearch[])
        await db.agent_conversations.bulkAdd(own(snapshot.agent_conversations) as DbConversation[])
        // One per account: the first row of a backup, validated.
        await db.application_answers.bulkAdd((own(snapshot.application_answers) as DbApplicationAnswers[]).slice(0, 1)
          .map((r) => ({ ...r, answers: parseApplicationAnswers(r.answers) })))
        // Files: validated, one per kind.
        const files = (snapshot.application_files ?? []).map((r) => parseApplicationFile(r)).flatMap((p) => (p.ok ? [p.file] : []))
        await db.application_files.bulkAdd(files.filter((f, i) => files.findIndex((x) => x.kind === f.kind) === i).map((f) => ({ ...f, user_id: LOCAL_USER })))
      })
    },
    async clearAll() {
      await db.transaction('rw', SNAPSHOT_TABLES.map((t) => db[t]), async () => {
        for (const t of SNAPSHOT_TABLES) await db[t].clear()
      })
    },
  }
  return store
}
