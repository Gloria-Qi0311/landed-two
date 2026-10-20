// Answers to the questions application forms ask that aren't on a resume —
// legal and preferred names, address, work authorization, sponsorship, start
// date, location preferences, "how did you hear about us", the voluntary EEO
// questions. The user fills them in once on My Resume (or has their agent
// read a form they already filled, ```landed-answers); the extension uses
// them when it fills a form, radio buttons and dropdowns included
// (apps/extension/lib/choice-answers.js). Saving an answer is the opt-in: a
// blank one is never guessed. One row per account, local-first like the
// rest of the job-hunt data. Plain TS, no dependencies.

export type YesNo = 'yes' | 'no'

/** Questions Landed fills in on its own from the resume and the active
 *  search (apps/web/src/lib/answer-suggestions.ts). Never date of birth,
 *  street address, work authorization, EEO or consent. */
export const PREFILLABLE = [
  'legal_first_name', 'legal_last_name', 'linkedin', 'github', 'website', 'city', 'state', 'country', 'earliest_start',
  'preferred_locations', 'needs_sponsorship',
] as const
export type Prefillable = typeof PREFILLABLE[number]
/** What was filled in on its own, as written, and from where. */
export type Prefilled = { value: string | string[]; from: 'resume' | 'search' }

export type ApplicationAnswers = {
  // names — legal ones go to "First/Last name", preferred ones to "Preferred…"
  legal_first_name: string | null
  legal_middle_name: string | null
  legal_last_name: string | null
  preferred_first_name: string | null
  preferred_last_name: string | null
  /** as forms ask for it: "October 30" or "1999-10-30" */
  date_of_birth: string | null

  // links forms ask for even when the resume has them only as text
  linkedin: string | null
  github: string | null
  website: string | null

  // permanent address
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null

  // eligibility
  /** 18 or older */
  adult: YesNo | null
  work_authorized: YesNo | null
  needs_sponsorship: YesNo | null

  // availability and location
  /** "June 2027", "Immediately", "2 weeks after an offer" */
  earliest_start: string | null
  relocate: YesNo | null
  travel: YesNo | null
  /** fine with working onsite / in the office full time */
  onsite: YesNo | null
  /** up to three, in order: "San Francisco, CA" */
  preferred_locations: string[]
  open_to_other_locations: YesNo | null

  // background
  /** "have you worked here before?" — usually no */
  previously_employed: YesNo | null
  non_compete: YesNo | null
  /** "Company careers website", "LinkedIn", "Referral" */
  heard_from: string | null
  /** join the talent network / get job alerts */
  talent_network: YesNo | null

  // voluntary self-identification; null = "I don't wish to answer"
  gender: string | null
  hispanic_latino: YesNo | null
  race: string | null
  veteran: YesNo | null
  disability: YesNo | null

  /** tick privacy-policy / data-processing consent for me */
  agree_to_terms: boolean

  /** anything else forms keep asking: "Experience in data analytics?" → "Expert…" */
  custom: { question: string; answer: string }[]

  /** questions forms asked that nothing answered yet, waiting for the user
   *  on the Extension page (reported by the extension after a fill) */
  unanswered: PendingQuestion[]
  /** questions the user said not to ask again (questionKey) */
  skipped: string[]
  /** answers Landed filled in on its own: the Extension page marks them
   *  while they're as written, and a question here is never filled in again
   *  (so one the user cleared stays clear) */
  prefilled: Partial<Record<Prefillable, Prefilled>>
}

export const EMPTY_ANSWERS: ApplicationAnswers = {
  legal_first_name: null, legal_middle_name: null, legal_last_name: null, preferred_first_name: null, preferred_last_name: null,
  date_of_birth: null, linkedin: null, github: null, website: null, adult: null, onsite: null, address_line1: null, address_line2: null, city: null, state: null, postal_code: null, country: null,
  work_authorized: null, needs_sponsorship: null, earliest_start: null, relocate: null, travel: null, preferred_locations: [],
  open_to_other_locations: null, previously_employed: null, non_compete: null, heard_from: null, talent_network: null,
  gender: null, hispanic_latino: null, race: null, veteran: null, disability: null, agree_to_terms: false, custom: [],
  unanswered: [], skipped: [], prefilled: {},
}

export const MAX_CUSTOM_ANSWERS = 40
export const MAX_PREFERRED_LOCATIONS = 3

