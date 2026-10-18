// The user's answers to the review queue: accept, dismiss, undo.
import { proposedStage, type Stage } from '@landed/observation-processor'
import type { DataStore, DbApplication, DbSuggestion } from '../store/types'
import { addLeadToPipeline } from './leads'
import { logStageChange } from './process'
import { CLICK_LEAD } from './questions'

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
