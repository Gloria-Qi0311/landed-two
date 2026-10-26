// Where a lead sits in the apply queue: fit × urgency (docs/leads-model.md).
// Computed when shown, never stored.
//
//   urgency  1 on the deadline day, halving about every week before it, and
//            never below a lead with no date at all (0.2: a far deadline is
//            still more known than none); a posting with no deadline counts
//            as less urgent, fading with age
//   fit      the lead's fit score, 0.5 while unscored. With Rank set to the
//            user's agent and its score made for the active search (#147):
//            0.4 × the rules' score + 0.6 × the agent's (rankedFit)
//   priority fit × (0.5 + 0.5 × urgency), so fit decides and urgency at most
//            doubles it. Closed, screened-out and past-deadline leads get
//            UNRANKED and sort last.
import type { LeadFit, LeadQueueFields, LeadRank } from '@landed/schema/lead-queue'

export type PriorityInput = Pick<LeadQueueFields, 'posted_at' | 'closed_at' | 'screen' | 'fit'> & {
  /** apply-by date, "YYYY-MM-DD" */
  deadline: string | null
}

/** How much the user's agent's score counts, next to the rules' (#147). */
export const AGENT_RANK_WEIGHT = 0.6

/** The fit the queue orders by: the rules' score, blended with the agent's
 *  when it counts (Rank set to the agent, made for the active search). The
 *  rules' score is always there; without it, the agent's alone. */
export function rankedFit(fit: LeadFit | null, rank: LeadRank | null, counts: { on: boolean; searchId: string | null }): LeadFit | null {
  if (!rank || !counts.on || !counts.searchId || rank.search_id !== counts.searchId) return fit
  const score = fit ? (1 - AGENT_RANK_WEIGHT) * fit.score + AGENT_RANK_WEIGHT * rank.score : rank.score
  return { score: Math.round(score * 1000) / 1000, reasons: [...rank.reasons, ...(fit?.reasons ?? [])] }
}

/** Below every ranked lead (priority is 0–1). */
export const UNRANKED = -1

const DAY_MS = 86_400_000
/** fit for a lead nobody has scored yet */
export const UNSCORED_FIT = 0.5
/** urgency of a lead with no deadline and no posting date: the floor */
export const NO_DATE_URGENCY = 0.2

/** Calendar days from `now`'s local date to a "YYYY-MM-DD" date (negative:
 *  it has passed). null when the date doesn't read. */
export function daysUntil(date: string | null, now: Date): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / DAY_MS)
}

/** 0–1: how soon this lead needs doing. */
export function urgency(lead: PriorityInput, now: Date): number {
  const due = daysUntil(lead.deadline, now)
  if (due !== null) return due < 0 ? 0 : Math.max(NO_DATE_URGENCY, 1 / (1 + due / 7))
  const posted = daysUntil(lead.posted_at, now)
  if (posted !== null) return Math.max(NO_DATE_URGENCY, 0.6 / (1 + Math.max(0, -posted) / 7))
  return NO_DATE_URGENCY
}

/** 0–1 for leads worth showing, higher first; UNRANKED for closed,
 *  screened-out and past-deadline ones. */
export function priority(lead: PriorityInput, now: Date): number {
  if (lead.closed_at || lead.screen?.pass === false) return UNRANKED
  const due = daysUntil(lead.deadline, now)
  if (due !== null && due < 0) return UNRANKED
  const fit = lead.fit?.score ?? UNSCORED_FIT
  return fit * (0.5 + 0.5 * urgency(lead, now))
}
