import { describe, expect, test } from 'vitest'
import { applyToContext, processObservation, type Context, type Effect, type Observation } from '../src'

const NOW = '2026-10-10T12:00:00.000Z'
let seq = 0
const opts = { now: NOW, newId: () => `id-${++seq}` }

function ctx(over: Partial<Context> = {}): Context {
  return {
    leads: [], applications: [], companies: [], suggestions: [],
    settings: { autoAddApplications: false }, ...over,
  }
}

let obsSeq = 0
function job(payload: Record<string, unknown>, over: Partial<Observation> = {}): Observation {
  return {
    id: `obs-${++obsSeq}`, connection_id: 'conn-muse', provider: 'meta_muse',
    observation_type: 'job_discovered', observed_at: '2026-10-09T12:00:00Z',
    payload_json: { payload }, ...over,
  }
}
function status(payload: Record<string, unknown>, over: Partial<Observation> = {}): Observation {
  return job(payload, { observation_type: 'application_status', ...over })
}
const gmail = (id: string, subject = 'Your application') => ({ source: 'gmail', message_id: id, sender_domain: 'greenhouse-mail.io', subject })

const companies = [
  { id: 'co-acme', name: 'Acme, Inc.' },
  { id: 'co-ramp', name: 'Ramp' },
]
const app = (id: string, company_id: string, role: string, stage: string, url: string | null = null) =>
  ({ id, company_id, role, stage, location: null, portal_application_url: url })

/** Run a batch the way the runner does, threading context through. */
function run(observations: Observation[], start: Context) {
  let c = start
  const all: Effect[] = []
  const outcomes = observations.map((o) => {
    const out = processObservation(o, c, opts)
    c = applyToContext(c, out.effects)
    all.push(...out.effects)
    return out
  })
  return { ctx: c, effects: all, outcomes }
}

describe('job_discovered → leads', () => {
  test('dedupes by ATS key across agents and URL variants', () => {
    const { ctx: c, outcomes } = run([
      job({ title: 'Senior PM', company: 'Acme', job_url: 'https://boards.greenhouse.io/acme/jobs/111?gh_src=muse' }),
      job({ title: 'Sr. Product Manager', company: 'Acme Inc', job_url: 'https://www.acme.com/careers?gh_jid=111' }, { connection_id: 'conn-claude', provider: 'claude' }),
    ], ctx())
    // same Greenhouse job id via the board and via the company careers page
    expect(c.leads).toHaveLength(1)
    expect(c.leads[0].ats_key).toBe('greenhouse:111')
    expect(c.leads[0].sources.map((s) => s.provider)).toEqual(['meta_muse', 'claude'])
    expect(outcomes[1].result).toMatchObject({ merged: true })
  })

  test('fuzzy match respects location and the 60-day window', () => {
    const base = ctx()
    const sf = run([job({ title: 'Software Engineer', company: 'Example', location: 'San Francisco, CA' })], base).ctx
    expect(run([job({ title: 'SWE', company: 'Example Inc.', location: 'San Francisco' })], sf).ctx.leads).toHaveLength(1)
    expect(run([job({ title: 'SWE', company: 'Example', location: 'New York, NY' })], sf).ctx.leads).toHaveLength(2)
    expect(run([job({ title: 'SWE', company: 'Example', location: 'Remote' })], sf).ctx.leads).toHaveLength(1)
    const old = { ...sf, leads: sf.leads.map((l) => ({ ...l, last_seen_at: '2026-07-01T00:00:00Z' })) }
    expect(run([job({ title: 'SWE', company: 'Example', location: 'San Francisco' })], old).ctx.leads).toHaveLength(2)
  })

  test('different ATS ids are different postings even with the same title', () => {
    expect(run([
      job({ title: 'PM', company: 'Acme', job_url: 'https://boards.greenhouse.io/acme/jobs/1' }),
      job({ title: 'PM', company: 'Acme', job_url: 'https://boards.greenhouse.io/acme/jobs/2' }),
    ], ctx()).ctx.leads).toHaveLength(2)
  })

  test('different seniority is a different job', () => {
    expect(run([
      job({ title: 'Product Manager', company: 'Acme' }),
      job({ title: 'Senior Product Manager', company: 'Acme' }),
    ], ctx()).ctx.leads).toHaveLength(2)
  })

  test('a job already in the pipeline is linked, not listed as new', () => {
    const c = ctx({ companies, applications: [app('app-1', 'co-acme', 'Product Manager', 'applied', 'https://boards.greenhouse.io/acme/jobs/222')] })
    const byUrl = run([job({ title: 'PM', company: 'Acme', job_url: 'https://boards.greenhouse.io/acme/jobs/222' })], c).ctx.leads[0]
    expect(byUrl).toMatchObject({ status: 'already_applied', application_id: 'app-1' })
    const byTitle = run([job({ title: 'Product Manager', company: 'ACME Inc.' })], c).ctx.leads[0]
    expect(byTitle.status).toBe('already_applied')
  })

  test('merging fills gaps, never overwrites, and keeps dismissed leads dismissed', () => {
    const first = run([job({ title: 'PM', company: 'Acme' })], ctx()).ctx
    const dismissed = { ...first, leads: first.leads.map((l) => ({ ...l, status: 'dismissed' as const, title: 'User-edited title' })) }
    const after = run([job({ title: 'PM', company: 'Acme', job_url: 'https://acme.com/jobs/9', location: 'Remote' })], dismissed).ctx.leads[0]
    expect(after).toMatchObject({ status: 'dismissed', title: 'User-edited title', job_url: 'https://acme.com/jobs/9', location: 'Remote' })
  })

  test('re-processing the same observation is a no-op', () => {
    const o = job({ title: 'PM', company: 'Acme' })
    const once = run([o], ctx()).ctx
    expect(processObservation(o, once, opts).effects).toEqual([])
  })

  test('rejects payloads without company/title', () => {
    expect(processObservation(job({ title: 'PM' }), ctx(), opts).status).toBe('rejected')
  })
})

