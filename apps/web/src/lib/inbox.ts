// Runs the observation processor against the account's store, and the user
// actions on its output (job leads + review queue). Works the same for both
// stores: local accounts process what the relay delivered into this
// browser; Cloud accounts process their pending observations via the API.
// Results of tasks on the user's own computer (job searches, email checks,
// portal checks) go through the same processor. Rules live in packages/observation-processor
// (docs/observation-processor.md).
import {
  applyToContext, atsJobKey, canonicalUrl, companyKey, processObservation, proposedStage, titleKey, titleSimilarity,
  type ApplicationRef, type CompanyRef, type Context, type Effect, type Outcome, type Settings, type Stage,
} from '@landed/observation-processor'
import type { EmailFinding } from '@landed/schema/email-check'
import type { PortalResult } from '@landed/schema/portal-check'
import { describeFoundJob, type FoundJob } from '@landed/schema/search-brief'
import type { ReportedApplication } from '@landed/schema/reported-application'
import type { DataStore, DbApplication, DbJobLead, DbSuggestion } from './store/types'

const strip = <T extends { user_id: string }>({ user_id: _, ...rest }: T) => rest

function toRef(a: DbApplication): ApplicationRef {
  return {
    id: a.id, company_id: a.company_id, role: a.role, stage: a.stage, location: a.location,
    portal_application_url: a.portal_application_url, interviews: a.interviews ?? [],
  }
}

/** Activity log entry (audit trail) when an agent's report
 *  changes an application. */
async function logStageChange(store: DataStore, s: Pick<DbSuggestion, 'application_id' | 'provider' | 'evidence' | 'observation_ids'>, from: string, to: string, how: 'auto' | 'accepted' | 'undone') {
  if (!s.application_id) return
  await store.addPortalEvents([{
    type: 'status-change',
    application_id: s.application_id,
    payload_json: {
      source: 'agent', how, from, to, provider: s.provider ?? 'agent',
      subject: s.evidence?.subject ?? null, received_at: s.evidence?.received_at ?? null,
      observation_ids: s.observation_ids,
    },
  }])
}

function isConflict(e: unknown) {
  return (e as { status?: number })?.status === 409
}

/** Apply one outcome's effects to the store and return the context the next
 *  observation should see. Throws (e.g. a 409 from another tab) part-way;
 *  the caller decides whether to skip. */
async function applyOutcome(store: DataStore, outcome: Outcome, start: Context): Promise<Context> {
  let ctx = start
  const applied: Effect[] = []
  for (const e of outcome.effects) {
    if (e.type === 'save_lead') await store.saveJobLead(e.lead)
    if (e.type === 'save_suggestion') await store.saveSuggestion(e.suggestion)
    if (e.type === 'set_stage') {
      await store.updateApplication(e.application_id, {
        stage: e.to,
        ...(e.to === 'applied' && e.from === 'saved' ? { applied_at: new Date().toISOString() } : {}),
      })
      const s = outcome.effects.find((x) => x.type === 'save_suggestion')
      if (s?.type === 'save_suggestion') await logStageChange(store, s.suggestion, e.from, e.to, 'auto')
    }
    if (e.type === 'set_interviews') await store.updateApplication(e.application_id, { interviews: e.interviews })
    if (e.type === 'create_application') {
      const created = await store.addApplication({ name: e.application.company_name }, {
        role: e.application.role, stage: e.application.stage, location: e.application.location,
        portal_application_url: e.application.job_url, source: 'Agent (email)',
        applied_at: new Date().toISOString(), next_step: 'Awaiting response',
        ...(e.application.interviews ? { interviews: e.application.interviews } : {}),
      })
      await store.updateSuggestion(e.suggestion_id, { application_id: created.id })
      ctx = {
        ...ctx,
        applications: [...ctx.applications, toRef(created)],
        companies: ctx.companies.some((c) => c.id === created.company_id)
          ? ctx.companies
          : [...ctx.companies, { id: created.company_id, name: e.application.company_name }],
      }
    }
    applied.push(e)
  }
  return applyToContext(ctx, applied)
}

async function loadContext(store: DataStore, settings: Settings): Promise<Context> {
  const [leads, apps, companies, suggestions] = await Promise.all([
    store.listJobLeads(), store.listApplications(), store.listCompanies(), store.listSuggestions(),
  ])
  return {
    leads: leads.map(strip),
    applications: apps.map(toRef),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    suggestions: suggestions.map(strip),
    settings,
  }
}

