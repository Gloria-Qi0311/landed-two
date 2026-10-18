// Portal-check results (read in the user's Chrome) → status updates, ask-first.
import { processObservation } from '@landed/observation-processor'
import type { PortalResult } from '@landed/schema/portal-check'
import type { DataStore } from '../store/types'
import { isConflict, applyOutcome, loadContext } from './process'
import { QUIET } from './questions'

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
