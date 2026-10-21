// Fill traces: what one autofill did, step by step, so a bad fill can be
// traced to the rule or model call behind it (docs/apply-assist.md, "Fill
// traces"). The extension records one per page it fills
// (apps/extension/lib/fill/trace.js) and keeps the last few; a Cloud account's
// go to the server too. Each has a short ref the popup shows; `landed
// fill-trace <ref>` on the user's paired computer prints it.
//
// Sensitive questions (EEO, date of birth, ID numbers, salary, consent) and
// passwords never carry a value, only whether they were filled. Plain TS.

/** Crockford base32 (no I, L, O, U): easy to read out and type. The
 *  extension makes them (lib/fill-trace-store.js). */
export const FILL_TRACE_REF = /^[0-9A-HJKMNP-TV-Z]{6}$/
export const MAX_FILL_TRACE_BYTES = 300_000
export const FILL_TRACE_DAYS = 30

export const FIELD_KINDS = ['text', 'select', 'combobox', 'radio', 'checkbox', 'file', 'rich', 'other'] as const
export const MODEL_CALLS = ['match_fields', 'choose_options', 'review_fill'] as const
export const FILL_VIA = ['popup', 'menu', 'assist'] as const
export const OUTCOMES = ['ready', 'blocked', 'submitted', 'error'] as const

export type TraceField = {
  id: string
  kind: typeof FIELD_KINDS[number]
  question: string
  status: 'filled' | 'review'
  /** answers, resume, entries, saved, model, page, file; '' when unknown */
  source: string
  /** absent when empty or hidden */
  value?: string
  /** a sensitive question: only whether it was filled */
  hidden?: true
  /** the review's reason, when it changed or flagged this field */
  note?: string
  /** why it was left for the user */
  reason?: string
}

export type TraceModelCall = {
  kind: typeof MODEL_CALLS[number]
  asked: number
  answered: number
  model: string | null
  error: string | null
  ms: number
}

export type TraceBlocker = { kind: string; message: string }

/** One frame's fill (the page itself, or a form in an iframe). */
export type FrameTrace = {
  url: string
  top: boolean
  ms: number
  fields_on_page: number
  phases: { name: string; ms: number; filled: number }[]
  fields: TraceField[]
  models: TraceModelCall[]
  unanswered: string[]
  blocker: TraceBlocker | null
}

export type AgentReview = { checked: number; fixed: number; flagged: number; left_out: number; model: string | null; error: string | null }

export type FillTrace = {
  v: 1
  ref: string
  at: string
  via: typeof FILL_VIA[number]
  page: { url: string; title: string }
  resume: { id: string | null; name: string | null }
  extension: string
  result: { filled: number; review: number; fields: number; missing_files: string[]; unanswered: number; blocker: TraceBlocker | null; agent_review: AgentReview | null }
  /** what happened after the fill (Landed-opened tabs) */
  outcome: { status: typeof OUTCOMES[number]; blocker: TraceBlocker | null; at: string } | null
  frames: FrameTrace[]
}

/** A ref as typed: any case, O for 0 and I/L for 1 (Crockford). */
export function normalizeFillTraceRef(raw: unknown): string | null {
  const ref = String(raw ?? '').trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  return FILL_TRACE_REF.test(ref) ? ref : null
}

// ─── validation: rebuild from known keys, clamp everything ────────────────

type Row = Record<string, unknown>
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {})
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const optStr = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : [])
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? v as T : fallback)
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : new Date(0).toISOString())

function blocker(v: unknown): TraceBlocker | null {
  const b = obj(v)
  return typeof b.kind === 'string' && b.kind ? { kind: b.kind.slice(0, 20), message: str(b.message, 300) } : null
}

function field(v: unknown): TraceField | null {
  const f = obj(v)
  const question = str(f.question, 200)
  if (!question) return null
  const out: TraceField = {
    id: str(f.id, 40),
    kind: oneOf(f.kind, FIELD_KINDS, 'other'),
    question,
    status: f.status === 'filled' ? 'filled' : 'review',
    source: str(f.source, 20),
  }
  if (f.hidden === true) out.hidden = true
  else if (typeof f.value === 'string' && f.value) out.value = f.value.slice(0, 200)
  if (typeof f.note === 'string' && f.note) out.note = f.note.slice(0, 300)
  if (typeof f.reason === 'string' && f.reason) out.reason = f.reason.slice(0, 120)
  return out
}

function agentReview(v: unknown): AgentReview | null {
  if (!v || typeof v !== 'object') return null
  const r = obj(v)
  return { checked: num(r.checked), fixed: num(r.fixed), flagged: num(r.flagged), left_out: num(r.left_out), model: optStr(r.model, 80), error: optStr(r.error, 300) }
}

function frame(v: unknown): FrameTrace {
  const f = obj(v)
  return {
    url: str(f.url, 500),
    top: f.top === true,
    ms: num(f.ms),
    fields_on_page: num(f.fields_on_page),
    phases: list(f.phases, 30).map((p) => ({ name: str(obj(p).name, 40), ms: num(obj(p).ms), filled: num(obj(p).filled) })),
    fields: list(f.fields, 300).map(field).filter((x): x is TraceField => x !== null),
    models: list(f.models, 10).map((m) => {
      const c = obj(m)
      return { kind: oneOf(c.kind, MODEL_CALLS, 'match_fields'), asked: num(c.asked), answered: num(c.answered), model: optStr(c.model, 80), error: optStr(c.error, 300), ms: num(c.ms) }
    }),
    unanswered: list(f.unanswered, 50).map((q) => str(q, 200)).filter(Boolean),
    blocker: blocker(f.blocker),
  }
}