/**
 * Process up to `limit` pending observations. Returns how many were handled.
 * A 409 (another tab saved the same lead/suggestion first) leaves that
 * observation pending; the next run sees the other tab's record and merges.
 */
export async function processPending(store: DataStore, settings: Settings, limit = 100): Promise<number> {
  const pending = await store.listPendingObservations(limit)
  if (pending.length === 0) return 0
  let ctx = await loadContext(store, settings)
  let handled = 0
  for (const o of pending) {
    const outcome = processObservation(o, ctx, { now: new Date().toISOString(), newId: () => crypto.randomUUID() })
    try {
      ctx = await applyOutcome(store, outcome, ctx)
    } catch (err) {
      if (isConflict(err)) continue
      throw err
    }
    await store.markObservation(o.id, outcome.status, outcome.result)
    handled++
  }
  return handled
}

// ── email check results → status updates ─────────────────────────────────

export type EmailIngestResult = {
  found: number
  /** stage changes applied automatically */
  updated: number
  /** applications added automatically (an email for something untracked) */
  added: number
  /** waiting on the user ("Needs your input") */
  needs_input: number
  notes: number
  /** already known (seen in an earlier check) or nothing to change */
  unchanged: number
}

/**
 * Emails the user's agent read (email_check task) → status updates, through
 * the processor as `application_status` observations: same matching,
 * same auto-apply rules (≥ 0.8 + evidence, forward only), same undo. Re-
 * reading an email changes nothing: suggestions dedupe on the message id.
 */
export async function ingestEmailFindings(
  store: DataStore,
  findings: EmailFinding[],
  source: { run_id: string; runtime_id: string; agent: string; mail: string },
  settings: Settings,
): Promise<EmailIngestResult> {
  let ctx = await loadContext(store, settings)
  const result: EmailIngestResult = { found: findings.length, updated: 0, added: 0, needs_input: 0, notes: 0, unchanged: 0 }
  const observedAt = new Date().toISOString()
  for (const [i, f] of findings.entries()) {
    // Agents sometimes omit the id; this keeps re-reads of the same email deduped.
    const fallback = [f.evidence.sender_domain, f.evidence.subject, f.evidence.received_at].filter(Boolean).join('|')
    const evidence = { ...f.evidence, source: source.mail.toLowerCase(), ...(f.evidence.message_id || !fallback ? {} : { message_id: fallback }) }
    const outcome = processObservation({
      id: `${source.run_id}:${i}`,
      connection_id: `runtime:${source.runtime_id}`,
      observation_type: 'application_status',
      observed_at: observedAt,
      provider: source.agent,
      payload_json: { payload: {
        status: f.status, company: f.company, role: f.role, job_url: f.job_url, confidence: f.confidence, evidence,
        interview_at: f.interview_at, interview_format: f.interview_format,
      } },
    }, ctx, { now: observedAt, newId: () => crypto.randomUUID() })
    try {
      ctx = await applyOutcome(store, outcome, ctx)
    } catch (err) {
      if (isConflict(err)) continue
      throw err
    }
    const types = outcome.effects.map((e) => e.type)
    if (types.includes('set_stage')) result.updated++
    else if (types.includes('create_application')) result.added++
    else if (outcome.status === 'needs-review' && !outcome.result.merged && outcome.effects.length) result.needs_input++
    else if (outcome.effects.some((e) => e.type === 'save_suggestion' && e.suggestion.kind === 'note') && !outcome.result.merged) result.notes++
    else result.unchanged++
  }
  await settleQuestions(store)
  return result
}

// ── search results → job leads ────────────────────────────────────────────

/** Fit, pay, sponsorship and age in one line under the lead (Leads card tooltip). */
const describe = describeFoundJob

export type IngestResult = { found: number; added: number; merged: number; already_applied: number }

/**
 * Jobs a search run on the user's computer found → job leads. Each job goes
 * through the observation processor as a `job_discovered` observation, so
 * deduplication and "already applied" use the same rules as external
 * agents. Idempotent: observation ids derive from the run (`<job id>:<n>`),
 * so ingesting the same run twice changes nothing.
 */
