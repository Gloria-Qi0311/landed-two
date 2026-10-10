// Local store — every row lives in this browser's IndexedDB (via Dexie), one
// database per account. This is the default: nothing leaves the device
// until the account turns on Landed Cloud sync.
//
// It mirrors the server's semantics (apps/server/src/routes/*) closely —
// same defaults, same enum checks, same "reference must exist" rules — so a
// device's data always uploads cleanly when the user turns Cloud on.
import Dexie, { type Table } from 'dexie'
import {
  APPLICATION_PATCH_FIELDS, BACKUP_FORMAT, BACKUP_VERSION, SNAPSHOT_TABLES,
  type AiRunInput, type ApplicationInput, type ApplicationPatch, type CompanyInput, type ConnectionInput,
  type DataStore, type DbAiRun, type DbApplication, type DbCompany, type DbPortalConnection,
  type DbPortalEvent, type DbResume, type DemoImport, type PortalEventInput, type Snapshot,
} from './types'

const LOCAL_USER = 'local'

const STAGES = ['saved', 'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted']
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
  }
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

function applicationRow(companyId: string, input: ApplicationInput, at: string): DbApplication {
  required(input.role, 'role')
  oneOf(input.stage, STAGES, 'stage')
  oneOf(input.remote, REMOTES, 'remote')
  return {
    id: uuid(), user_id: LOCAL_USER, company_id: companyId,
    role: input.role, team: input.team ?? null, stage: input.stage ?? 'saved',
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
    async updateApplication(id, patch) {
      return db.transaction('rw', db.applications, async () => {
        const row = await db.applications.get(id)
        if (!row) throw new LocalStoreError(404, 'application not found')
        const clean: ApplicationPatch = {}
        for (const k of APPLICATION_PATCH_FIELDS) if (patch[k] !== undefined) (clean as Record<string, unknown>)[k] = patch[k]
        oneOf(clean.stage, STAGES, 'stage')
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
    async addResume({ name, parsed_json, set_current }) {
      askPersist()
      return db.transaction('rw', db.resumes, async () => {
        if (set_current) await db.resumes.filter((r) => r.is_current).modify({ is_current: false })
        const row: DbResume = {
          id: uuid(), user_id: LOCAL_USER, name: required(name, 'name'), file_path: null,
          parsed_json: parsed_json ?? null, is_current: !!set_current, created_at: now(),
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
        await db.applications.bulkAdd(own(snapshot.applications) as DbApplication[])
        await db.resumes.bulkAdd(own(snapshot.resumes) as DbResume[])
        await db.portal_connections.bulkAdd(own(snapshot.portal_connections) as DbPortalConnection[])
        await db.portal_events.bulkAdd(own(snapshot.portal_events) as DbPortalEvent[])
        await db.ai_runs.bulkAdd(own(snapshot.ai_runs) as DbAiRun[])
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
