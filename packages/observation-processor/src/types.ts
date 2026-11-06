import type { LeadDedupe, LeadFit, LeadRank, LeadScreen } from '@landed/schema/lead-queue'
import type { InterviewRound } from '@landed/schema/pipeline'

// Shapes the processor reads and writes. Mirrors the job_leads /
// status_suggestions tables (apps/server/migrations/0005, local Dexie v3) and
// the parts of applications/companies/agent_observations it needs.

/** Pipeline stages (packages/schema/src/pipeline.ts): `saved` shows as a
 *  lead, one `interview` stage replaced phone + onsite. */
export type Stage = 'saved' | 'applied' | 'oa' | 'interview' | 'offer' | 'rejected' | 'ghosted'

/** `assessment` = an online assessment / take-home invitation (stage `oa`). */
export type EmailStatus = 'applied' | 'recruiter_response' | 'assessment' | 'interview' | 'rejected' | 'offer' | 'other'

export type Observation = {
  id: string
  connection_id: string
  observation_type: string
  observed_at: string
  payload_json: { payload?: Record<string, unknown> } & Record<string, unknown>
  provider?: string
  display_name?: string
}

export type LeadSource = {
  connection_id: string
  observation_id: string
  provider?: string
  seen_at: string
}

export type LeadStatus = 'new' | 'saved' | 'dismissed' | 'already_applied'

export type JobLead = {
  id: string
  fingerprint: string
  ats_key: string | null
  canonical_url: string | null
  company_key: string
  title_key: string
  company_name: string
  title: string
  job_url: string | null
  location: string | null
  description: string | null
  /** apply-by date, "YYYY-MM-DD" */
  deadline: string | null
  sources: LeadSource[]
  status: LeadStatus
  application_id: string | null
  first_seen_at: string
  last_seen_at: string
  // The apply queue (docs/leads-model.md, @landed/schema/lead-queue). Written
  // by the supply track; the processor only keeps what's there.
  /** when the source says it was posted, "YYYY-MM-DD" */
  posted_at: string | null
  /** when the posting disappeared from its source (ISO time); closed leads leave the column */
  closed_at: string | null
  /** hard filters: graduation date, sponsorship, citizenship / clearance */
  screen: LeadScreen | null
  /** match against the master resume, score 0–1 */
  fit: LeadFit | null
  /** a duplicate the rules couldn't decide, as the user's own agent judged it */
  dedupe: LeadDedupe | null
  /** the user's own agent's score, for the search it was made for */
  rank: LeadRank | null
}

export type SuggestionKind = 'stage_change' | 'new_application' | 'ambiguous' | 'note'
export type SuggestionState = 'pending' | 'accepted' | 'rejected' | 'auto_applied' | 'undone'

export type Evidence = {
  source?: string
  message_id?: string
  thread_id?: string
  sender_domain?: string
  subject?: string
  received_at?: string
  summary?: string
}

export type Suggestion = {
  id: string
  dedupe_key: string
  kind: SuggestionKind
  state: SuggestionState
  application_id: string | null
  candidate_ids: string[]
  company_name: string
  role: string | null
  status: EmailStatus
  proposed_stage: Stage | null
  previous_stage: Stage | null
  confidence: number | null
  evidence: Evidence
  observation_ids: string[]
  provider: string | null
  created_at: string
  resolved_at: string | null
}

export type ApplicationRef = {
  id: string
  company_id: string
  role: string
  stage: Stage | string
  location: string | null
  portal_application_url: string | null
  interviews?: InterviewRound[]
}

export type CompanyRef = { id: string; name: string }

export type Settings = {
  /** Apply confident email updates automatically (the default): stage
   *  changes, new applications for unmatched emails, notes straight to the
   *  activity log. Off = only confident "application received" emails apply
   *  and everything else waits for the user. Either way every automatic
   *  change can be undone, and ambiguous/low-confidence ones always ask. */
  autoApply: boolean
}

export type Context = {
  leads: JobLead[]
  applications: ApplicationRef[]
  companies: CompanyRef[]
  suggestions: Suggestion[]
  settings: Settings
}

export type NewApplication = {
  company_name: string
  role: string
  stage: Stage
  job_url: string | null
  location: string | null
  interviews?: InterviewRound[]
}

export type Effect =
  /** Insert or replace the lead (merged record). */
  | { type: 'save_lead'; lead: JobLead }
  /** Insert or replace the suggestion (merged record). */
  | { type: 'save_suggestion'; suggestion: Suggestion }
  /** Move an existing application forward; the matching suggestion is saved
   *  as auto_applied alongside, so it can be reviewed and undone. */
  | { type: 'set_stage'; application_id: string; from: Stage; to: Stage }
  /** An email scheduled an interview: the application's rounds with it added. */
  | { type: 'set_interviews'; application_id: string; interviews: InterviewRound[] }
  /** Create an application (auto-add); the runner fills the new id into the
   *  suggestion it came with. */
  | { type: 'create_application'; application: NewApplication; suggestion_id: string }

export type ProcessingStatus = 'processed' | 'needs-review' | 'rejected'

export type Outcome = {
  status: ProcessingStatus
  /** What happened, for debugging/undo (stored on the observation). */
  result: Record<string, unknown>
  effects: Effect[]
}

export type ProcessOptions = {
  now: string
  newId: () => string
}