export async function ingestFoundJobs(
  store: DataStore,
  jobs: FoundJob[],
  source: { run_id: string; runtime_id: string; agent: string },
): Promise<IngestResult> {
  const [leads, apps, companies] = await Promise.all([store.listJobLeads(), store.listApplications(), store.listCompanies()])
  let ctx: Context = {
    leads: leads.map(strip),
    applications: apps.map(toRef),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    suggestions: [],
    settings: { autoApply: false },
  }
  const result: IngestResult = { found: jobs.length, added: 0, merged: 0, already_applied: 0 }
  const observedAt = new Date().toISOString()
  for (const [i, job] of jobs.entries()) {
    const outcome = processObservation({
      id: `${source.run_id}:${i}`,
      connection_id: `runtime:${source.runtime_id}`,
      observation_type: 'job_discovered',
      observed_at: observedAt,
      provider: source.agent,
      payload_json: { payload: {
        company: job.company, title: job.title, job_url: job.job_url, location: job.location, description: describe(job), deadline: job.deadline,
      } },
    }, ctx, { now: observedAt, newId: () => crypto.randomUUID() })
    const applied: Effect[] = []
    try {
      for (const e of outcome.effects) {
        if (e.type === 'save_lead') {
          await store.saveJobLead(e.lead)
          applied.push(e)
        }
      }
    } catch (err) {
      if (isConflict(err)) continue // another tab saved it first
      throw err
    }
    if (outcome.result.already_applied) result.already_applied++
    else if (outcome.result.merged) result.merged++
    else if (outcome.status === 'processed') result.added++
    ctx = applyToContext(ctx, applied)
  }
  return result
}

// ── user actions: job leads ───────────────────────────────────────────────

/** Add a lead to the pipeline at any stage (dragged into a Kanban column). */
export async function addLeadToPipeline(store: DataStore, lead: DbJobLead, stage: Stage) {
  const providers = [...new Set(lead.sources.map((s) => s.provider).filter(Boolean))].join(', ')
  const app = await store.addApplication({ name: lead.company_name }, {
    role: lead.title,
    stage,
    location: lead.location,
    portal_application_url: lead.job_url,
    source: providers ? `Agent (${providers})` : 'Agent',
    applied_at: stage === 'saved' ? null : new Date().toISOString(),
    next_step: stage === 'saved' ? 'Tailor resume' : 'Awaiting response',
    deadline: lead.deadline ?? null,
  })
  await store.updateJobLead(lead.id, { status: 'saved', application_id: app.id })
  return app
}

export const dismissLead = (store: DataStore, id: string) => store.updateJobLead(id, { status: 'dismissed' })
export const restoreLead = (store: DataStore, id: string) => store.updateJobLead(id, { status: 'new' })

// ── "did you apply?" after opening a posting from Landed ──────────────────
// Opening a lead's posting (or a saved application's) from Landed asks, in
// the Agent page, whether you applied. Stored as an ordinary pending
// suggestion (dedupe key `click:lead:<id>` / `click:app:<id>`), so it syncs
// and backs up like everything else; email evidence answers it on its own.

const CLICK_LEAD = 'click:lead:'
const CLICK_APP = 'click:app:'
const QUIET = 'quiet:'
export const isClickQuestion = (s: Pick<DbSuggestion, 'dedupe_key'>) =>
  s.dedupe_key.startsWith(CLICK_LEAD) || s.dedupe_key.startsWith(CLICK_APP)
export const isQuietQuestion = (s: Pick<DbSuggestion, 'dedupe_key'>) => s.dedupe_key.startsWith(QUIET)
/** Asked on the Agent page, not in "Needs your input". */
export const isPanelQuestion = (s: Pick<DbSuggestion, 'dedupe_key'>) => isClickQuestion(s) || isQuietQuestion(s)

export type ClickTarget =
  | { kind: 'lead'; lead: Pick<DbJobLead, 'id' | 'company_name' | 'title' | 'status'> }
  | { kind: 'application'; id: string; role: string; stage: string; company_name: string }

/** Remember that the user opened a posting; null when there's nothing to ask
 *  (already applied, dismissed, or the question is already open). */
