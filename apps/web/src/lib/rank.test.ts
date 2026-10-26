// Ranking new leads with the user's agent (#147), through the real local store.
import 'fake-indexeddb/auto'
import { describe, expect, test, vi } from 'vitest'
import { AGENT_RANK_WEIGHT } from '@landed/supply'
import { ingestFoundJobs } from './inbox'
import { createLocalStore } from './store/local'
import type { DbJobLead } from './store/types'
import { queueFit, rankOf, RULES_ONLY } from './fit'
import { MAX_RANK_LEADS, RANK_WAIT_MS, rankBatchOf, rankWithAgent, toRank, waitingForRank, type AskRank } from './rank'

let n = 0
const fresh = () => createLocalStore(`landed-rank-${++n}`)
const now = new Date('2026-10-26T12:00:00Z')

const brief = { summary: 'Data analyst roles in Seattle', roles: ['Data Analyst'], locations: ['Seattle'] }

// Made-up companies, people and postings.
async function seed(store: ReturnType<typeof fresh>, titles: string[]) {
  await ingestFoundJobs(store, titles.map((title, i) => ({
    company: `Company ${i}`, title, job_url: null, location: 'Seattle, WA', posted: null, deadline: null, salary: null, sponsorship: null, why: null,
  })), { run_id: 'r1', runtime_id: 'claude', agent: 'Claude Code' }, { descriptions: titles.map((t) => `${t}: SQL and dashboards.`) })
}

const scoring = (score = 0.9) => vi.fn<AskRank>(async (_context, leads) => ({
  scores: leads.map((l) => ({ id: l.id, score, reasons: [`${l.title} asks for SQL, which they use.`, 'Seattle, where they want to be.'] })),
  usage: { input_tokens: 5000, output_tokens: 400 }, model: 'Claude Code',
}))

describe('Rank with your agent', () => {
  test('the agent gets the chat context (no contact details) and the postings; every score has reasons and is for the active search', async () => {
    const store = fresh()
    await store.addResume({
      name: 'Master', set_current: true, parsed_json: {
        basic: { name: 'Alex Rivera', email: 'alex.rivera@example.com', phone: '(206) 555-0142', location: 'Seattle, WA' },
        internship: [{ company: 'Northwind Robotics', title: 'Data Intern', start_date: '2025-06', end_date: '2025-09', description: 'Built SQL dashboards.' }],
        skills: ['SQL', 'Tableau'],
      } as never,
    })
    await store.addJobSearch(brief as never)
    await seed(store, ['Data Analyst', 'Product Analyst'])
    const ask = scoring()
    const batch = await rankWithAgent(store, ask, new Set(), now)
    expect(batch).toEqual({ at: now.toISOString(), asked: 2, scored: 2, input_tokens: 5000, output_tokens: 400, model: 'Claude Code' })
    const [context, sent] = ask.mock.calls[0]
    expect(context).toMatch(/Data analyst roles in Seattle/)
    expect(context).toMatch(/Data Intern at Northwind Robotics/)
    expect(context).not.toMatch(/555-0142|alex\.rivera@|Alex Rivera/)
    expect(sent.map((l) => l.title).sort()).toEqual(['Data Analyst', 'Product Analyst'])
    expect(Object.keys(sent[0]).sort()).toEqual(['company', 'description', 'id', 'location', 'title'])

    const search = (await store.listJobSearches())[0]
    for (const lead of await store.listJobLeads()) {
      expect(lead.rank).toMatchObject({ score: 0.9, by: 'Claude Code', search_id: search.id })
      expect(lead.rank!.reasons.length).toBeGreaterThanOrEqual(1)
    }
    // scored for this search: nothing left to ask
    expect(await rankWithAgent(store, ask, new Set(), now)).toBeNull()
    const snap = await store.exportSnapshot()
    expect(snap.ai_runs[0]).toMatchObject({ task: 'rank_leads', provider: 'claude', parsed_json: { asked: 2, scored: 2, input_tokens: 5000 } })
  })

  test('a lead the agent gives no score (or no reasons) keeps the rules\' score and is not asked again', async () => {
    const store = fresh()
    await store.addJobSearch(brief as never)
    await seed(store, ['Data Analyst'])
    const ask = vi.fn<AskRank>(async (_c, leads) => ({ scores: [{ id: leads[0].id, score: 0.9, reasons: [] }], usage: { input_tokens: 10, output_tokens: 1 }, model: 'Claude Code' }))
    const skip = new Set<string>()
    expect(await rankWithAgent(store, ask, skip, now)).toMatchObject({ asked: 1, scored: 0 })
    expect((await store.listJobLeads())[0].rank).toBeNull()
    expect(await rankWithAgent(store, ask, skip, now)).toBeNull()
  })

  test('a new search ranks again; the old scores stop counting', async () => {
    const store = fresh()
    await store.addJobSearch(brief as never)
    await seed(store, ['Data Analyst'])
    await rankWithAgent(store, scoring(0.9), new Set(), now)
    const first = (await store.listJobSearches())[0]
    await store.addJobSearch({ ...brief, roles: ['Business Analyst'] } as never)
    const second = (await store.listJobSearches()).find((s) => s.status === 'active')!
    const [lead] = await store.listJobLeads()
    expect(toRank([lead], second.id)).toHaveLength(1)
    expect(queueFit(lead, { on: true, searchId: second.id })).toEqual(lead.fit)
    await rankWithAgent(store, scoring(0.3), new Set(), now)
    expect((await store.listJobLeads())[0].rank).toMatchObject({ score: 0.3, search_id: second.id })
    expect(first.id).not.toBe(second.id)
  })

  test('a batch is capped and keeps to its budget, newest first', async () => {
    const store = fresh()
    await store.addJobSearch(brief as never)
    await seed(store, Array.from({ length: 12 }, (_, i) => `Data Analyst ${i}`))
    const search = (await store.listJobSearches())[0]
    const leads = await store.listJobLeads()
    expect(rankBatchOf(leads, search.id)).toHaveLength(MAX_RANK_LEADS)
    const long = leads.map((l) => ({ ...l, description: 'x'.repeat(9000) }))
    const batch = rankBatchOf(long, search.id)
    expect(batch.length).toBeLessThan(MAX_RANK_LEADS)
    expect(batch.every((l) => l.description.length === 2500)).toBe(true)
    // filtered out, hidden as a duplicate, closed or not new: never ranked
    const [a, b, c, d] = leads
    expect(toRank([
      { ...a, screen: { pass: false, reasons: ['US citizens only'] } },
      { ...b, dedupe: { same_as: c.id, checked: [c.id], by: 'Claude Code', at: now.toISOString(), reason: null } },
      { ...c, closed_at: now.toISOString() },
      { ...d, status: 'dismissed' },
    ], search.id)).toEqual([])
  })

  test('an agent that can\'t be asked changes nothing', async () => {
    const store = fresh()
    await store.addJobSearch(brief as never)
    await seed(store, ['Data Analyst'])
    await expect(rankWithAgent(store, async () => { throw new Error('Landed for Mac is not installed') }, new Set(), now)).rejects.toThrow(/not installed/)
    expect((await store.listJobLeads())[0].rank).toBeNull()
  })
})

