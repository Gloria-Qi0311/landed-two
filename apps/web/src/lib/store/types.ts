// The data contract both storage backends implement.
//
// Landed is local-first: by default every row lives in this browser
// (IndexedDB, see ./local.ts). When the user turns on Landed Cloud the same
// operations go to the API server instead (./cloud.ts). Rows have the same
// snake_case shape in both places — the server's JSON shape — so hooks and
// components never care which backend they're talking to.
import type { Resume } from '@landed/schema'
import type { Conversation } from '@landed/schema/conversation'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
import type { ApplicationFile, FileKind } from '@landed/schema/application-files'
import type { MasterResume, ResumeTarget, TailorNotes } from '@landed/schema/master-resume'
import type { InterviewRound } from '@landed/schema/pipeline'
import type { LEAD_QUEUE_FIELDS } from '@landed/schema/lead-queue'
import type { SearchBrief } from '@landed/schema/search-brief'
import type { JobLead, Suggestion } from '@landed/observation-processor'

type LeadQueueField = typeof LEAD_QUEUE_FIELDS[number]

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
  /** Interview rounds (stage `interview`): round, onsite/remote, who, when. */
  interviews: InterviewRound[]
  /** apply-by date "YYYY-MM-DD" (mostly for ones not applied to yet) */
  deadline: string | null
}

/** My Resume: uploads (`source`) → one `master` (most complete, every
 *  phrasing kept; parsed_json is its flattened form) → `version`s aimed at
 *  a role. packages/schema/src/master-resume.ts. */
export type ResumeKind = 'source' | 'master' | 'version'

export type DbResume = {
  id: string
  user_id: string
  name: string
  /** a source uploaded without a computer: the name of the file it still has
   *  to be read from in full (parseWaitingFile); null otherwise */
  file_path: string | null
  parsed_json: Resume | null
  is_current: boolean
  created_at: string
  kind: ResumeKind
  master_json: MasterResume | null
  /** what a version is aimed at, and why it picked what it did */
  target_json: (ResumeTarget & { notes: TailorNotes }) | null
}