export async function recordApplyClick(store: DataStore, target: ClickTarget): Promise<DbSuggestion | null> {
  if (target.kind === 'lead' ? target.lead.status !== 'new' : target.stage !== 'saved') return null
  const key = target.kind === 'lead' ? CLICK_LEAD + target.lead.id : CLICK_APP + target.id
  const existing = (await store.listSuggestions()).find((s) => s.dedupe_key === key)
  // Ask again only if the last answer was "not yet" (or an undo).
  if (existing && existing.state !== 'rejected' && existing.state !== 'undone') return null
  const now = new Date().toISOString()
  return store.saveSuggestion({
    id: existing?.id ?? crypto.randomUUID(),
    dedupe_key: key,
    kind: target.kind === 'lead' ? 'new_application' : 'stage_change',
    state: 'pending',
    application_id: target.kind === 'lead' ? null : target.id,
    candidate_ids: [],
    company_name: target.kind === 'lead' ? target.lead.company_name : target.company_name,
    role: target.kind === 'lead' ? target.lead.title : target.role,
    status: 'applied',
    proposed_stage: 'applied',
    previous_stage: null,
    confidence: null,
    evidence: { source: 'click', summary: 'You opened the job posting from Landed.' },
    observation_ids: [],
    provider: 'landed',
    created_at: now,
    resolved_at: null,
  })
}

type ClickResolution = { state: 'accepted' | 'rejected'; application_id: string | null; link_lead?: string }

/** Whether a pending click question has been answered some other way: the
 *  application moved on (by hand or from an email), or the lead was added,
 *  dismissed or matches an application that's past Saved. */
function clickResolution(s: DbSuggestion, leads: DbJobLead[], apps: ApplicationRef[], companies: CompanyRef[]): ClickResolution | null {
  if (s.dedupe_key.startsWith(CLICK_APP)) {
    const app = apps.find((a) => a.id === s.application_id)
    if (!app) return { state: 'rejected', application_id: null }
    return app.stage === 'saved' ? null : { state: 'accepted', application_id: app.id }
  }
  const lead = leads.find((l) => l.id === s.dedupe_key.slice(CLICK_LEAD.length))
  if (!lead || lead.status === 'dismissed') return { state: 'rejected', application_id: null }
  if (lead.status !== 'new') return { state: 'accepted', application_id: lead.application_id }
  const companyOf = new Map(companies.map((c) => [c.id, companyKey(c.name)]))
  const app = apps.find((a) => a.stage !== 'saved' && (
    (lead.ats_key && atsJobKey(a.portal_application_url) === lead.ats_key) ||
    (lead.canonical_url && canonicalUrl(a.portal_application_url) === lead.canonical_url) ||
    (companyOf.get(a.company_id) === lead.company_key && (titleKey(a.role) === lead.title_key || titleSimilarity(a.role, lead.title) >= 0.6))
  ))
  return app ? { state: 'accepted', application_id: app.id, link_lead: lead.id } : null
}

// ── "no news for three weeks" ─────────────────────────────────────────────
// An application in progress with no signal (no update, no email, no portal
// check) for QUIET_DAYS gets one question in the panel: check its portal,
// call it ghosted, or keep waiting (asks again QUIET_DAYS later).

export const QUIET_DAYS = 21
const DAY = 86_400_000
export const IN_PROGRESS = new Set(['applied', 'oa', 'interview', 'phone', 'onsite'])

/** Latest sign of life: an edit/move, the applied date, or any agent update about it. */
export function lastSignal(app: Pick<DbApplication, 'id' | 'last_activity_at' | 'applied_at'>, suggestions: DbSuggestion[]) {
  let t = Math.max(Date.parse(app.last_activity_at) || 0, app.applied_at ? Date.parse(app.applied_at) || 0 : 0)
  for (const s of suggestions) {
    if (s.application_id === app.id && !isPanelQuestion(s)) t = Math.max(t, Date.parse(s.created_at) || 0)
  }
  return t
}

export const quietDays = (s: DbSuggestion, now = Date.now()) =>
  Math.floor((now - (Date.parse(s.evidence?.received_at ?? s.created_at) || now)) / DAY)