describe('the order and the wait', () => {
  const lead = (over: Partial<DbJobLead> = {}): DbJobLead => ({
    id: 'l1', user_id: 'local', fingerprint: 'job:x', ats_key: null, canonical_url: null, company_key: 'lumen labs', title_key: 'data analyst',
    company_name: 'Lumen Labs', title: 'Data Analyst', job_url: null, location: null, description: null, deadline: null, sources: [], status: 'new',
    application_id: null, first_seen_at: now.toISOString(), last_seen_at: now.toISOString(), posted_at: null, closed_at: null, screen: null,
    fit: { score: 0.5, reasons: ['Title matches the search'] }, dedupe: null, rank: null, ...over,
  })
  const rank = { score: 1, reasons: ['Asks for SQL, which they use.'], by: 'Claude Code', at: now.toISOString(), search_id: 's1' }

  test('without the agent, the order is the rules\' alone, even for leads it scored before', () => {
    const scored = lead({ rank })
    expect(queueFit(scored, RULES_ONLY)).toEqual(scored.fit)
    expect(queueFit(scored, { on: false, searchId: 's1' })).toEqual(scored.fit)
    expect(rankOf({ lead: scored }, () => undefined, now)).toEqual(rankOf({ lead: lead() }, () => undefined, now))
  })

  test('with the agent, its score counts 60% next to the rules\' 40%, reasons first', () => {
    const fit = queueFit(lead({ rank }), { on: true, searchId: 's1' })!
    expect(fit.score).toBeCloseTo((1 - AGENT_RANK_WEIGHT) * 0.5 + AGENT_RANK_WEIGHT * 1)
    expect(fit.reasons[0]).toBe('Asks for SQL, which they use.')
    const counts = { on: true, searchId: 's1' }
    expect(rankOf({ lead: lead({ rank }) }, () => undefined, now, counts).priority)
      .toBeGreaterThan(rankOf({ lead: lead() }, () => undefined, now, counts).priority)
  })

  test('a new lead waits for its score a few minutes at most', () => {
    const t = now.getTime()
    expect(waitingForRank(lead(), { searchId: 's1', now: t + 1000 })).toBe(true)
    expect(waitingForRank(lead(), { searchId: 's1', now: t + RANK_WAIT_MS + 1 })).toBe(false)
    expect(waitingForRank(lead({ rank }), { searchId: 's1', now: t + 1000 })).toBe(false)
    expect(waitingForRank(lead(), { searchId: null, now: t + 1000 })).toBe(false)
  })
})