const TEXT_FIELDS = {
  legal_first_name: 80, legal_middle_name: 80, legal_last_name: 80, preferred_first_name: 80, preferred_last_name: 80,
  date_of_birth: 40, address_line1: 200, address_line2: 200, city: 100, state: 100, postal_code: 20, country: 80,
  earliest_start: 80, heard_from: 100, gender: 80, race: 120, linkedin: 300, github: 300, website: 300,
} as const
const YES_NO_FIELDS = [
  'adult', 'onsite', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations', 'previously_employed',
  'non_compete', 'talent_network', 'hispanic_latino', 'veteran', 'disability',
] as const

const text = (v: unknown, max: number) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)
const yesNo = (v: unknown): YesNo | null => (v === 'yes' || v === 'no' ? v : null)

/** Validate stored or submitted answers: known fields only, trimmed text,
 *  yes/no or nothing. Anything else becomes "not answered". */
export function parseApplicationAnswers(raw: unknown): ApplicationAnswers {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: ApplicationAnswers = { ...EMPTY_ANSWERS, preferred_locations: [], custom: [], unanswered: [], skipped: [], prefilled: {} }
  for (const [key, max] of Object.entries(TEXT_FIELDS)) (out as Record<string, unknown>)[key] = text(r[key], max)
  for (const key of YES_NO_FIELDS) out[key] = yesNo(r[key])
  out.agree_to_terms = r.agree_to_terms === true
  out.preferred_locations = (Array.isArray(r.preferred_locations) ? r.preferred_locations : [])
    .map((l) => text(l, 100)).filter((l): l is string => !!l).slice(0, MAX_PREFERRED_LOCATIONS)
  const seen = new Set<string>()
  out.custom = (Array.isArray(r.custom) ? r.custom : []).flatMap((item) => {
    const q = text((item as { question?: unknown })?.question, 300)
    const a = text((item as { answer?: unknown })?.answer, 500)
    if (!q || !a || seen.has(q.toLowerCase())) return []
    seen.add(q.toLowerCase())
    return [{ question: q, answer: a }]
  }).slice(0, MAX_CUSTOM_ANSWERS)
  out.unanswered = (Array.isArray(r.unanswered) ? r.unanswered : []).flatMap((item) => {
    const p = parsePending(item)
    return p ? [p] : []
  }).slice(0, MAX_PENDING)
  out.skipped = [...new Set((Array.isArray(r.skipped) ? r.skipped : []).map((k) => text(k, 300)).filter((k): k is string => !!k))].slice(0, MAX_SKIPPED)
  const pre = (r.prefilled && typeof r.prefilled === 'object' && !Array.isArray(r.prefilled) ? r.prefilled : {}) as Record<string, unknown>
  for (const key of PREFILLABLE) {
    const p = pre[key] as { value?: unknown; from?: unknown } | undefined
    if (!p || (p.from !== 'resume' && p.from !== 'search')) continue
    const value = Array.isArray(p.value)
      ? p.value.map((v) => text(v, 100)).filter((v): v is string => !!v).slice(0, MAX_PREFERRED_LOCATIONS)
      : text(p.value, 300)
    if (value !== null) out.prefilled[key] = { value, from: p.from }
  }
  return out
}

/** `next` on top of `base`: what `next` answers replaces, blanks keep
 *  `base`'s, custom questions merge by question, the consent switch stays
 *  as it was. For an agent's read of a filled form, saved over what the
 *  user already had. */
export function mergeAnswers(base: ApplicationAnswers, next: ApplicationAnswers): ApplicationAnswers {
  const out: ApplicationAnswers = { ...base }
  for (const [key, value] of Object.entries(next) as [keyof ApplicationAnswers, unknown][]) {
    if (['custom', 'preferred_locations', 'agree_to_terms', 'unanswered', 'skipped', 'prefilled'].includes(key)) continue
    if (value !== null) (out as Record<string, unknown>)[key] = value
  }
  if (next.preferred_locations.length) out.preferred_locations = next.preferred_locations
  // Ticking consent is the user's own switch, never something an agent read.
  out.agree_to_terms = base.agree_to_terms
  const custom = new Map(base.custom.map((c) => [c.question.toLowerCase(), c]))
  for (const c of next.custom) custom.set(c.question.toLowerCase(), c)
  out.custom = [...custom.values()].slice(0, MAX_CUSTOM_ANSWERS)
  return prunePending(out)
}

