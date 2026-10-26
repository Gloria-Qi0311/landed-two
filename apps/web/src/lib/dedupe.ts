// Remove duplicates, the agent's part (#146; docs/leads-model.md). The rules
// come first (packages/observation-processor: sameJob merges a posting seen
// twice as it arrives). The pairs they can't call (uncertainPairs) go to the
// user's own agent, through the extension and Landed for Mac (`same_job`),
// when Workflow → Remove duplicates is set to the agent. Only the postings'
// public details go out, never anything about the user.
//   same       the lead with less to go on is hidden under the other
//              (dedupe.same_as): never deleted, and Split brings it back
//   different, unsure   both stay: one extra lead beats a real job hidden
// Either way the pair is never asked again (dedupe.checked). Each batch is
// kept as an ai_run (task same_job): the pairs, the answers, the tokens.
import { uncertainPairs, type LeadPair } from '@landed/observation-processor'
import { MAX_DEDUPE_CHECKED, type LeadDedupe } from '@landed/schema/lead-queue'
import type { DataStore, DbJobLead } from './store/types'

export type SameJobPosting = { title: string; company: string; location: string; url: string; description: string }
export type SameJobPair = { id: string; a: SameJobPosting; b: SameJobPosting }
export type SameJobVerdict = { id: string; verdict: 'same' | 'different' | 'unsure'; reason: string }
export type SameJobAnswer = { verdicts: SameJobVerdict[]; usage: { input_tokens: number; output_tokens: number }; model: string | null }
/** Ask the user's own agent (throws when it can't be asked). */
export type AskSameJob = (pairs: SameJobPair[]) => Promise<SameJobAnswer>

/** What one batch asked and what it took. */
export type DedupeBatch = {
  at: string
  asked: number
  same: number
  different: number
  unsure: number
  input_tokens: number
  output_tokens: number
  model: string | null
}

const DESCRIPTION_CHARS = 1500
/** A batch's budget, in tokens of postings sent (about 4 characters a
 *  token): pairs past it wait for the next batch. */
export const BATCH_TOKEN_BUDGET = 6_000

const posting = (l: DbJobLead): SameJobPosting => ({
  title: l.title, company: l.company_name, location: l.location ?? '', url: l.job_url ?? '',
  description: (l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS),
})

/** The pairs to ask about now, within the batch's budget. */
export function batchOf(leads: DbJobLead[]): { pairs: LeadPair[]; request: SameJobPair[] } {
  const pairs: LeadPair[] = []
  const request: SameJobPair[] = []
  let budget = BATCH_TOKEN_BUDGET
  for (const p of uncertainPairs(leads)) {
    const item = { id: `p${request.length + 1}`, a: posting(p.keep as DbJobLead), b: posting(p.other as DbJobLead) }
    const cost = Math.ceil(JSON.stringify(item).length / 4)
    if (cost > budget && request.length) break
    budget -= cost
    pairs.push(p)
    request.push(item)
  }
  return { pairs, request }
}

/** One batch: ask about the pairs the rules can't call, and keep the
 *  answers. Null when there's nothing to ask. */
export async function dedupeWithAgent(store: DataStore, ask: AskSameJob, now = new Date()): Promise<DedupeBatch | null> {
  const { pairs, request } = batchOf(await store.listJobLeads())
  if (request.length === 0) return null
  const answer = await ask(request)
  const byId = new Map(answer.verdicts.map((v) => [v.id, v]))
  const at = now.toISOString()
  const by = answer.model ?? 'Your agent'
  const batch: DedupeBatch = { at, asked: request.length, same: 0, different: 0, unsure: 0, ...answer.usage, model: answer.model }

  const next = new Map<string, LeadDedupe | null>()
  const current = (l: LeadPair['keep']) => (next.has(l.id) ? next.get(l.id)! : l.dedupe)
  const note = (l: LeadPair['keep'], other: string, same?: { as: string; reason: string }) => {
    const d = current(l)
    next.set(l.id, {
      same_as: same ? same.as : d?.same_as ?? null,
      checked: [...(d?.checked ?? []).filter((id) => id !== other), other].slice(-MAX_DEDUPE_CHECKED),
      by, at, reason: same ? same.reason || null : d?.reason ?? null,
    })
  }
  const hidden = new Set<string>()
  pairs.forEach((p, i) => {
    const v = byId.get(request[i].id)
    const verdict = v?.verdict ?? 'unsure'
    batch[verdict]++
    if (verdict === 'same') {
      // One of them was just hidden under a third: ask again, next batch,
      // against the one that's left.
      if (hidden.has(p.keep.id) || hidden.has(p.other.id)) return
      hidden.add(p.other.id)
      note(p.other, p.keep.id, { as: p.keep.id, reason: v?.reason ?? '' })
      note(p.keep, p.other.id)
    } else {
      note(p.keep, p.other.id)
      note(p.other, p.keep.id)
    }
  })
  for (const [id, dedupe] of next) await store.updateJobLead(id, { dedupe })
  await store.addAiRun({
    task: 'same_job', provider: /claude/i.test(by) ? 'claude' : 'other',
    prompt_text: JSON.stringify(request), response_text: JSON.stringify(answer.verdicts), parsed_json: batch, parse_format: 'json',
  })
  return batch
}

/** The leads hidden under each lead, as the agent judged them. */
export function duplicatesOf(leads: DbJobLead[]): Map<string, DbJobLead[]> {
  const out = new Map<string, DbJobLead[]>()
  for (const l of leads) {
    const of = l.dedupe?.same_as
    if (of) out.set(of, [...(out.get(of) ?? []), l])
  }
  return out
}

/** Hidden under another lead (and that lead is still there to show). */
export function isHiddenDuplicate(lead: DbJobLead, ids: Set<string>): boolean {
  return !!lead.dedupe?.same_as && ids.has(lead.dedupe.same_as)
}

/** Split: the lead is its own again. The pair stays compared, so it isn't asked again. */
export function splitDuplicate(store: DataStore, lead: DbJobLead) {
  if (!lead.dedupe?.same_as) return Promise.resolve(lead)
  return store.updateJobLead(lead.id, { dedupe: { ...lead.dedupe, same_as: null } })
}