/** Ask about applications that went quiet. Returns how many new questions. */
export async function flagQuietApplications(store: DataStore, now = Date.now()): Promise<number> {
  const [apps, companies, suggestions] = await Promise.all([store.listApplications(), store.listCompanies(), store.listSuggestions()])
  const name = new Map(companies.map((c) => [c.id, c.name]))
  let n = 0
  for (const app of apps) {
    if (!IN_PROGRESS.has(app.stage)) continue
    const last = lastSignal(app, suggestions)
    if (now - last < QUIET_DAYS * DAY) continue
    const existing = suggestions.find((s) => s.dedupe_key === QUIET + app.id)
    if (existing?.state === 'pending') continue
    // "Keep waiting" (or a ghosted call that was undone): ask again later.
    if (existing && now - (Date.parse(existing.resolved_at ?? existing.created_at) || 0) < QUIET_DAYS * DAY) continue
    await store.saveSuggestion({
      id: existing?.id ?? crypto.randomUUID(),
      dedupe_key: QUIET + app.id,
      kind: 'stage_change',
      state: 'pending',
      application_id: app.id,
      candidate_ids: [],
      company_name: name.get(app.company_id) ?? 'Unknown company',
      role: app.role,
      status: 'other',
      proposed_stage: 'ghosted',
      previous_stage: null,
      confidence: null,
      evidence: { source: 'quiet', received_at: new Date(last).toISOString(), summary: `No news for ${Math.floor((now - last) / DAY)} days.` },
      observation_ids: [],
      provider: 'landed',
      created_at: new Date(now).toISOString(),
      resolved_at: null,
    })
    n++
  }
  return n
}

type Resolution = { state: 'accepted' | 'rejected'; application_id: string | null; link_lead?: string }

/** Whether a pending panel question has been answered some other way. */
function resolution(
  s: DbSuggestion, leads: DbJobLead[], apps: (ApplicationRef & { last_activity_at?: string; applied_at?: string | null })[],
  companies: CompanyRef[], suggestions: DbSuggestion[],
): Resolution | null {
  if (isQuietQuestion(s)) {
    // Moot once it moves on, or something new happened since we asked.
    const app = apps.find((a) => a.id === s.application_id)
    if (!app || !IN_PROGRESS.has(app.stage)) return { state: 'rejected', application_id: app?.id ?? null }
    if (app.last_activity_at && lastSignal({ id: app.id, last_activity_at: app.last_activity_at, applied_at: app.applied_at ?? null }, suggestions) > Date.parse(s.created_at)) {
      return { state: 'rejected', application_id: app.id }
    }
    return null
  }
  return clickResolution(s, leads, apps, companies)
}

/** Questions still worth asking in the panel (and counted on its badge). */
export function openPanelQuestions(
  suggestions: DbSuggestion[], leads: DbJobLead[],
  apps: (ApplicationRef & { last_activity_at?: string; applied_at?: string | null })[], companies: CompanyRef[],
) {
  return suggestions.filter((s) => s.state === 'pending' && isPanelQuestion(s) && !resolution(s, leads, apps, companies, suggestions))
}

/** Close panel questions that were answered some other way. Returns how many. */
export async function settleQuestions(store: DataStore): Promise<number> {
  const suggestions = await store.listSuggestions()
  const pending = suggestions.filter((s) => s.state === 'pending' && isPanelQuestion(s))
  if (pending.length === 0) return 0
  const [leads, apps, companies] = await Promise.all([store.listJobLeads(), store.listApplications(), store.listCompanies()])
  const refs = apps.map((a) => ({ ...toRef(a), last_activity_at: a.last_activity_at, applied_at: a.applied_at }))
  let n = 0
  for (const s of pending) {
    const r = resolution(s, leads, refs, companies.map((c) => ({ id: c.id, name: c.name })), suggestions)
    if (!r) continue
    if (r.link_lead && r.application_id) await store.updateJobLead(r.link_lead, { status: 'saved', application_id: r.application_id })
    await store.updateSuggestion(s.id, { state: r.state, application_id: r.application_id, resolved_at: new Date().toISOString() })
    n++
  }
  return n
}

// ── portal check results → status updates ─────────────────────────────────

export type PortalIngestResult = {
  checked: number
  /** waiting on the user ("Needs your input") */
  needs_input: number
  /** applied right away (only "the portal shows it as submitted") */
  updated: number
  /** the portal shows it's still in process */
  in_process: number
  login_required: string[]
  not_found: string[]
}

/**
 * What the agent saw on candidate portals → status updates. Always in
 * "ask first" mode: a portal read by an agent changes nothing on its own
 * (except confirming a submission). "Still in process" counts as news, so the
 * quiet question for that application is put off.
 */
