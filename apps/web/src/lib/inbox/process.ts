// Run the observation processor and apply its outcomes to the store.
import { applyToContext, processObservation, type ApplicationRef, type Context, type Effect, type Outcome, type Settings } from '@landed/observation-processor'
import type { DataStore, DbApplication, DbSuggestion } from '../store/types'

export const strip = <T extends { user_id: string }>({ user_id: _, ...rest }: T) => rest

export function toRef(a: DbApplication): ApplicationRef {
  return {
    id: a.id, company_id: a.company_id, role: a.role, stage: a.stage, location: a.location,
    portal_application_url: a.portal_application_url, interviews: a.interviews ?? [],
  }
}

/** Activity log entry (audit trail) when an agent's report
 *  changes an application. */
export async function logStageChange(store: DataStore, s: Pick<DbSuggestion, 'application_id' | 'provider' | 'evidence' | 'observation_ids'>, from: string, to: string, how: 'auto' | 'accepted' | 'undone') {
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

export function isConflict(e: unknown) {
  return (e as { status?: number })?.status === 409
}

/** Apply one outcome's effects to the store and return the context the next
 *  observation should see. Throws (e.g. a 409 from another tab) part-way;
 *  the caller decides whether to skip. */
export async function applyOutcome(store: DataStore, outcome: Outcome, start: Context): Promise<Context> {
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

export async function loadContext(store: DataStore, settings: Settings): Promise<Context> {
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
