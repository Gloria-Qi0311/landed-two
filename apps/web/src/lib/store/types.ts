// The data contract both storage backends implement.
//
// Landed is local-first: by default every row lives in this browser
// (IndexedDB, see ./local.ts). When the user turns on Landed Cloud the same
// operations go to the API server instead (./cloud.ts). Rows have the same
// snake_case shape in both places — the server's JSON shape — so hooks and
// components never care which backend they're talking to.
import type { Resume } from '@landed/schema'

export type DbCompany = {
  id: string
  user_id: string
  name: string
  hue: number | null
  logo_chars: string | null
  sector: string | null
  loc: string | null
  portal_url: string | null
  created_at: string
}

export type DbApplication = {
  id: string
  user_id: string
  company_id: string
  role: string
  team: string | null
  stage: string
  salary: string | null
  location: string | null
  remote: string | null
  applied_at: string | null
  next_step: string | null
  referral: boolean
  source: string | null
  job_id: string | null
  portal_application_url: string | null
  notes: string | null
  starred: boolean
  last_activity_at: string
  created_at: string
}

export type DbResume = {
  id: string
  user_id: string
  name: string
  file_path: string | null
  parsed_json: Resume | null
  is_current: boolean
  created_at: string
}

export type PortalProvider =
  | 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'bamboohr'
  | 'boss' | 'smartrecruiters' | 'other'

export type PortalStatus = 'active' | 'syncing' | 'expired' | 'disconnected'

export type PortalEventType = 'status-change' | 'new-event' | 'expired' | 'sync' | 'rejection'

export type DbPortalConnection = {
  id: string
  user_id: string
  company_id: string
  provider: PortalProvider
  portal_host: string | null
  status: PortalStatus
  last_sync_at: string | null
  last_seen_login_at: string | null
  failure_reason: string | null
  created_at: string
}

export type DbPortalEvent = {
  id: string
  user_id: string
  connection_id: string | null
  application_id: string | null
  type: PortalEventType
  payload_json: Record<string, unknown>
  created_at: string
}

export type DbAiRun = {
  id: string
  user_id: string
  task: string
  provider: string
  prompt_text: string
  response_text: string | null
  parsed_json: unknown
  parse_format: string | null
  created_at: string
}

export type Profile = { onboarded_at: string | null }

// ── inputs ────────────────────────────────────────────────────────────────

export type CompanyInput = Partial<Pick<DbCompany, 'hue' | 'logo_chars' | 'sector' | 'loc' | 'portal_url'>> & { name: string }

export type ApplicationInput = Partial<Omit<DbApplication, 'id' | 'user_id' | 'company_id' | 'created_at'>> & { role: string }

export const APPLICATION_PATCH_FIELDS = [
  'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at', 'next_step',
  'referral', 'source', 'notes', 'starred',
] as const
export type ApplicationPatch = Partial<Pick<DbApplication, typeof APPLICATION_PATCH_FIELDS[number]>>

export type ConnectionInput = {
  company_id: string
  provider: PortalProvider
  portal_host?: string | null
  status?: PortalStatus
  last_sync_at?: string | null
  failure_reason?: string | null
}

export type PortalEventInput = {
  type: PortalEventType
  connection_id?: string | null
  application_id?: string | null
  payload_json?: Record<string, unknown>
}

export type AiRunInput = Pick<DbAiRun, 'task' | 'provider' | 'prompt_text' | 'response_text' | 'parsed_json' | 'parse_format'>

export type DemoImport = {
  companies: CompanyInput[]
  applications: (ApplicationInput & { company_name: string })[]
}

// ── snapshot (backup file + device ⇄ cloud transfer) ─────────────────────
// Same format as the server's GET /api/export and POST /api/sync/upload.

export const BACKUP_FORMAT = 'landed-backup'
export const BACKUP_VERSION = 1

type Owned<T> = Omit<T, 'user_id'>

export type Snapshot = {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exported_at: string
  profile: Profile
  companies: Owned<DbCompany>[]
  applications: Owned<DbApplication>[]
  resumes: Owned<DbResume>[]
  portal_connections: Owned<DbPortalConnection>[]
  portal_events: Owned<DbPortalEvent>[]
  ai_runs: Owned<DbAiRun>[]
}

export const SNAPSHOT_TABLES = [
  'companies', 'applications', 'resumes', 'portal_connections', 'portal_events', 'ai_runs',
] as const

export function snapshotRowCount(s: Snapshot): number {
  return SNAPSHOT_TABLES.reduce((n, t) => n + (s[t]?.length ?? 0), 0)
}

// ── the store ─────────────────────────────────────────────────────────────

export interface DataStore {
  readonly kind: 'local' | 'cloud'

  getProfile(): Promise<Profile>
  updateProfile(patch: Profile): Promise<Profile>

  listCompanies(): Promise<DbCompany[]>
  listApplications(): Promise<DbApplication[]> // last_activity_at desc
  /** Finds-or-creates the company by exact name, then inserts the application. */
  addApplication(company: CompanyInput, application: ApplicationInput): Promise<DbApplication>
  /** Whitelisted fields only; bumps last_activity_at. */
  updateApplication(id: string, patch: ApplicationPatch): Promise<DbApplication>
  importDemo(data: DemoImport): Promise<{ companies: number; applications: number }>

  listResumes(): Promise<DbResume[]> // created_at desc
  addResume(input: { name: string; parsed_json: Resume | null; set_current: boolean }): Promise<DbResume>
  updateResume(id: string, patch: Partial<Pick<DbResume, 'name' | 'parsed_json'>>): Promise<DbResume>
  deleteResume(id: string): Promise<void>
  /** Promotes one resume and demotes the previous current one atomically. */
  setCurrentResume(id: string): Promise<DbResume>

  listPortalConnections(): Promise<DbPortalConnection[]> // created_at desc
  /** Upsert on (company_id, provider). */
  upsertPortalConnection(input: ConnectionInput): Promise<DbPortalConnection>
  listPortalEvents(limit: number): Promise<DbPortalEvent[]> // created_at desc
  addPortalEvents(rows: PortalEventInput[]): Promise<DbPortalEvent[]>
  /** Live inserts (from this tab, other tabs, or the extension). */
  subscribePortalEvents(onInsert: (row: DbPortalEvent) => void): () => void

  addAiRun(row: AiRunInput): Promise<{ id: string }>

  exportSnapshot(): Promise<Snapshot>
}
