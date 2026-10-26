// The duplicates the rules can't call, asked of the user's agent (#146),
// through the real local store.
import 'fake-indexeddb/auto'
import { describe, expect, test, vi } from 'vitest'
import { ingestFoundJobs } from './inbox'
import { createLocalStore } from './store/local'
import type { DbJobLead } from './store/types'
import { batchOf, BATCH_TOKEN_BUDGET, dedupeWithAgent, duplicatesOf, isHiddenDuplicate, splitDuplicate, type AskSameJob, type SameJobPair } from './dedupe'

let n = 0
const fresh = () => createLocalStore(`landed-dedupe-${++n}`)
const now = new Date('2026-10-26T12:00:00Z')

type Job = { company: string; title: string; location?: string; job_url?: string; description?: string }

// Made-up companies and postings.
async function seed(store: ReturnType<typeof fresh>, jobs: Job[]) {
  await ingestFoundJobs(store, jobs.map((j) => ({
    company: j.company, title: j.title, location: j.location ?? null, job_url: j.job_url ?? null,
    posted: null, deadline: null, salary: null, sponsorship: null, why: null,
  })), { run_id: 'r1', runtime_id: 'claude', agent: 'Claude Code' }, { descriptions: jobs.map((j) => j.description ?? null) })
  return store.listJobLeads()
}

const answering = (verdict: (p: SameJobPair) => 'same' | 'different' | 'unsure') => vi.fn<AskSameJob>(async (pairs) => ({
  verdicts: pairs.map((p) => ({ id: p.id, verdict: verdict(p), reason: `${verdict(p)}: ${p.a.title} / ${p.b.title}` })),
  usage: { input_tokens: 2400, output_tokens: 120 }, model: 'Claude Code',
}))

const visible = (leads: DbJobLead[]) => {
  const ids = new Set(leads.map((l) => l.id))
  return leads.filter((l) => !isHiddenDuplicate(l, ids)).map((l) => l.title).sort()
}

const twoCities: Job[] = [{ company: 'Lumen Labs', title: 'Product Analyst', location: 'Austin, TX' }, { company: 'Lumen Labs', title: 'Product Analyst', location: 'Denver, CO' }]

