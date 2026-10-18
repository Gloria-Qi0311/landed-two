// Applications the user showed their agent (screenshots) → added or moved forward.
import { atsJobKey, canonicalUrl, companyKey, titleSimilarity } from '@landed/observation-processor'
import type { ReportedApplication } from '@landed/schema/reported-application'
import type { DataStore, DbApplication, DbJobLead } from '../store/types'
import { addLeadToPipeline } from './leads'
import { settleQuestions } from './questions'

// ── applications the user showed their agent (screenshots) ────────────────
// Some sites send no confirmation email: the user shares a screenshot in the
// Agent chat, the agent reads it (```landed-applications block,
// packages/schema/src/reported-application.ts), and the card on the Agent
// page adds it here — only when the user clicks.

export type ReportedMatch =
  | { kind: 'new' }
  | { kind: 'lead'; lead: DbJobLead }
  | { kind: 'existing'; app: DbApplication; company: string; forward: boolean }

const REPORTED_ORDER = ['saved', 'applied', 'oa', 'interview', 'offer']
// Rows of one screenshot are often the same title in different places or
// tracks (产品管培生（上海） / （广东省）): compare whole titles, brackets
// included, and only call it the same when it's nearly identical.
const MIN_ROLE_SIMILARITY = 0.8
const sameRole = (a: string, b: string) => titleSimilarity(a, b, { keepBrackets: true }) >= MIN_ROLE_SIMILARITY

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
  if (!key) return { kind: 'new' }
  const app = apps.find((a) => ids.has(a.company_id) && (
    (ats && atsJobKey(a.portal_application_url) === ats) || (url && canonicalUrl(a.portal_application_url) === url) || sameRole(a.role, r.role)))
  if (app) {
    const company = companies.find((c) => c.id === app.company_id)?.name ?? r.company
    return { kind: 'existing', app, company, forward: isForward(app.stage, r.stage) }
  }
  const lead = leads.find((l) => l.status === 'new' && companyKey(l.company_name) === key && ((ats && l.ats_key === ats) || sameRole(l.title, r.role)))
  return lead ? { kind: 'lead', lead } : { kind: 'new' }
}

/** Add it (or move the existing one along, or take its lead into the pipeline). */
export async function addReportedApplication(store: DataStore, r: ReportedApplication, source = 'Screenshot (Agent)'): Promise<DbApplication> {
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
      notes: r.note, source, next_step: r.stage === 'saved' ? null : 'Awaiting response',
    })
  }
  await settleQuestions(store) // e.g. a "did you apply?" for it
  return app
}
