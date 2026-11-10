// The data contract both storage backends implement.
//
// Landed is local-first: by default every row lives in this browser
// (IndexedDB, see ./local.ts). When the user turns on Landed Cloud the same
// operations go to the API server instead (./cloud.ts). Rows have the same
// snake_case shape in both places — the server's JSON shape — so hooks and
// components never care which backend they're talking to.
import type { Resume } from '@landed/schema'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
import type { ApplicationFile, FileKind, ResumeFile } from '@landed/schema/application-files'
import type { ResumeChoice } from '@landed/schema/master-resume'
import type { OpenAnswer } from '@landed/schema/open-answers'
import type { MasterResume, ResumeTarget, TailorNotes } from '@landed/schema/master-resume'
import type { InterviewRound } from '@landed/schema/pipeline'
import type { LEAD_QUEUE_FIELDS } from '@landed/schema/lead-queue'
import type { SourceRuns } from '@landed/schema/automation'
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
  /** the resume Landed filled it from, and why (when it opened it) */
  resume_choice: ResumeChoice | null
  /** the open-ended answers it was sent with ("Why us?"): written by the
   *  user's agent, editable in the drawer */
  open_answers: OpenAnswer[] | null
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
  /** what an upload is for, as role names ("Product Manager"): the user's or
   *  Landed's guess at upload (parseDirections); Landed picks by these */
  directions: string[]
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
  directions?: string[]
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

/** The job search direction the user set in Workflow → Find new jobs. One
 *  is active at a time; confirming a new brief archives the previous one. */
export type DbJobSearch = {
  id: string
  user_id: string
  brief: SearchBrief
  status: 'active' | 'archived'
  last_run_at: string | null
  last_run_result: SearchRunResult | null
  /** each public source's last check of this search (its own schedule) */
  source_runs: SourceRuns | null
  created_at: string
  updated_at: string
}

/** A file the extension uploads into forms (metadata; the bytes come from
 *  getApplicationFileData). One per kind per account. */
export type DbApplicationFile = ApplicationFile & { user_id: string }

/** An uploaded resume's own file (metadata; bytes from getResumeFileData):
 *  a fill with that resume uploads it. One per resume. */
export type DbResumeFile = ResumeFile & { user_id: string }

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
  'referral', 'source', 'notes', 'starred', 'interviews', 'portal_application_url', 'deadline', 'resume_choice', 'open_answers',
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

/** A batch of applications (a spreadsheet, or demo data). Each
 *  `company_name` is found or created by exact name, like addApplication;
 *  `companies` only carries extra details for the ones it creates. */
export type ApplicationsImport = {
  companies?: CompanyInput[]
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
  job_leads?: Owned<DbJobLead>[]
  status_suggestions?: Owned<DbSuggestion>[]
  job_searches?: Owned<DbJobSearch>[]
  application_answers?: Owned<DbApplicationAnswers>[]
  /** with `data` (base64) */
  application_files?: (Owned<DbApplicationFile> & { data: string })[]
  /** with `data` (base64); absent in older backups */
  resume_files?: (Owned<DbResumeFile> & { data: string })[]
}

export const SNAPSHOT_TABLES = [
  'companies', 'applications', 'resumes', 'portal_connections', 'portal_events', 'ai_runs',
  'job_leads', 'status_suggestions', 'job_searches', 'application_answers', 'application_files',
  'resume_files',
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
  /** All or nothing; at most 2000 applications. `companies` counts the ones it created. */
  importApplications(data: ApplicationsImport): Promise<{ companies: number; applications: DbApplication[] }>

  listResumes(): Promise<DbResume[]> // created_at desc
  /** At most one `master` per account (a second is a 409). */
  addResume(input: ResumeInput): Promise<DbResume>
  updateResume(id: string, patch: Partial<Pick<DbResume, 'name' | 'parsed_json' | 'master_json' | 'target_json' | 'file_path' | 'directions'>>): Promise<DbResume>
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
  /** `source_runs` replaces only the sources it carries. */
  updateJobSearch(
    id: string,
    patch: Partial<Pick<DbJobSearch, 'status' | 'last_run_at' | 'last_run_result'>> & { source_runs?: SourceRuns },
  ): Promise<DbJobSearch>

  /** null until the user saves them once. */
  getApplicationAnswers(): Promise<DbApplicationAnswers | null>
  /** Validated (parseApplicationAnswers); the row keeps its first id. */
  saveApplicationAnswers(answers: ApplicationAnswers): Promise<DbApplicationAnswers>

  listApplicationFiles(): Promise<DbApplicationFile[]> // metadata only
  getApplicationFileData(kind: FileKind): Promise<{ id: string; data: string } | null>
  /** Replaces this kind's file; validated (parseApplicationFile). */
  saveApplicationFile(input: { kind: FileKind; name: string; data: string }): Promise<DbApplicationFile>
  deleteApplicationFile(kind: FileKind): Promise<void>

  listResumeFiles(): Promise<DbResumeFile[]> // metadata only
  getResumeFileData(resumeId: string): Promise<{ id: string; data: string } | null>
  /** Replaces this resume's file; validated (parseResumeFile). 404 without the resume. */
  saveResumeFile(input: { resume_id: string; name: string; data: string }): Promise<DbResumeFile>
  deleteResumeFile(resumeId: string): Promise<void>

  exportSnapshot(): Promise<Snapshot>
}