export async function ingestPortalResults(
  store: DataStore,
  items: { ref: string; application_id: string }[],
  results: PortalResult[],
  source: { run_id: string; runtime_id: string; agent: string },
): Promise<PortalIngestResult> {
  let ctx = await loadContext(store, { autoApply: false })
  const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
  const name = new Map(companies.map((c) => [c.id, c.name]))
  const out: PortalIngestResult = { checked: results.length, needs_input: 0, updated: 0, in_process: 0, login_required: [], not_found: [] }
  const now = new Date().toISOString()
  for (const r of results) {
    const app = apps.find((a) => a.id === items.find((i) => i.ref === r.ref)?.application_id)
    if (!app) continue
    const company = name.get(app.company_id) ?? 'Unknown company'
    if (r.outcome === 'login_required') { out.login_required.push(company); continue }
    if (r.outcome !== 'status_found' || !r.status) { out.not_found.push(company); continue }
    let host: string | undefined
    try {
      host = new URL(r.page_url ?? app.portal_application_url ?? '').hostname
    } catch {
      host = undefined
    }
    const said = (r.status_text ?? r.status).toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
    const outcome = processObservation({
      id: `${source.run_id}:${r.ref}`,
      connection_id: `runtime:${source.runtime_id}`,
      observation_type: 'application_status',
      observed_at: now,
      provider: source.agent,
      payload_json: { payload: {
        status: r.status, company, role: app.role, job_url: app.portal_application_url, confidence: r.confidence ?? 0.9,
        evidence: {
          source: 'portal', message_id: `portal:${app.id}:${said}`, ...(host ? { sender_domain: host } : {}),
          subject: r.status_text ?? r.status, received_at: now, ...(r.note ? { summary: r.note } : {}),
        },
      } },
    }, ctx, { now, newId: () => crypto.randomUUID() })
    try {
      ctx = await applyOutcome(store, outcome, ctx)
    } catch (err) {
      if (isConflict(err)) continue
      throw err
    }
    if (outcome.effects.some((e) => e.type === 'set_stage')) out.updated++
    else if (outcome.status === 'needs-review') out.needs_input++
    else {
      out.in_process++
      // Still in process: that's news — put off the "no news" question.
      const quiet = (await store.listSuggestions()).find((s) => s.dedupe_key === QUIET + app.id && s.state === 'pending')
      if (quiet) await store.updateSuggestion(quiet.id, { state: 'rejected', resolved_at: now })
    }
  }
  return out
}

// ── user actions: review queue ────────────────────────────────────────────

/** Accept a suggestion. For `ambiguous`, `applicationId` is the user's pick. */
export async function acceptSuggestion(store: DataStore, s: DbSuggestion, applications: DbApplication[], applicationId?: string) {
  const resolved_at = new Date().toISOString()

  // "Yes, I applied" to a lead: add the lead itself (linked), not a copy.
  if (s.dedupe_key.startsWith(CLICK_LEAD)) {
    const lead = (await store.listJobLeads()).find((l) => l.id === s.dedupe_key.slice(CLICK_LEAD.length))
    if (!lead) throw new Error('That job is no longer in your Leads.')
    const app = lead.application_id ? null : await addLeadToPipeline(store, lead, 'applied')
    return store.updateSuggestion(s.id, { state: 'accepted', application_id: app?.id ?? lead.application_id, resolved_at })
  }

  if (s.kind === 'new_application') {
    const app = await store.addApplication({ name: s.company_name }, {
      role: s.role ?? 'Unknown role', stage: s.proposed_stage ?? 'applied',
      source: s.provider ? `Agent (${s.provider})` : 'Agent', applied_at: resolved_at,
      next_step: 'Awaiting response',
    })
    return store.updateSuggestion(s.id, { state: 'accepted', application_id: app.id, resolved_at })
  }

  const targetId = s.kind === 'ambiguous' ? applicationId : s.application_id
  const app = applications.find((a) => a.id === targetId)
  if (!app) throw new Error('Pick which application this is about first.')
  const to: Stage | null = s.kind === 'ambiguous' ? proposedStage(s.status, app.stage) : s.proposed_stage
  if (!to || to === app.stage || s.kind === 'note') {
    // information only (e.g. recruiter replied) — acknowledge
    return store.updateSuggestion(s.id, { state: 'accepted', application_id: app.id, resolved_at })
  }
  await store.updateApplication(app.id, {
    stage: to,
    ...(to === 'applied' && !app.applied_at ? { applied_at: resolved_at } : {}),
  })
  await logStageChange(store, { ...s, application_id: app.id }, app.stage, to, 'accepted')
  return store.updateSuggestion(s.id, {
    state: 'accepted', application_id: app.id, proposed_stage: to, previous_stage: app.stage as Stage, resolved_at,
  })
}

export const rejectSuggestion = (store: DataStore, id: string) =>
  store.updateSuggestion(id, { state: 'rejected', resolved_at: new Date().toISOString() })