/** How many questions are answered, for "18 answered". */
export function answeredCount(a: ApplicationAnswers): number {
  const { custom, preferred_locations, agree_to_terms: _, unanswered: _u, skipped: _s, prefilled: _p, ...rest } = a
  return Object.values(rest).filter((v) => v !== null).length + (preferred_locations.length ? 1 : 0) + custom.length
}

// ── ```landed-answers: the agent reads a form the user already filled ────

export const ANSWERS_FENCE = 'landed-answers'

/** An agent reply → its text without the block, and the answers it read
 *  (null when it read none). `drafting` while the block is still streaming. */
export function extractAnswers(reply: string): { text: string; answers: ApplicationAnswers | null; drafting: boolean } {
  const start = reply.search(new RegExp('```' + ANSWERS_FENCE + '[^\\n]*\\n'))
  if (start === -1) return { text: reply, answers: null, drafting: false }
  const bodyStart = reply.indexOf('\n', start) + 1
  const end = reply.indexOf('```', bodyStart)
  const before = reply.slice(0, start).trimEnd()
  if (end === -1) return { text: before, answers: null, drafting: true }
  const after = reply.slice(end + 3).trim()
  let answers: ApplicationAnswers | null = null
  try {
    // An agent's read never turns on the consent switch, and a "worked here
    // before: yes" it read is about that one company, not every company.
    const read = parseApplicationAnswers(JSON.parse(reply.slice(bodyStart, end)))
    answers = { ...read, agree_to_terms: false, previously_employed: read.previously_employed === 'yes' ? null : read.previously_employed }
  } catch {
    answers = null
  }
  if (answers && answeredCount(answers) === 0) answers = null
  return { text: after ? `${before}\n\n${after}` : before, answers, drafting: false }
}

// ── questions forms asked that nothing answered yet ──────────────────────
// After a fill the extension reports the fields it had to leave empty —
// never sensitive questions, files, open-ended text or resume fields
// (apps/extension/lib/fill/unanswered.js). The page bridge brings them here
// (hooks/extension-bridge.ts) and the Extension page asks the user once. The
// answer goes to the field the question is about (`key`, from the
// extension's classifier) or to "other questions"; the next fill answers it
// by rule, however the form words it (sameQuestion).

/** A field an answer to a pending question can go to. */
export type AnswerKey = keyof typeof TEXT_FIELDS | typeof YES_NO_FIELDS[number]
export const ANSWER_KEYS = [...Object.keys(TEXT_FIELDS), ...YES_NO_FIELDS] as AnswerKey[]
/** Voluntary self-identification and date of birth are never asked this way. */
const NEVER_ASKED = new Set<string>(['date_of_birth', 'gender', 'race', 'hispanic_latino', 'veteran', 'disability'])
const isYesNoKey = (key: string) => (YES_NO_FIELDS as readonly string[]).includes(key)

export type PendingQuestion = {
  question: string
  /** the answer it's about, else null (saved under "other questions") */
  key: AnswerKey | null
  /** the form's options, when it's a choice */
  options: string[]
  /** where it was asked (hostnames, newest first) */
  sites: string[]
  /** how many fills had to leave it empty */
  seen: number
  last_seen: string
}

/** What the extension reports for one empty field. */
export type ReportedQuestion = { question?: unknown; key?: unknown; options?: unknown; site?: unknown }

export const MAX_PENDING = 30
export const MAX_SKIPPED = 200

function pendingKey(raw: unknown): AnswerKey | null | undefined {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string' || NEVER_ASKED.has(raw)) return undefined
  return (ANSWER_KEYS as string[]).includes(raw) ? raw as AnswerKey : null
}

function parsePending(raw: unknown): PendingQuestion | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const question = text(r.question, 300)
  const key = pendingKey(r.key)
  if (!question || key === undefined) return null
  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : []).map((x) => text(x, max)).filter((x): x is string => !!x).slice(0, n)
  return {
    question, key,
    options: list(r.options, 20, 200),
    sites: list(r.sites, 5, 120),
    seen: typeof r.seen === 'number' && Number.isInteger(r.seen) && r.seen > 0 ? Math.min(r.seen, 9999) : 1,
    last_seen: text(r.last_seen, 40) ?? '',
  }
}

// Words that don't tell two questions apart.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'do', 'does', 'did', 'you', 'your', 'are', 'is', 'am',
  'have', 'has', 'how', 'many', 'what', 'which', 'please', 'we', 'us', 'our', 'this', 'that', 'any', 'be', 'will', 'would', 'if', 'can',
  'select', 'enter', 'provide', 'required', 'optional', 'yes', 'no', 'currently', 'company',
])