describe('application_status → suggestions', () => {
  const pipeline = ctx({
    companies,
    applications: [
      app('acme-pm', 'co-acme', 'Product Manager', 'applied'),
      app('acme-swe', 'co-acme', 'Software Engineer', 'saved'),
      app('ramp-ops', 'co-ramp', 'Operations Lead', 'saved'),
    ],
  })

  test('confident "applied" email for a unique match auto-applies (and is undoable)', () => {
    const out = processObservation(status({ status: 'applied', company: 'Ramp', confidence: 0.95, evidence: gmail('m1') }), pipeline, opts)
    expect(out.status).toBe('processed')
    const setStage = out.effects.find((e) => e.type === 'set_stage')
    expect(setStage).toMatchObject({ application_id: 'ramp-ops', from: 'saved', to: 'applied' })
    const s = out.effects.find((e) => e.type === 'save_suggestion')
    expect(s).toMatchObject({ suggestion: { state: 'auto_applied', previous_stage: 'saved', kind: 'stage_change' } })
  })

  test('low confidence or missing evidence goes to review instead', () => {
    for (const payload of [
      { status: 'applied', company: 'Ramp', confidence: 0.6, evidence: gmail('m2') },
      { status: 'applied', company: 'Ramp', confidence: 0.99 },
    ]) {
      const out = processObservation(status(payload), pipeline, opts)
      expect(out.status).toBe('needs-review')
      expect(out.effects.some((e) => e.type === 'set_stage')).toBe(false)
    }
  })

  test('interview, rejection and offer always need a human', () => {
    for (const [s, stage] of [['interview', 'phone'], ['rejected', 'rejected'], ['offer', 'offer']] as const) {
      const out = processObservation(status({ status: s, company: 'Ramp', confidence: 0.99, evidence: gmail(`m-${s}`) }), pipeline, opts)
      expect(out.status).toBe('needs-review')
      expect(out.effects).toEqual([expect.objectContaining({ type: 'save_suggestion', suggestion: expect.objectContaining({ kind: 'stage_change', proposed_stage: stage, state: 'pending' }) })])
    }
  })

  test('interview maps to the next interview stage', () => {
    const atPhone = ctx({ companies, applications: [app('a', 'co-ramp', 'Ops', 'phone')] })
    const out = processObservation(status({ status: 'interview', company: 'Ramp' }), atPhone, opts)
    expect(out.effects[0]).toMatchObject({ suggestion: { proposed_stage: 'onsite' } })
  })

  test('never moves backwards; a late confirmation is a no-op', () => {
    const atOnsite = ctx({ companies, applications: [app('a', 'co-ramp', 'Ops', 'onsite')] })
    const out = processObservation(status({ status: 'applied', company: 'Ramp', confidence: 0.99, evidence: gmail('late') }), atOnsite, opts)
    expect(out).toMatchObject({ status: 'processed', effects: [], result: { no_change: 'backward' } })
  })

  test('re-opening a closed application is a suggestion, never automatic', () => {
    const closed = ctx({ companies, applications: [app('a', 'co-ramp', 'Ops', 'rejected')] })
    const out = processObservation(status({ status: 'applied', company: 'Ramp', confidence: 0.99, evidence: gmail('reopen') }), closed, opts)
    expect(out.status).toBe('needs-review')
  })

  test('recruiter replies become notes', () => {
    const out = processObservation(status({ status: 'recruiter_response', company: 'Ramp', evidence: gmail('r1') }), pipeline, opts)
    expect(out.effects[0]).toMatchObject({ suggestion: { kind: 'note', application_id: 'ramp-ops' } })
  })

  test('several applications at one company: pick by role, ask when unsure', () => {
    const byRole = processObservation(status({ status: 'interview', company: 'Acme Inc', role: 'Sr. Software Engineer' }), pipeline, opts)
    // "senior software engineer" vs "software engineer" = 2/3, vs "product manager" = 0 → clear winner
    expect(byRole.effects[0]).toMatchObject({ suggestion: { kind: 'stage_change', application_id: 'acme-swe' } })
    const noRole = processObservation(status({ status: 'interview', company: 'Acme' }), pipeline, opts)
    expect(noRole.effects[0]).toMatchObject({ suggestion: { kind: 'ambiguous', candidate_ids: ['acme-pm', 'acme-swe'] } })
    const vague = processObservation(status({ status: 'interview', company: 'Acme', role: 'Manager' }), pipeline, opts)
    expect(vague.effects[0]).toMatchObject({ suggestion: { kind: 'ambiguous' } })
  })

  test('job_url pins the application even when titles are vague', () => {
    const c = ctx({ companies, applications: [
      app('a1', 'co-acme', 'Engineer', 'applied', 'https://jobs.lever.co/acme/0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'),
      app('a2', 'co-acme', 'Engineer', 'applied', 'https://jobs.lever.co/acme/11111111-1c2d-4e5f-8a9b-0c1d2e3f4a5b'),
    ] })
    const out = processObservation(status({ status: 'interview', company: 'Acme', job_url: 'https://jobs.lever.co/acme/0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/apply' }), c, opts)
    expect(out.effects[0]).toMatchObject({ suggestion: { application_id: 'a1' } })
  })

  test('unmatched: suggest adding it, or auto-add when the setting is on', () => {
    const email = status({ status: 'applied', company: 'Figma', role: 'Designer', confidence: 0.95, evidence: gmail('new-1') })
    const suggest = processObservation(email, pipeline, opts)
    expect(suggest.status).toBe('needs-review')
    expect(suggest.effects).toEqual([expect.objectContaining({ suggestion: expect.objectContaining({ kind: 'new_application', proposed_stage: 'applied' }) })])

    const auto = processObservation(email, { ...pipeline, settings: { autoAddApplications: true } }, opts)
    expect(auto.status).toBe('processed')
    expect(auto.effects.map((e) => e.type)).toEqual(['save_suggestion', 'create_application'])
    expect(auto.effects[1]).toMatchObject({ application: { company_name: 'Figma', role: 'Designer', stage: 'applied' } })
  })

  test('the same email reported by two agents merges into one suggestion', () => {
    const { ctx: c } = run([
      status({ status: 'interview', company: 'Ramp', evidence: gmail('same') }),
      status({ status: 'interview', company: 'Ramp', evidence: gmail('same'), confidence: 0.8 }, { connection_id: 'conn-claude' }),
    ], pipeline)
    expect(c.suggestions).toHaveLength(1)
    expect(c.suggestions[0].observation_ids).toHaveLength(2)
    expect(c.suggestions[0].confidence).toBe(0.8)
  })

  test('two different readings of one email both show up', () => {
    const { ctx: c } = run([
      status({ status: 'interview', company: 'Ramp', evidence: gmail('mixed') }),
      status({ status: 'rejected', company: 'Ramp', evidence: gmail('mixed') }),
    ], pipeline)
    expect(c.suggestions.map((s) => s.proposed_stage).sort()).toEqual(['phone', 'rejected'])
  })

  test('re-processing a status observation is a no-op', () => {
    const o = status({ status: 'interview', company: 'Ramp', evidence: gmail('again') })
    const once = run([o], pipeline).ctx
    expect(processObservation(o, once, opts).effects).toEqual([])
  })
})

describe('other types', () => {
  test('sync_error has no effects; unknown types are rejected', () => {
    expect(processObservation(job({ message: 'Gmail auth expired' }, { observation_type: 'sync_error' }), ctx(), opts))
      .toMatchObject({ status: 'processed', effects: [] })
    expect(processObservation(job({}, { observation_type: 'vibes' }), ctx(), opts).status).toBe('rejected')
  })
})
