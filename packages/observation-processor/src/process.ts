// The processor: one observation in, a list of effects out. Pure — the caller
// supplies the current context, the clock and an id generator, and applies
// the effects to whichever store the account uses. Re-processing the same
// observation against a context that already contains its effects yields no
// new effects (idempotent). Rules: docs/observation-processor.md.
import { atsJobKey, canonicalUrl, companyKey, locationsCompatible, titleKey, titleSimilarity } from './normalize'
import type {
  ApplicationRef, Context, Effect, EmailStatus, Evidence, JobLead, Observation, Outcome,
  ProcessOptions, Stage, Suggestion,
} from './types'

const FUZZY_WINDOW_DAYS = 60
/** Minimum agent confidence (with email evidence) to change anything without asking. */
const AUTO_APPLY_CONFIDENCE = 0.8
const MATCH_MIN_SIMILARITY = 0.6
const MATCH_MIN_MARGIN = 0.2

const STAGE_ORDER: Record<string, number> = { saved: 0, applied: 1, oa: 2, phone: 3, onsite: 4, offer: 5 }
const TERMINAL = new Set(['offer', 'rejected', 'ghosted'])

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function payloadOf(o: Observation): Record<string, unknown> {
  const p = o.payload_json?.payload
  return p && typeof p === 'object' ? p : {}
}

// ── job_discovered → job lead ─────────────────────────────────────────────

function sameJob(lead: JobLead, keys: { ats: string | null; url: string | null; company: string; title: string; location: string | null }, now: string) {
  if (keys.ats && lead.ats_key) return keys.ats === lead.ats_key
  if (keys.url && lead.canonical_url && keys.url === lead.canonical_url) return true
  const recent = Date.parse(now) - Date.parse(lead.last_seen_at) <= FUZZY_WINDOW_DAYS * 86_400_000
  return recent && keys.company === lead.company_key && keys.title === lead.title_key && locationsCompatible(keys.location, lead.location)
}

function applicationForJob(ctx: Context, keys: { ats: string | null; url: string | null; company: string; title: string }): ApplicationRef | undefined {
  const companyById = new Map(ctx.companies.map((c) => [c.id, companyKey(c.name)]))
  return ctx.applications.find((a) => {
    const appUrl = a.portal_application_url
    if (keys.ats && atsJobKey(appUrl) === keys.ats) return true
    if (keys.url && canonicalUrl(appUrl) === keys.url) return true
    return companyById.get(a.company_id) === keys.company && titleKey(a.role) === keys.title
  })
}

function processJob(o: Observation, ctx: Context, opts: ProcessOptions): Outcome {
  const p = payloadOf(o)
  const company = str(p.company)
  const title = str(p.title)
  if (!company || !title) return { status: 'rejected', result: { reason: 'missing company or title' }, effects: [] }
  const jobUrl = str(p.job_url)
  const location = str(p.location)
  const keys = { ats: atsJobKey(jobUrl), url: canonicalUrl(jobUrl), company: companyKey(company), title: titleKey(title), location }
  const source = { connection_id: o.connection_id, observation_id: o.id, provider: o.provider, seen_at: o.observed_at }

  const existing = ctx.leads.find((l) => sameJob(l, keys, opts.now))
  if (existing) {
    if (existing.sources.some((s) => s.observation_id === o.id)) {
      return { status: 'processed', result: { lead_id: existing.id, merged: true }, effects: [] }
    }
    // Fill gaps, never overwrite; a dismissed lead stays dismissed.
    const lead: JobLead = {
      ...existing,
      job_url: existing.job_url ?? jobUrl,
      canonical_url: existing.canonical_url ?? keys.url,
      ats_key: existing.ats_key ?? keys.ats,
      location: existing.location ?? location,
      description: existing.description ?? str(p.description),
      sources: [...existing.sources, source],
      last_seen_at: o.observed_at > existing.last_seen_at ? o.observed_at : existing.last_seen_at,
      first_seen_at: o.observed_at < existing.first_seen_at ? o.observed_at : existing.first_seen_at,
    }
    return { status: 'processed', result: { lead_id: lead.id, merged: true }, effects: [{ type: 'save_lead', lead }] }
  }

  const app = applicationForJob(ctx, keys)
  const lead: JobLead = {
    id: opts.newId(),
    fingerprint: keys.ats ?? (keys.url ? `url:${keys.url}` : `job:${keys.company}|${keys.title}|${(location ?? '').toLowerCase()}`),
    ats_key: keys.ats,
    canonical_url: keys.url,
    company_key: keys.company,
    title_key: keys.title,
    company_name: company,
    title,
    job_url: jobUrl,
    location,
    description: str(p.description),
    sources: [source],
    status: app ? 'already_applied' : 'new',
    application_id: app?.id ?? null,
    first_seen_at: o.observed_at,
    last_seen_at: o.observed_at,
  }
  return {
    status: 'processed',
    result: { lead_id: lead.id, merged: false, ...(app ? { already_applied: app.id } : {}) },
    effects: [{ type: 'save_lead', lead }],
  }
}