/** A question as a comparable key: lowercase letters and digits, no
 *  "(required)" or asterisks. */
export function questionKey(question: string): string {
  return question.toLowerCase().replace(/\((?:required|optional)\)|\*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The same question, maybe worded differently: the same key, or (with two
 *  or more meaningful words each) at least 80% of the words shared. */
export function sameQuestion(a: string, b: string): boolean {
  const ka = questionKey(a)
  const kb = questionKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const words = (k: string) => new Set(k.split(' ').filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))
  const wa = words(ka)
  const wb = words(kb)
  if (wa.size < 2 || wb.size < 2) return false
  let both = 0
  for (const w of wa) if (wb.has(w)) both++
  return both / (wa.size + wb.size - both) >= 0.8
}

/** Does something saved already answer this question? */
function isAnswered(a: ApplicationAnswers, q: Pick<PendingQuestion, 'question' | 'key'>): boolean {
  if (q.key && (a as Record<string, unknown>)[q.key] != null) return true
  return a.custom.some((c) => sameQuestion(c.question, q.question))
}

/** Drop pending questions something now answers. */
export function prunePending(a: ApplicationAnswers): ApplicationAnswers {
  const unanswered = a.unanswered.filter((q) => !isAnswered(a, q))
  return unanswered.length === a.unanswered.length ? a : { ...a, unanswered }
}

/** Questions the extension reported → the pending list: new ones first, a
 *  question already there (however worded) counted again, and nothing the
 *  user answered, skipped, or must never be asked. */
export function addUnanswered(a: ApplicationAnswers, reported: ReportedQuestion[], now: string): ApplicationAnswers {
  const pending = a.unanswered.map((q) => ({ ...q, sites: [...q.sites] }))
  const skipped = new Set(a.skipped)
  for (const r of Array.isArray(reported) ? reported : []) {
    const q = parsePending({ question: r?.question, key: r?.key, options: r?.options, sites: [r?.site], seen: 1, last_seen: now })
    if (!q || skipped.has(questionKey(q.question)) || isAnswered(a, q)) continue
    const same = pending.find((p) => sameQuestion(p.question, q.question) || (q.key !== null && p.key === q.key))
    if (!same) {
      pending.unshift(q)
      continue
    }
    same.seen = Math.min(same.seen + 1, 9999)
    same.last_seen = now
    same.sites = [...new Set([...q.sites, ...same.sites])].slice(0, 5)
    if (!same.options.length) same.options = q.options
  }
  return { ...a, unanswered: pending.slice(0, MAX_PENDING) }
}

/** The user answers a pending question on the Extension page: it goes to the
 *  answer it's about (a yes/no one takes "yes" or "no"), else "other
 *  questions"; the question leaves the list. A blank answer changes nothing. */
export function answerPending(a: ApplicationAnswers, question: string, answer: string): ApplicationAnswers {
  const q = a.unanswered.find((p) => p.question === question) ?? a.unanswered.find((p) => sameQuestion(p.question, question))
  const value = text(answer, 500)
  if (!q || !value) return a
  const out: ApplicationAnswers = { ...a, custom: [...a.custom] }
  if (q.key && isYesNoKey(q.key)) {
    const yn = yesNo(value.toLowerCase())
    if (!yn) return a
    ;(out as Record<string, unknown>)[q.key] = yn
  } else if (q.key) {
    ;(out as Record<string, unknown>)[q.key] = text(value, TEXT_FIELDS[q.key as keyof typeof TEXT_FIELDS])
  } else {
    out.custom = [...out.custom.filter((c) => !sameQuestion(c.question, q.question)), { question: q.question, answer: value }].slice(-MAX_CUSTOM_ANSWERS)
  }
  return prunePending({ ...out, unanswered: out.unanswered.filter((p) => p !== q) })
}

/** "Don't ask again": off the list, and not added back. */
export function skipPending(a: ApplicationAnswers, question: string): ApplicationAnswers {
  const q = a.unanswered.find((p) => p.question === question)
  if (!q) return a
  return {
    ...a,
    unanswered: a.unanswered.filter((p) => p !== q),
    skipped: [...new Set([questionKey(q.question), ...a.skipped])].slice(0, MAX_SKIPPED),
  }
}
