import { describe, expect, test } from 'vitest'
import { applyToContext, matchApplication, processObservation, type Context, type Effect, type Observation } from '../src'

const NOW = '2026-10-10T12:00:00.000Z'
let seq = 0
const opts = { now: NOW, newId: () => `id-${++seq}` }

function ctx(over: Partial<Context> = {}): Context {
  return {
    leads: [], applications: [], companies: [], suggestions: [],
    settings: { autoApply: true }, ...over,
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
const statusObs = status
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

const pipelineApps = [
  app('acme-pm', 'co-acme', 'Product Manager', 'applied'),
  app('acme-swe', 'co-acme', 'Software Engineer', 'saved'),
  app('ramp-ops', 'co-ramp', 'Operations Lead', 'saved'),
]

describe('application_status — automatic mode (default)', () => {
  const pipeline = ctx({ companies, applications: pipelineApps })
  const sure = (id: string) => ({ confidence: 0.9, evidence: gmail(id) })

  test.each([
    ['interview', 'interview'],
    ['assessment', 'oa'],
    ['rejected', 'rejected'],
    ['offer', 'offer'],
    ['applied', 'applied'],
  ] as const)('confident %s email moves the application to %s, undoably', (status, to) => {
    const out = processObservation(statusObs({ status, company: 'Ramp', ...sure(`auto-${status}`) }), pipeline, opts)
    expect(out.status).toBe('processed')
    expect(out.effects).toEqual([
      expect.objectContaining({ type: 'save_suggestion', suggestion: expect.objectContaining({ state: 'auto_applied', previous_stage: 'saved', proposed_stage: to }) }),
      { type: 'set_stage', application_id: 'ramp-ops', from: 'saved', to },
    ])
  })

  test('not confident, or no email evidence → asks', () => {
    for (const payload of [
      { status: 'interview', company: 'Ramp', confidence: 0.5, evidence: gmail('low') },
      { status: 'interview', company: 'Ramp', confidence: 0.99 },
      { status: 'interview', company: 'Ramp', evidence: gmail('no-confidence') },
    ]) {
      const out = processObservation(statusObs(payload), pipeline, opts)
      expect(out.status).toBe('needs-review')
      expect(out.effects.map((e) => e.type)).toEqual(['save_suggestion'])
    }
  })

  test('recruiter replies go straight to the activity log', () => {
    const out = processObservation(statusObs({ status: 'recruiter_response', company: 'Ramp', evidence: gmail('rr') }), pipeline, opts)
    expect(out.status).toBe('processed')
    expect(out.effects[0]).toMatchObject({ suggestion: { kind: 'note', state: 'auto_applied' } })
  })

  test('confident email for an untracked application adds it at the right stage', () => {
    const out = processObservation(statusObs({ status: 'interview', company: 'Figma', role: 'Designer', ...sure('new-int') }), pipeline, opts)
    expect(out.effects.map((e) => e.type)).toEqual(['save_suggestion', 'create_application'])
    expect(out.effects[1]).toMatchObject({ application: { company_name: 'Figma', stage: 'interview' } })
  })

  test('still asks when it cannot tell which application, or when re-opening a closed one', () => {
    const ambiguous = processObservation(statusObs({ status: 'interview', company: 'Acme', ...sure('amb') }), pipeline, opts)
    expect(ambiguous.effects[0]).toMatchObject({ suggestion: { kind: 'ambiguous', state: 'pending' } })
    const closed = ctx({ companies, applications: [app('a', 'co-ramp', 'Ops', 'rejected')] })
    const reopen = processObservation(statusObs({ status: 'interview', company: 'Ramp', ...sure('reopen-auto') }), closed, opts)
    expect(reopen.status).toBe('needs-review')
  })

  test('never moves backwards', () => {
    const atOnsite = ctx({ companies, applications: [app('a', 'co-ramp', 'Ops', 'interview')] })
    expect(processObservation(statusObs({ status: 'applied', company: 'Ramp', ...sure('late-auto') }), atOnsite, opts).effects).toEqual([])
  })
})

describe('application_status — manual mode (autoApply off)', () => {
  const pipeline = ctx({
    settings: { autoApply: false },
    companies,
    applications: pipelineApps,
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
    for (const [s, stage] of [['interview', 'interview'], ['rejected', 'rejected'], ['offer', 'offer']] as const) {
      const out = processObservation(status({ status: s, company: 'Ramp', confidence: 0.99, evidence: gmail(`m-${s}`) }), pipeline, opts)
      expect(out.status).toBe('needs-review')
      expect(out.effects).toEqual([expect.objectContaining({ type: 'save_suggestion', suggestion: expect.objectContaining({ kind: 'stage_change', proposed_stage: stage, state: 'pending' }) })])
    }
  })

  test('an online assessment moves applied → OA; past OA it is information only', () => {
    const at = (stage: string) => ctx({ settings: { autoApply: false }, companies, applications: [app('a', 'co-ramp', 'Ops', stage)] })
    expect(processObservation(status({ status: 'assessment', company: 'Ramp' }), at('applied'), opts).effects[0]).toMatchObject({ suggestion: { kind: 'stage_change', proposed_stage: 'oa' } })
    expect(processObservation(status({ status: 'assessment', company: 'Ramp' }), at('interview'), opts).effects[0]).toMatchObject({ suggestion: { kind: 'note' } })
  })

  test('another interview while interviewing is a new round, not a new stage', () => {
    const at = (stage: string) => ctx({ settings: { autoApply: false }, companies, applications: [app('a', 'co-ramp', 'Ops', stage)] })
    expect(processObservation(status({ status: 'interview', company: 'Ramp' }), at('oa'), opts).effects[0]).toMatchObject({ suggestion: { proposed_stage: 'interview' } })
    expect(processObservation(status({ status: 'interview', company: 'Ramp' }), at('interview'), opts).effects[0]).toMatchObject({ suggestion: { kind: 'note' } })
    // rows from before the single interview stage still count as interviewing
    expect(processObservation(status({ status: 'interview', company: 'Ramp' }), at('onsite'), opts).effects[0]).toMatchObject({ suggestion: { kind: 'note' } })
  })

  test('never moves backwards; a late confirmation is a no-op', () => {
    const atOnsite = ctx({ settings: { autoApply: false }, companies, applications: [app('a', 'co-ramp', 'Ops', 'interview')] })
    const out = processObservation(status({ status: 'applied', company: 'Ramp', confidence: 0.99, evidence: gmail('late') }), atOnsite, opts)
    expect(out).toMatchObject({ status: 'processed', effects: [], result: { no_change: 'backward' } })
  })

  test('re-opening a closed application is a suggestion, never automatic', () => {
    const closed = ctx({ settings: { autoApply: false }, companies, applications: [app('a', 'co-ramp', 'Ops', 'rejected')] })
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
    const c = ctx({ settings: { autoApply: false }, companies, applications: [
      app('a1', 'co-acme', 'Engineer', 'applied', 'https://jobs.lever.co/acme/0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'),
      app('a2', 'co-acme', 'Engineer', 'applied', 'https://jobs.lever.co/acme/11111111-1c2d-4e5f-8a9b-0c1d2e3f4a5b'),
    ] })
    const out = processObservation(status({ status: 'interview', company: 'Acme', job_url: 'https://jobs.lever.co/acme/0b6f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/apply' }), c, opts)
    expect(out.effects[0]).toMatchObject({ suggestion: { application_id: 'a1' } })
  })

  test('unmatched: suggest adding it (automatic mode adds it)', () => {
    const email = status({ status: 'applied', company: 'Figma', role: 'Designer', confidence: 0.95, evidence: gmail('new-1') })
    const suggest = processObservation(email, pipeline, opts)
    expect(suggest.status).toBe('needs-review')
    expect(suggest.effects).toEqual([expect.objectContaining({ suggestion: expect.objectContaining({ kind: 'new_application', proposed_stage: 'applied' }) })])

    const auto = processObservation(email, { ...pipeline, settings: { autoApply: true } }, opts)
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
    expect(c.suggestions.map((s) => s.proposed_stage).sort()).toEqual(['interview', 'rejected'])
  })

  test('re-processing a status observation is a no-op', () => {
    const o = status({ status: 'interview', company: 'Ramp', evidence: gmail('again') })
    const once = run([o], pipeline).ctx
    expect(processObservation(o, once, opts).effects).toEqual([])
  })
})

describe('deadlines and interview times', () => {
  test('a lead keeps the apply-by date (normalized); a later report fills it in', () => {
    const { ctx: c } = run([
      job({ title: 'APM', company: 'Figma', job_url: 'https://job-boards.greenhouse.io/figma/jobs/6180116004' }),
      job({ title: 'APM', company: 'Figma', job_url: 'https://job-boards.greenhouse.io/figma/jobs/6180116004', deadline: 'Oct 21, 2026 5pm PT' }),
      job({ title: 'PM', company: 'Ramp', deadline: 'whenever' }),
    ], ctx())
    expect(c.leads.find((l) => l.company_name === 'Figma')!.deadline).toBe('2026-10-21')
    expect(c.leads.find((l) => l.company_name === 'Ramp')!.deadline).toBeNull()
  })

  test('an interview email with a time adds a round (once); while interviewing, the next round', () => {
    const at = '2026-10-20T21:00:00Z'
    const sure = (id: string, extra: Record<string, unknown> = {}) => ({ status: 'interview', company: 'Ramp', confidence: 0.95, evidence: gmail(id), interview_at: at, ...extra })
    const applied = ctx({ companies, applications: [app('r', 'co-ramp', 'Ops', 'applied')] })
    const first = processObservation(status(sure('i1', { interview_format: 'remote' })), applied, opts)
    expect(first.effects.map((e) => e.type)).toEqual(['save_suggestion', 'set_stage', 'set_interviews'])
    expect(first.effects[2]).toMatchObject({ interviews: [{ round: 1, format: 'remote', at: '2026-10-20T21:00:00.000Z' }] })

    const interviewing = applyToContext(applied, first.effects)
    // a second email about the same slot (e.g. a reminder) adds nothing
    expect(processObservation(status(sure('i2')), interviewing, opts).effects.map((e) => e.type)).toEqual(['save_suggestion'])
    const next = processObservation(status(sure('i3', { interview_at: '2026-10-27T17:00:00Z', interview_format: 'onsite' })), interviewing, opts)
    expect(next.effects[1]).toMatchObject({ type: 'set_interviews', interviews: [{ round: 1 }, { round: 2, format: 'onsite' }] })

    const manual = ctx({ settings: { autoApply: false }, companies, applications: [app('r', 'co-ramp', 'Ops', 'interview')] })
    expect(processObservation(status(sure('i4')), manual, opts).effects.map((e) => e.type)).toEqual(['save_suggestion'])
  })
})

describe('other types', () => {
  test('sync_error has no effects; unknown types are rejected', () => {
    expect(processObservation(job({ message: 'Gmail auth expired' }, { observation_type: 'sync_error' }), ctx(), opts))
      .toMatchObject({ status: 'processed', effects: [] })
    expect(processObservation(job({}, { observation_type: 'vibes' }), ctx(), opts).status).toBe('rejected')
  })
})

describe('Chinese company names', () => {
  test("an email from one company never matches another company's application", () => {
    const ctx = {
      leads: [], suggestions: [], settings: { autoApply: true },
      companies: [{ id: 'c-tx', name: '腾讯' }, { id: 'c-mt', name: '美团' }, { id: 'c-ant', name: '蚂蚁集团' }],
      applications: [
        { id: 'a-mt', company_id: 'c-mt', role: 'AI产品经理岗', stage: 'oa', location: null, portal_application_url: null },
        { id: 'a-ant', company_id: 'c-ant', role: 'AI产品工程师', stage: 'applied', location: null, portal_application_url: null },
      ],
    }
    expect(matchApplication(ctx, '腾讯', 'AI产品经理', null)).toEqual({ kind: 'unmatched' })
    expect(matchApplication(ctx, '美团', 'AI产品经理', null)).toMatchObject({ kind: 'matched', app: { id: 'a-mt' } })
    expect(matchApplication(ctx, '蚂蚁集团', 'AI产品工程师', null)).toMatchObject({ kind: 'matched', app: { id: 'a-ant' } })
  })
})

describe('interview rounds from emails read out of order', () => {
  test('numbered by when they are, not by which email came first', () => {
    const invite = (id: string, at: string) => status({ status: 'interview', company: 'Ramp', confidence: 0.95, evidence: gmail(id), interview_at: at, interview_format: 'remote' })
    // A 30-day re-read reports the newest email first.
    const { ctx: c } = run([
      invite('r3', '2026-10-18T20:00:00Z'), invite('r2', '2026-10-08T20:00:00Z'), invite('r1', '2026-09-28T20:00:00Z'),
    ], ctx({ companies, applications: [app('a-ramp', 'co-ramp', 'Product Manager', 'oa')] }))
    const rounds = c.applications[0].interviews!.map((r) => [r.round, r.at!.slice(0, 10)])
    expect(rounds).toEqual([[1, '2026-09-28'], [2, '2026-10-08'], [3, '2026-10-18']])
  })

  test('rounds the user typed without a time are left alone', () => {
    const typed = { round: 2, format: 'onsite' as const, interviewers: [], at: null, note: 'final' }
    const { ctx: c } = run([
      status({ status: 'interview', company: 'Ramp', confidence: 0.95, evidence: gmail('x1'), interview_at: '2026-10-20T20:00:00Z' }),
    ], ctx({ companies, applications: [{ ...app('a-ramp', 'co-ramp', 'Product Manager', 'interview'), interviews: [typed] }] }))
    expect(c.applications[0].interviews!.map((r) => r.round)).toEqual([2, 3])
  })
})
