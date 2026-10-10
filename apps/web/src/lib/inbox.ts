// Runs the observation processor against the account's store, and the user
// actions on its output (job leads + review queue). Works the same for both
// stores: local accounts process what the relay delivered into this
// browser; Cloud accounts process their pending observations via the API.
// Rules live in packages/observation-processor (docs/observation-processor.md).
import {
  applyToContext, processObservation, proposedStage,
  type ApplicationRef, type Context, type Effect, type Settings, type Stage,
} from '@landed/observation-processor'
import type { DataStore, DbApplication, DbJobLead, DbSuggestion } from './store/types'

const strip = <T extends { user_id: string }>({ user_id: _, ...rest }: T) => rest

function toRef(a: DbApplication): ApplicationRef {
  return { id: a.id, company_id: a.company_id, role: a.role, stage: a.stage, location: a.location, portal_application_url: a.portal_application_url }
}

/** Activity entry for the Sync feed / audit trail when an agent's report
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

/**
 * Process up to `limit` pending observations. Returns how many were handled.
 * A 409 (another tab saved the same lead/suggestion first) leaves that
 * observation pending; the next run sees the other tab's record and merges.
 */
export async function processPending(store: DataStore, settings: Settings, limit = 100): Promise<number> {
  const pending = await store.listPendingObservations(limit)
  if (pending.length === 0) return 0
  const [leads, apps, companies, suggestions] = await Promise.all([
    store.listJobLeads(), store.listApplications(), store.listCompanies(), store.listSuggestions(),
  ])
  let ctx: Context = {
    leads: leads.map(strip),
    applications: apps.map(toRef),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    suggestions: suggestions.map(strip),
    settings,
  }

  let handled = 0
  for (const o of pending) {
    const outcome = processObservation(o, ctx, { now: new Date().toISOString(), newId: () => crypto.randomUUID() })
    const applied: Effect[] = []
    try {
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
        if (e.type === 'create_application') {
          const created = await store.addApplication({ name: e.application.company_name }, {
            role: e.application.role, stage: e.application.stage, location: e.application.location,
            portal_application_url: e.application.job_url, source: 'Agent (email)',
            applied_at: new Date().toISOString(), next_step: 'Awaiting response',
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
    } catch (err) {
      if (isConflict(err)) continue
      throw err
    }
    await store.markObservation(o.id, outcome.status, outcome.result)
    ctx = applyToContext(ctx, applied)
    handled++
  }
  return handled
}

// ── user actions: job leads ───────────────────────────────────────────────

export async function addLeadToPipeline(store: DataStore, lead: DbJobLead, stage: 'saved' | 'applied') {
  const providers = [...new Set(lead.sources.map((s) => s.provider).filter(Boolean))].join(', ')
  const app = await store.addApplication({ name: lead.company_name }, {
    role: lead.title,
    stage,
    location: lead.location,
    portal_application_url: lead.job_url,
    source: providers ? `Agent (${providers})` : 'Agent',
    applied_at: stage === 'applied' ? new Date().toISOString() : null,
    next_step: stage === 'saved' ? 'Tailor resume' : 'Awaiting response',
  })
  await store.updateJobLead(lead.id, { status: 'saved', application_id: app.id })
  return app
}

export const dismissLead = (store: DataStore, id: string) => store.updateJobLead(id, { status: 'dismissed' })
export const restoreLead = (store: DataStore, id: string) => store.updateJobLead(id, { status: 'new' })

// ── user actions: review queue ────────────────────────────────────────────

/** Accept a suggestion. For `ambiguous`, `applicationId` is the user's pick. */
export async function acceptSuggestion(store: DataStore, s: DbSuggestion, applications: DbApplication[], applicationId?: string) {
  const resolved_at = new Date().toISOString()

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