export type ResumeInput = {
  name: string
  parsed_json: Resume | null
  set_current: boolean
  kind?: ResumeKind
  master_json?: MasterResume | null
  target_json?: (ResumeTarget & { notes?: TailorNotes }) | null
  /** uploaded without a computer: the file still to be read in full (parseWaitingFile) */
  file_path?: string | null
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

/** Raw report from an external agent (Muse, Claude, Codex…). Stored as
 *  received; a processor decides later what it means for the pipeline.
 *  payload_json is the agent's whole request body (envelope + payload). */
export type DbAgentObservation = {
  id: string
  user_id: string
  connection_id: string
  idempotency_key: string
  schema_version: string
  run_id: string
  observation_type: 'job_discovered' | 'application_status' | 'sync_error' | string
  payload_json: { payload?: Record<string, unknown> } & Record<string, unknown>
  payload_sha256: string
  observed_at: string
  processing_status: 'pending' | 'processed' | 'needs-review' | 'rejected'
  processing_result?: Record<string, unknown> | null
  created_at: string
  // joined from agent_connections when read from the server
  provider?: string
  display_name?: string
}

/** Processor output (packages/observation-processor): the "to apply" list
 *  and the review queue. */
export type DbJobLead = JobLead & { user_id: string }
export type DbSuggestion = Suggestion & { user_id: string }

/** How a search run went (stored on the search for "last run …"). */
export type SearchRunResult = {
  found: number
  added: number
  merged: number
  already_applied: number
  /** "Claude Code on MacBook Pro", one per agent that ran */
  agents: string[]
  failed?: string[]
}

/** The job search direction the user confirmed in the Agent chat. One
 *  is active at a time; confirming a new brief archives the previous one. */
export type DbJobSearch = {
  id: string
  user_id: string
  brief: SearchBrief
  status: 'active' | 'archived'
  last_run_at: string | null
  last_run_result: SearchRunResult | null
  created_at: string
  updated_at: string
}

/** A conversation on the Agent page (id = its Claude Code session id). */
export type DbConversation = Conversation & { user_id: string }

/** A file the extension uploads into forms (metadata; the bytes come from
 *  getApplicationFileData). One per kind per account. */
export type DbApplicationFile = ApplicationFile & { user_id: string }

/** The account's answers to the questions forms ask that a resume doesn't
 *  (one row per account). */
export type DbApplicationAnswers = {
  id: string
  user_id: string
  answers: ApplicationAnswers
  created_at: string
  updated_at: string
}

/** Account-level (users row on the server, not part of either store);
 *  carried in snapshots only for backup-file compatibility. */
export type Profile = { onboarded_at: string | null }

// ── inputs ────────────────────────────────────────────────────────────────

export type CompanyInput = Partial<Pick<DbCompany, 'hue' | 'logo_chars' | 'sector' | 'loc' | 'portal_url'>> & { name: string }

export type ApplicationInput = Partial<Omit<DbApplication, 'id' | 'user_id' | 'company_id' | 'created_at'>> & { role: string }

export const APPLICATION_PATCH_FIELDS = [
  'role', 'team', 'stage', 'salary', 'location', 'remote', 'applied_at', 'next_step',
  'referral', 'source', 'notes', 'starred', 'interviews', 'portal_application_url', 'deadline',
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
  agent_observations?: Owned<DbAgentObservation>[] // absent in pre-agent backups
  job_leads?: Owned<DbJobLead>[]
  status_suggestions?: Owned<DbSuggestion>[]
  job_searches?: Owned<DbJobSearch>[]
  agent_conversations?: Owned<DbConversation>[]
  application_answers?: Owned<DbApplicationAnswers>[]
  /** with `data` (base64) */
  application_files?: (Owned<DbApplicationFile> & { data: string })[]
}

export const SNAPSHOT_TABLES = [
  'companies', 'applications', 'resumes', 'portal_connections', 'portal_events', 'ai_runs', 'agent_observations',
  'job_leads', 'status_suggestions', 'job_searches', 'agent_conversations', 'application_answers', 'application_files',
] as const

export function snapshotRowCount(s: Snapshot): number {
  return SNAPSHOT_TABLES.reduce((n, t) => n + (s[t]?.length ?? 0), 0)
}

// ── the store ─────────────────────────────────────────────────────────────

export interface DataStore {
  readonly kind: 'local' | 'cloud'

  listCompanies(): Promise<DbCompany[]>
  listApplications(): Promise<DbApplication[]> // last_activity_at desc
  /** Finds-or-creates the company by exact name, then inserts the application. */
  addApplication(company: CompanyInput, application: ApplicationInput): Promise<DbApplication>
  /** Whitelisted fields only; bumps last_activity_at. */
  updateApplication(id: string, patch: ApplicationPatch): Promise<DbApplication>
  /** Delete an application. Its portal events go with it and pending
   *  questions about it are dropped; job leads and resolved suggestions keep
   *  their rows but lose the link (the server's foreign keys do the same). */
  deleteApplication(id: string): Promise<void>
  importDemo(data: DemoImport): Promise<{ companies: number; applications: number }>

  listResumes(): Promise<DbResume[]> // created_at desc
  /** At most one `master` per account (a second is a 409). */
  addResume(input: ResumeInput): Promise<DbResume>
  updateResume(id: string, patch: Partial<Pick<DbResume, 'name' | 'parsed_json' | 'master_json' | 'target_json' | 'file_path'>>): Promise<DbResume>
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

  /** Newest first. Local: pulled from the server's relay inbox. Cloud: kept server-side. */
  listAgentObservations(limit: number): Promise<DbAgentObservation[]>
  /** Oldest first — the processor's queue. */
  listPendingObservations(limit: number): Promise<DbAgentObservation[]>
  markObservation(id: string, status: DbAgentObservation['processing_status'], result: Record<string, unknown>): Promise<void>

  listJobLeads(): Promise<DbJobLead[]> // last_seen_at desc
  /** Insert or replace by id; a second lead with the same fingerprint is a 409. */
  saveJobLead(lead: Owned<DbJobLead>): Promise<DbJobLead>
  /** The queue fields (posted_at, closed_at, screen, fit) are validated by
   *  @landed/schema/lead-queue; null clears. */
  updateJobLead(id: string, patch: Partial<Pick<DbJobLead, 'status' | 'application_id' | 'deadline' | LeadQueueField>>): Promise<DbJobLead>

  listSuggestions(): Promise<DbSuggestion[]> // created_at desc
  /** Insert or replace by id; a second suggestion with the same dedupe_key is a 409. */
  saveSuggestion(s: Owned<DbSuggestion>): Promise<DbSuggestion>
  updateSuggestion(
    id: string,
    patch: Partial<Pick<DbSuggestion, 'state' | 'application_id' | 'proposed_stage' | 'previous_stage' | 'resolved_at'>>,
  ): Promise<DbSuggestion>

  listJobSearches(): Promise<DbJobSearch[]> // created_at desc
  /** Confirm a brief: it becomes the active search, the previous one is archived. */
  addJobSearch(brief: SearchBrief): Promise<DbJobSearch>
  updateJobSearch(
    id: string,
    patch: Partial<Pick<DbJobSearch, 'status' | 'last_run_at' | 'last_run_result'>>,
  ): Promise<DbJobSearch>

  listConversations(): Promise<DbConversation[]> // updated_at desc
  /** Insert or replace the whole conversation (title + turns); bumps updated_at. */
  saveConversation(c: Pick<Conversation, 'id' | 'title' | 'turns'> & Partial<Pick<Conversation, 'created_at'>>): Promise<DbConversation>
  deleteConversation(id: string): Promise<void>

  /** null until the user saves them once. */
  getApplicationAnswers(): Promise<DbApplicationAnswers | null>
  /** Validated (parseApplicationAnswers); the row keeps its first id. */
  saveApplicationAnswers(answers: ApplicationAnswers): Promise<DbApplicationAnswers>

  listApplicationFiles(): Promise<DbApplicationFile[]> // metadata only
  getApplicationFileData(kind: FileKind): Promise<{ id: string; data: string } | null>
  /** Replaces this kind's file; validated (parseApplicationFile). */
  saveApplicationFile(input: { kind: FileKind; name: string; data: string }): Promise<DbApplicationFile>
  deleteApplicationFile(kind: FileKind): Promise<void>

  exportSnapshot(): Promise<Snapshot>
}
