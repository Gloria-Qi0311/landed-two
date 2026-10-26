// Rank, the agent's part (#147; docs/leads-model.md). The rules' fit score is
// always there (lib/fit.ts → scoreFit). When Workflow → Rank is set to the
// user's own agent, new leads go to it in batches, through the extension and
// Landed for Mac (`rank_leads`), with what the chat agent is told about the
// user (lib/chat-context.ts: never contact details, address, date of birth
// or EEO answers). Each comes back with a 0–1 score and 1–3 reasons, kept on
// the lead for the active search (rank.search_id). While that search is
// active and Rank stays on the agent, the queue orders by 0.4 × the rules'
// score + 0.6 × the agent's (packages/supply → rankedFit). A new lead waits
// for its score at most RANK_WAIT_MS, then shows with the rules' score.
// Each batch is kept as an ai_run (task rank_leads): the postings, the
// scores, the tokens.
import { chatContext } from './chat-context'
import type { DataStore, DbJobLead } from './store/types'

export type RankLead = { id: string; title: string; company: string; location: string; description: string }
export type LeadScore = { id: string; score: number; reasons: string[] }
export type RankAnswer = { scores: LeadScore[]; usage: { input_tokens: number; output_tokens: number }; model: string | null }
/** Ask the user's own agent (throws when it can't be asked). */
export type AskRank = (context: string, leads: RankLead[]) => Promise<RankAnswer>

/** What one batch asked and what it took. */
export type RankBatch = { at: string; asked: number; scored: number; input_tokens: number; output_tokens: number; model: string | null }

/** At most this many leads a batch. */
export const MAX_RANK_LEADS = 8
/** A batch's budget, in tokens of postings sent (about 4 characters a token). */
export const RANK_TOKEN_BUDGET = 4_000
/** A new lead waits this long for its score before it shows with the rules' alone. */
export const RANK_WAIT_MS = 5 * 60_000
const DESCRIPTION_CHARS = 2500

/** Leads the agent hasn't scored for this search yet: new, open, not
 *  filtered out or hidden as a duplicate, and not already asked about
 *  (`skip`); newest first. */
export function toRank(leads: DbJobLead[], searchId: string, skip: Set<string> = new Set()): DbJobLead[] {
  return leads
    .filter((l) => l.status === 'new' && !l.closed_at && l.screen?.pass !== false && !l.dedupe?.same_as
      && l.rank?.search_id !== searchId && !skip.has(l.id))
    .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at))
}

const posting = (l: DbJobLead): RankLead => ({
  id: l.id, title: l.title, company: l.company_name, location: l.location ?? '',
  description: (l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS),
})

/** The next batch, within its budget. */
export function rankBatchOf(leads: DbJobLead[], searchId: string, skip?: Set<string>): RankLead[] {
  const batch: RankLead[] = []
  let budget = RANK_TOKEN_BUDGET
  for (const lead of toRank(leads, searchId, skip).slice(0, MAX_RANK_LEADS)) {
    const item = posting(lead)
    const cost = Math.ceil(JSON.stringify(item).length / 4)
    if (cost > budget && batch.length) break
    budget -= cost
    batch.push(item)
  }
  return batch
}

/** One batch: score the newest leads not yet scored for the active search.
 *  `skip` collects every lead asked about, so one the agent gave no score
 *  isn't asked again. Null when there's nothing to score. */
export async function rankWithAgent(store: DataStore, ask: AskRank, skip: Set<string>, now = new Date()): Promise<RankBatch | null> {
  const [leads, searches, resumes, answers] = await Promise.all([
    store.listJobLeads(), store.listJobSearches(), store.listResumes(), store.getApplicationAnswers(),
  ])
  const search = searches.find((s) => s.status === 'active')
  if (!search) return null
  const batch = rankBatchOf(leads, search.id, skip)
  if (batch.length === 0) return null
  for (const l of batch) skip.add(l.id)
  const context = chatContext({ resumes, answers: answers?.answers ?? null, search: search.brief }) ?? ''
  const answer = await ask(context, batch)
  const at = now.toISOString()
  const by = answer.model ?? 'Your agent'
  const asked = new Set(batch.map((l) => l.id))
  let scored = 0
  for (const s of answer.scores) {
    if (!asked.has(s.id) || !s.reasons.length) continue
    await store.updateJobLead(s.id, { rank: { score: s.score, reasons: s.reasons.slice(0, 3), by, at, search_id: search.id } })
    asked.delete(s.id)
    scored++
  }
  const result: RankBatch = { at, asked: batch.length, scored, ...answer.usage, model: answer.model }
  await store.addAiRun({
    task: 'rank_leads', provider: /claude/i.test(by) ? 'claude' : 'other',
    prompt_text: JSON.stringify(batch), response_text: JSON.stringify(answer.scores), parsed_json: result, parse_format: 'json',
  })
  return result
}

/** Held out of Leads until the agent scores it for this search, for at most
 *  RANK_WAIT_MS after it was first seen. */
export function waitingForRank(lead: DbJobLead, o: { searchId: string | null; now: number }): boolean {
  if (!o.searchId || lead.rank?.search_id === o.searchId || lead.status !== 'new' || lead.closed_at) return false
  return o.now - Date.parse(lead.first_seen_at) < RANK_WAIT_MS
}