/** A trace as stored: known keys only, every string clamped, at most
 *  MAX_FILL_TRACE_BYTES. Null when it isn't one. */
export function parseFillTrace(raw: unknown): FillTrace | null {
  const t = obj(raw)
  const ref = normalizeFillTraceRef(t.ref)
  if (!ref) return null
  const r = obj(t.result)
  const page = obj(t.page)
  const resume = obj(t.resume)
  const outcome = obj(t.outcome)
  const trace: FillTrace = {
    v: 1,
    ref,
    at: iso(t.at),
    via: oneOf(t.via, FILL_VIA, 'popup'),
    page: { url: str(page.url, 500), title: str(page.title, 200) },
    resume: { id: optStr(resume.id, 64), name: optStr(resume.name, 120) },
    extension: str(t.extension, 20),
    result: {
      filled: num(r.filled), review: num(r.review), fields: num(r.fields),
      missing_files: list(r.missing_files, 4).map((k) => str(k, 20)).filter(Boolean),
      unanswered: num(r.unanswered), blocker: blocker(r.blocker), agent_review: agentReview(r.agent_review),
    },
    outcome: t.outcome && typeof t.outcome === 'object'
      ? { status: oneOf(outcome.status, OUTCOMES, 'ready'), blocker: blocker(outcome.blocker), at: iso(outcome.at) }
      : null,
    frames: list(t.frames, 10).map(frame),
  }
  return JSON.stringify(trace).length <= MAX_FILL_TRACE_BYTES ? trace : null
}

// ─── reading one ───────────────────────────────────────────────────────────

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const MARK: Record<TraceField['status'], string> = { filled: '✓', review: '?' }

function fieldLine(f: TraceField): string {
  const value = f.hidden ? '(hidden: sensitive)' : f.value ? JSON.stringify(f.value) : '(empty)'
  const parts = [`${f.note ? '!' : MARK[f.status]} ${f.question} [${f.kind}${f.id ? ` #${f.id}` : ''}]`, value]
  if (f.source) parts.push(`from ${f.source}`)
  if (f.reason) parts.push(`left for you: ${f.reason}`)
  if (f.note) parts.push(`review: ${f.note}`)
  return `    ${parts.join(' — ')}`
}

/** The trace as text: what the page was, what each phase and model call did,
 *  and every field with its value's source or why it was left. */
export function formatFillTrace(t: FillTrace): string {
  const r = t.result
  const review = r.agent_review
  const lines = [
    `Fill ${t.ref} · ${t.at} · via ${t.via} · extension ${t.extension || '?'}`,
    `Page: ${t.page.title || '(no title)'} — ${t.page.url}`,
    `Resume: ${t.resume.name ?? '(unnamed)'}${t.resume.id ? ` (${t.resume.id})` : ''}`,
    `Result: ${r.filled} filled · ${r.review} need review · ${r.fields} fields on the page${r.unanswered ? ` · ${r.unanswered} questions to ask` : ''}${r.missing_files.length ? ` · no saved file: ${r.missing_files.join(', ')}` : ''}`,
  ]
  if (review) {
    lines.push(review.error
      ? `Review: didn't run (${review.error})`
      : `Review${review.model ? ` by ${review.model}` : ''}: ${review.checked} checked · ${review.fixed} changed · ${review.flagged} flagged · ${review.left_out} sensitive not sent`)
  }
  if (r.blocker) lines.push(`Stopped: ${r.blocker.kind} — ${r.blocker.message}`)
  if (t.outcome) lines.push(`Outcome: ${t.outcome.status}${t.outcome.blocker ? ` — ${t.outcome.blocker.kind}: ${t.outcome.blocker.message}` : ''} (${t.outcome.at})`)
  t.frames.forEach((f, i) => {
    lines.push('', `Frame ${i + 1}${f.top ? ' (page)' : ' (iframe)'} · ${secs(f.ms)} · ${f.fields_on_page} fields · ${f.url}`)
    if (f.blocker) lines.push(`  Stopped before filling: ${f.blocker.kind} — ${f.blocker.message}`)
    if (f.phases.length) lines.push(`  Phases: ${f.phases.map((p) => `${p.name} ${secs(p.ms)}${p.filled ? ` +${p.filled}` : ''}`).join(' · ')}`)
    for (const m of f.models) {
      lines.push(`  Model ${m.kind}: asked ${m.asked}, answered ${m.answered}${m.model ? ` · ${m.model}` : ''} · ${secs(m.ms)}${m.error ? ` · error: ${m.error}` : ''}`)
    }
    if (f.fields.length) lines.push('  Fields:', ...f.fields.map(fieldLine))
    if (f.unanswered.length) lines.push(`  To ask you: ${f.unanswered.join(' · ')}`)
  })
  return lines.join('\n')
}
