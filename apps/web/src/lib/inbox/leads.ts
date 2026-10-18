// Job-search results → leads, and what the user does with a lead.
import { applyToContext, processObservation, type Context, type Effect, type Stage } from '@landed/observation-processor'
import { describeFoundJob, type FoundJob } from '@landed/schema/search-brief'
import type { DataStore, DbJobLead } from '../store/types'
import { strip, toRef, isConflict } from './process'

const describe = describeFoundJob

export type IngestResult = { found: number; added: number; merged: number; already_applied: number }

/**
 * Jobs a search run on the user's computer found → job leads. Each job goes
 * through the observation processor as a `job_discovered` observation, so
 * deduplication and "already applied" use the same rules as external
 * agents. Idempotent: observation ids derive from the run (`<job id>:<n>`),
 * so ingesting the same run twice changes nothing. A source whose jobs have
 * their own ids (a public list) passes `observationIds`, one per job, so
 * seeing the same posting on the next refresh changes nothing either.
 */
export async function ingestFoundJobs(
  store: DataStore,
  jobs: FoundJob[],
  source: { run_id: string; runtime_id: string; agent: string },
  opts: { observationIds?: string[]; connectionId?: string } = {},
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
      id: opts.observationIds?.[i] ?? `${source.run_id}:${i}`,
      connection_id: opts.connectionId ?? `runtime:${source.runtime_id}`,
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
