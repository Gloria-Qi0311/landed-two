// Fit scores and the queue's order (#93; docs/leads-model.md). Each
// candidate lead is scored with packages/supply's scoreFit against the active
// search and the resume — in the browser, since it reads the resume — and the
// Leads column sorts by priority (fit × urgency). Saved applications sort by
// the lead they came from, or by their deadline alone.
import type { Resume } from '@landed/schema'
import { priority, scoreFit, UNRANKED } from '@landed/supply'
import { screeningResume } from './screen'
import type { DataStore, DbJobLead } from './store/types'

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Score every candidate lead (new, open); writes only what changed. */
export async function scoreLeads(store: DataStore, now: Date = new Date()): Promise<number> {
  const [leads, resumes, searches] = await Promise.all([store.listJobLeads(), store.listResumes(), store.listJobSearches()])
  const brief = searches.find((s) => s.status === 'active')?.brief ?? null
  const resume: Resume | null = screeningResume(resumes)
  let changed = 0
  for (const lead of leads) {
    if (lead.status !== 'new' || lead.closed_at) continue
    const fit = scoreFit({ title: lead.title, location: lead.location, description: lead.description, brief, resume }, now)
    if (same(fit, lead.fit)) continue
    await store.updateJobLead(lead.id, { fit })
    changed++
  }
  return changed
}

type Ranked = { priority: number; deadline: string | null }

/** Priority of a Leads card: a lead's own, a saved application's from the
 *  lead it came from (else its deadline alone, as an unscored lead). */
export function rankOf(
  item: { lead: DbJobLead; app?: undefined } | { app: { id: string; deadline: string | null }; lead?: undefined },
  leadFor: (appId: string) => DbJobLead | undefined,
  now: Date,
): Ranked {
  if (item.lead) return { priority: priority(item.lead, now), deadline: item.lead.deadline }
  const from = leadFor(item.app.id)
  const base = { deadline: item.app.deadline, posted_at: from?.posted_at ?? null, closed_at: null, screen: null, fit: from?.fit ?? null }
  return { priority: priority(base, now), deadline: item.app.deadline }
}

/** Highest priority first; ties by soonest deadline; unranked last. */
export function byPriority(a: Ranked, b: Ranked): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline)
  return a.deadline ? -1 : b.deadline ? 1 : 0
}

export { UNRANKED }