/** Undo an accepted / auto-applied stage change (moves the application back). */
export async function undoSuggestion(store: DataStore, s: DbSuggestion, applications: DbApplication[]) {
  const app = applications.find((a) => a.id === s.application_id)
  if (s.previous_stage && app && s.proposed_stage && app.stage === s.proposed_stage) {
    await store.updateApplication(app.id, { stage: s.previous_stage })
    await logStageChange(store, s, s.proposed_stage, s.previous_stage, 'undone')
  }
  return store.updateSuggestion(s.id, { state: 'undone', resolved_at: new Date().toISOString() })
}

export const canUndo = (s: DbSuggestion) =>
  (s.state === 'accepted' || s.state === 'auto_applied') && !!s.previous_stage && !!s.application_id

// ── applications the user showed their agent (screenshots) ────────────────
// Some sites send no confirmation email: the user shares a screenshot in the
// Agent chat, the agent reads it (```landed-applications block,
// packages/schema/src/reported-application.ts), and the card on the Agent
// page adds it here — only when the user clicks.

export type ReportedMatch =
  | { kind: 'new' }
  | { kind: 'lead'; lead: DbJobLead }
  | { kind: 'existing'; app: DbApplication; forward: boolean }

const REPORTED_ORDER = ['saved', 'applied', 'oa', 'interview', 'offer']
const MIN_ROLE_SIMILARITY = 0.6

/** Would moving `current` to what the screenshot shows be news? */
export function isForward(current: string, shown: string): boolean {
  if (current === shown) return false
  if (shown === 'rejected') return current !== 'rejected'
  if (current === 'rejected' || current === 'ghosted') return REPORTED_ORDER.includes(shown) && shown !== 'saved'
  return REPORTED_ORDER.indexOf(shown) > REPORTED_ORDER.indexOf(current)
}

/** Is it already in Landed? Same employer and the same link or a close
 *  enough role. Stricter than email matching: another role at the same
 *  company is another application. */
export function matchReported(
  r: ReportedApplication, apps: DbApplication[], companies: { id: string; name: string }[], leads: DbJobLead[],
): ReportedMatch {
  const key = companyKey(r.company)
  const ids = new Set(companies.filter((c) => companyKey(c.name) === key).map((c) => c.id))
  const ats = atsJobKey(r.job_url)
  const url = canonicalUrl(r.job_url)
  const app = apps.find((a) => ids.has(a.company_id) && (
    (ats && atsJobKey(a.portal_application_url) === ats) || (url && canonicalUrl(a.portal_application_url) === url) || titleSimilarity(a.role, r.role) >= MIN_ROLE_SIMILARITY))
  if (app) return { kind: 'existing', app, forward: isForward(app.stage, r.stage) }
  const lead = leads.find((l) => l.status === 'new' && l.company_key === key && ((ats && l.ats_key === ats) || titleSimilarity(l.title, r.role) >= MIN_ROLE_SIMILARITY))
  return lead ? { kind: 'lead', lead } : { kind: 'new' }
}

/** Add it (or move the existing one along, or take its lead into the pipeline). */
export async function addReportedApplication(store: DataStore, r: ReportedApplication): Promise<DbApplication> {
  const [apps, companies, leads] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobLeads()])
  const match = matchReported(r, apps, companies, leads)
  const appliedAt = r.stage === 'saved' ? null : r.applied_on ? `${r.applied_on}T12:00:00.000Z` : new Date().toISOString()
  let app: DbApplication
  if (match.kind === 'existing') {
    app = match.forward
      ? await store.updateApplication(match.app.id, { stage: r.stage, applied_at: match.app.applied_at ?? appliedAt })
      : match.app
  } else if (match.kind === 'lead') {
    app = await addLeadToPipeline(store, match.lead, r.stage)
    if (r.applied_on || r.note) app = await store.updateApplication(app.id, { applied_at: appliedAt, ...(r.note ? { notes: r.note } : {}) })
  } else {
    app = await store.addApplication({ name: r.company }, {
      role: r.role, stage: r.stage, applied_at: appliedAt, location: r.location, portal_application_url: r.job_url,
      notes: r.note, source: 'Screenshot (Agent)', next_step: r.stage === 'saved' ? null : 'Awaiting response',
    })
  }
  await settleQuestions(store) // e.g. a "did you apply?" for it
  return app
}