// ── application_status → suggestion / stage change ───────────────────────

type Match =
  | { kind: 'matched'; app: ApplicationRef }
  | { kind: 'ambiguous'; candidates: ApplicationRef[] }
  | { kind: 'unmatched' }

export function matchApplication(ctx: Context, company: string, role: string | null, jobUrl: string | null): Match {
  const key = companyKey(company)
  const companyIds = new Set(ctx.companies.filter((c) => companyKey(c.name) === key).map((c) => c.id))
  const candidates = ctx.applications.filter((a) => companyIds.has(a.company_id))
  if (candidates.length === 0) return { kind: 'unmatched' }

  const ats = atsJobKey(jobUrl)
  const url = canonicalUrl(jobUrl)
  if (ats || url) {
    const byUrl = candidates.filter((a) => (ats && atsJobKey(a.portal_application_url) === ats) || (url && canonicalUrl(a.portal_application_url) === url))
    if (byUrl.length === 1) return { kind: 'matched', app: byUrl[0] }
  }
  if (candidates.length === 1) return { kind: 'matched', app: candidates[0] }
  if (!role) return { kind: 'ambiguous', candidates }

  const ranked = candidates
    .map((app) => ({ app, score: titleSimilarity(role, app.role) }))
    .sort((a, b) => b.score - a.score)
  const [top, second] = ranked
  if (top.score >= MATCH_MIN_SIMILARITY && top.score - (second?.score ?? 0) >= MATCH_MIN_MARGIN) {
    return { kind: 'matched', app: top.app }
  }
  return { kind: 'ambiguous', candidates: ranked.map((r) => r.app) }
}

/** The stage an email implies, given where the application is now. */
export function proposedStage(status: EmailStatus, current: string): Stage | null {
  switch (status) {
    case 'applied': return 'applied'
    case 'interview':
      if (current === 'saved' || current === 'applied' || current === 'oa') return 'phone'
      if (current === 'phone') return 'onsite'
      // An interview for a closed application may be a re-open: propose it
      // (direction() marks it 'reopen', which always asks). At onsite it's
      // just another round — information only.
      if (TERMINAL.has(current)) return 'phone'
      return null
    case 'rejected': return 'rejected'
    case 'offer': return 'offer'
    default: return null
  }
}

type Direction = 'same' | 'forward' | 'backward' | 'reopen'
function direction(current: string, proposed: Stage): Direction {
  if (proposed === current) return 'same'
  if (TERMINAL.has(current)) return 'reopen'
  if (proposed === 'rejected' || proposed === 'ghosted') return 'forward'
  return (STAGE_ORDER[proposed] ?? -1) > (STAGE_ORDER[current] ?? -1) ? 'forward' : 'backward'
}

function evidenceOf(p: Record<string, unknown>): Evidence {
  const ev = p.evidence && typeof p.evidence === 'object' ? (p.evidence as Record<string, unknown>) : {}
  const out: Evidence = {}
  for (const k of ['source', 'message_id', 'thread_id', 'sender_domain', 'subject', 'received_at', 'summary'] as const) {
    const v = str(ev[k])
    if (v) out[k] = v
  }
  return out
}

