// Landed's own questions on the Agent page: "did you apply?" after opening a posting,
// "no news for three weeks", and closing them when something else answers.
import { atsJobKey, canonicalUrl, companyKey, titleKey, titleSimilarity, type ApplicationRef, type CompanyRef } from '@landed/observation-processor'
import type { DataStore, DbApplication, DbJobLead, DbSuggestion } from '../store/types'
import { toRef } from './process'

// ── "did you apply?" after opening a posting from Landed ──────────────────
// Opening a lead's posting (or a saved application's) from Landed asks, in
// the Agent page, whether you applied. Stored as an ordinary pending
// suggestion (dedupe key `click:lead:<id>` / `click:app:<id>`), so it syncs
// and backs up like everything else; email evidence answers it on its own.

export const CLICK_LEAD = 'click:lead:'
const CLICK_APP = 'click:app:'
export const QUIET = 'quiet:'
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
// An application in progress with no signal (no update, no email) for
// QUIET_DAYS gets one question in the panel: call it ghosted, or keep waiting
// (asks again QUIET_DAYS later).

export const QUIET_DAYS = 21
const DAY = 86_400_000
const IN_PROGRESS = new Set(['applied', 'oa', 'interview', 'phone', 'onsite'])

/** Latest sign of life: an edit/move, the applied date, or any agent update about it. */
function lastSignal(app: Pick<DbApplication, 'id' | 'last_activity_at' | 'applied_at'>, suggestions: DbSuggestion[]) {
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