describe('Remove duplicates with your agent', () => {
  test('what the rules decide is never asked; close calls are, with public posting details only', async () => {
    const store = fresh()
    await seed(store, [
      { company: 'Northwind Robotics', title: 'Data Analyst, New Grad', location: 'Seattle, WA', job_url: 'https://boards.greenhouse.io/northwind/jobs/101', description: 'SQL and dashboards.' },
      { company: 'Northwind Robotics', title: 'New Grad Data Analyst 2027', location: 'Seattle' },
      // the same title and place: the rules merge it, nothing to ask
      { company: 'Fabrikam', title: 'Business Analyst', location: 'Austin, TX' },
      { company: 'Fabrikam', title: 'Business Analyst', location: 'Austin, TX' },
      // not close: the rules keep them apart, nothing to ask
      { company: 'Contoso', title: 'Software Engineer Intern' },
      { company: 'Contoso', title: 'Software Engineer, New Grad' },
    ])
    const ask = answering(() => 'same')
    const batch = await dedupeWithAgent(store, ask, now)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toEqual([{
      id: 'p1',
      a: { title: 'Data Analyst, New Grad', company: 'Northwind Robotics', location: 'Seattle, WA', url: 'https://boards.greenhouse.io/northwind/jobs/101', description: 'SQL and dashboards.' },
      b: { title: 'New Grad Data Analyst 2027', company: 'Northwind Robotics', location: 'Seattle', url: '', description: '' },
    }])
    expect(batch).toEqual({ at: now.toISOString(), asked: 1, same: 1, different: 0, unsure: 0, input_tokens: 2400, output_tokens: 120, model: 'Claude Code' })

    // "same": the one with less to go on is hidden under the other, never deleted
    const leads = await store.listJobLeads()
    expect(leads).toHaveLength(5)
    expect(visible(leads)).toEqual(['Business Analyst', 'Data Analyst, New Grad', 'Software Engineer Intern', 'Software Engineer, New Grad'])
    const hidden = leads.find((l) => l.title === 'New Grad Data Analyst 2027')!
    const kept = leads.find((l) => l.title === 'Data Analyst, New Grad')!
    expect(hidden.dedupe).toMatchObject({ same_as: kept.id, checked: [kept.id], by: 'Claude Code', reason: 'same: Data Analyst, New Grad / New Grad Data Analyst 2027' })
    expect(kept.dedupe).toMatchObject({ same_as: null, checked: [hidden.id] })
    expect(duplicatesOf(leads).get(kept.id)?.map((l) => l.id)).toEqual([hidden.id])

    // asked once: nothing left to ask
    expect(await dedupeWithAgent(store, ask, now)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  test('unsure or different keeps both, and the pair is not asked again', async () => {
    for (const verdict of ['unsure', 'different'] as const) {
      const store = fresh()
      await seed(store, twoCities)
      const ask = answering(() => verdict)
      expect(await dedupeWithAgent(store, ask, now)).toMatchObject({ asked: 1, [verdict]: 1, same: 0 })
      const leads = await store.listJobLeads()
      expect(visible(leads)).toEqual(['Product Analyst', 'Product Analyst'])
      expect(leads.every((l) => l.dedupe?.same_as === null && l.dedupe.checked.length === 1)).toBe(true)
      expect(await dedupeWithAgent(store, ask, now)).toBeNull()
    }
  })

  test('an answer missing for a pair counts as unsure', async () => {
    const store = fresh()
    await seed(store, twoCities)
    const batch = await dedupeWithAgent(store, async () => ({ verdicts: [], usage: { input_tokens: 10, output_tokens: 2 }, model: 'Claude Code' }), now)
    expect(batch).toMatchObject({ asked: 1, unsure: 1 })
    expect(visible(await store.listJobLeads())).toHaveLength(2)
  })

  test('Split brings the lead back, and the pair stays answered', async () => {
    const store = fresh()
    await seed(store, twoCities)
    const ask = answering(() => 'same')
    await dedupeWithAgent(store, ask, now)
    const hidden = (await store.listJobLeads()).find((l) => l.dedupe?.same_as)!
    expect(visible(await store.listJobLeads())).toHaveLength(1)
    await splitDuplicate(store, hidden)
    const leads = await store.listJobLeads()
    expect(visible(leads)).toEqual(['Product Analyst', 'Product Analyst'])
    expect(leads.find((l) => l.id === hidden.id)!.dedupe?.checked).toHaveLength(1)
    expect(await dedupeWithAgent(store, ask, now)).toBeNull()
  })

  test('nothing is hidden under a lead that is itself hidden; a batch keeps to its budget; each batch is logged', async () => {
    const store = fresh()
    await seed(store, [
      { company: 'Lumen Labs', title: 'Product Analyst', location: 'Austin, TX', description: 'x'.repeat(500) },
      { company: 'Lumen Labs', title: 'Product Analyst', location: 'Denver, CO', description: 'y'.repeat(500) },
      { company: 'Lumen Labs', title: 'Product Analyst', location: 'Boston, MA', description: 'z'.repeat(500) },
    ])
    const batch = await dedupeWithAgent(store, answering(() => 'same'), now)
    expect(batch?.asked).toBe(3)
    const leads = await store.listJobLeads()
    const shown = new Set(leads.filter((l) => !l.dedupe?.same_as).map((l) => l.id))
    for (const l of leads.filter((x) => x.dedupe?.same_as)) expect(shown.has(l.dedupe!.same_as!)).toBe(true)

    const many = fresh()
    await seed(many, Array.from({ length: 8 }, (_, i) => ({ company: 'Lumen Labs', title: 'Product Analyst', location: `City ${i}`, description: 'w'.repeat(3000) })))
    const { request } = batchOf(await many.listJobLeads())
    expect(request.length).toBeGreaterThan(0)
    expect(request.length).toBeLessThan(10)
    expect(Math.ceil(JSON.stringify(request).length / 4)).toBeLessThanOrEqual(BATCH_TOKEN_BUDGET + 50)

    const snap = await store.exportSnapshot()
    expect(snap.ai_runs).toHaveLength(1)
    expect(snap.ai_runs[0]).toMatchObject({ task: 'same_job', provider: 'claude', parse_format: 'json', parsed_json: { asked: 3, input_tokens: 2400, output_tokens: 120 } })
  })

  test('an agent that can\'t be asked changes nothing', async () => {
    const store = fresh()
    await seed(store, twoCities)
    await expect(dedupeWithAgent(store, async () => { throw new Error('Landed for Mac is not installed') }, now)).rejects.toThrow(/not installed/)
    expect((await store.listJobLeads()).every((l) => l.dedupe === null)).toBe(true)
  })
})