function processStatus(o: Observation, ctx: Context, opts: ProcessOptions): Outcome {
  const p = payloadOf(o)
  const company = str(p.company)
  const status = str(p.status) as EmailStatus | null
  if (!company || !status) return { status: 'rejected', result: { reason: 'missing company or status' }, effects: [] }
  const role = str(p.role)
  const jobUrl = str(p.job_url)
  const confidence = typeof p.confidence === 'number' ? p.confidence : null
  const evidence = evidenceOf(p)
  const hasEvidence = !!(evidence.message_id || evidence.sender_domain)
  const confident = confidence !== null && confidence >= AUTO_APPLY_CONFIDENCE && hasEvidence

  // One suggestion per (email, reading of it): two agents reporting the same
  // email merge; two agents reading it differently both show up for review.
  const dedupeKey = evidence.message_id ? `msg:${evidence.message_id}:${status}` : `obs:${o.id}`
  const existing = ctx.suggestions.find((s) => s.dedupe_key === dedupeKey)
  if (existing) {
    if (existing.observation_ids.includes(o.id)) {
      return { status: existing.state === 'pending' ? 'needs-review' : 'processed', result: { suggestion_id: existing.id }, effects: [] }
    }
    const merged: Suggestion = {
      ...existing,
      observation_ids: [...existing.observation_ids, o.id],
      confidence: Math.max(existing.confidence ?? 0, confidence ?? 0) || existing.confidence,
    }
    return {
      status: existing.state === 'pending' ? 'needs-review' : 'processed',
      result: { suggestion_id: existing.id, merged: true },
      effects: [{ type: 'save_suggestion', suggestion: merged }],
    }
  }

  const base = {
    id: opts.newId(),
    dedupe_key: dedupeKey,
    company_name: company,
    role,
    status,
    confidence,
    evidence,
    observation_ids: [o.id],
    provider: o.provider ?? null,
    created_at: opts.now,
    previous_stage: null,
    resolved_at: null,
    candidate_ids: [] as string[],
  }

  const match = matchApplication(ctx, company, role, jobUrl)

  if (match.kind === 'ambiguous') {
    const suggestion: Suggestion = {
      ...base, kind: 'ambiguous', state: 'pending', application_id: null,
      candidate_ids: match.candidates.map((a) => a.id), proposed_stage: null,
    }
    return { status: 'needs-review', result: { suggestion_id: suggestion.id, match: 'ambiguous' }, effects: [{ type: 'save_suggestion', suggestion }] }
  }

  if (match.kind === 'unmatched') {
    const stage = proposedStage(status, 'saved') ?? 'applied'
    const auto = ctx.settings.autoApply && confident
    const suggestion: Suggestion = {
      ...base, kind: 'new_application', state: auto ? 'auto_applied' : 'pending',
      application_id: null, proposed_stage: stage, resolved_at: auto ? opts.now : null,
    }
    const effects: Effect[] = [{ type: 'save_suggestion', suggestion }]
    if (auto) {
      effects.push({
        type: 'create_application',
        suggestion_id: suggestion.id,
        application: { company_name: company, role: role ?? 'Unknown role', stage, job_url: jobUrl, location: null },
      })
    }
    return {
      status: auto ? 'processed' : 'needs-review',
      result: { suggestion_id: suggestion.id, match: 'unmatched', auto_added: auto },
      effects,
    }
  }

  const app = match.app
  const stage = proposedStage(status, app.stage)
  if (!stage) {
    // recruiter_response / other, or an interview past onsite: information
    // only. Automatic mode just records it; manual mode asks to acknowledge.
    const auto = ctx.settings.autoApply
    const suggestion: Suggestion = {
      ...base, kind: 'note', state: auto ? 'auto_applied' : 'pending', application_id: app.id,
      proposed_stage: null, resolved_at: auto ? opts.now : null,
    }
    return {
      status: auto ? 'processed' : 'needs-review',
      result: { suggestion_id: suggestion.id, application_id: app.id },
      effects: [{ type: 'save_suggestion', suggestion }],
    }
  }

  const dir = direction(app.stage, stage)
  if (dir === 'same' || dir === 'backward') {
    // e.g. a late "application received" for something already at onsite.
    return { status: 'processed', result: { application_id: app.id, no_change: dir }, effects: [] }
  }

  // Automatic mode applies any confident forward move; manual mode only
  // "application received". Re-opening a closed application always asks.
  const auto = dir === 'forward' && confident && (ctx.settings.autoApply || status === 'applied')
  const suggestion: Suggestion = {
    ...base, kind: 'stage_change', state: auto ? 'auto_applied' : 'pending', application_id: app.id,
    proposed_stage: stage, previous_stage: auto ? (app.stage as Stage) : null, resolved_at: auto ? opts.now : null,
  }
  const effects: Effect[] = [{ type: 'save_suggestion', suggestion }]
  if (auto) effects.push({ type: 'set_stage', application_id: app.id, from: app.stage as Stage, to: stage })
  return {
    status: auto ? 'processed' : 'needs-review',
    result: { suggestion_id: suggestion.id, application_id: app.id, auto_applied: auto },
    effects,
  }
}

// ── entry points ─────────────────────────────────────────────────────────

export function processObservation(o: Observation, ctx: Context, opts: ProcessOptions): Outcome {
  switch (o.observation_type) {
    case 'job_discovered': return processJob(o, ctx, opts)
    case 'application_status': return processStatus(o, ctx, opts)
    // Shown as connection health on the Agents page; nothing to change.
    case 'sync_error': return { status: 'processed', result: { connection_error: true }, effects: [] }
    default: return { status: 'rejected', result: { reason: `unknown observation_type ${o.observation_type}` }, effects: [] }
  }
}

/** Fold effects into the context so the next observation in a batch sees
 *  them. create_application is applied by the runner (it needs the real id). */
export function applyToContext(ctx: Context, effects: Effect[]): Context {
  let { leads, suggestions, applications } = ctx
  for (const e of effects) {
    if (e.type === 'save_lead') leads = [...leads.filter((l) => l.id !== e.lead.id), e.lead]
    if (e.type === 'save_suggestion') suggestions = [...suggestions.filter((s) => s.id !== e.suggestion.id), e.suggestion]
    if (e.type === 'set_stage') applications = applications.map((a) => (a.id === e.application_id ? { ...a, stage: e.to } : a))
  }
  return { ...ctx, leads, suggestions, applications }
}
