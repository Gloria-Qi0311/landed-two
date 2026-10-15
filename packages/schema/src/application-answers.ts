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

export type ApplicationAnswers = {
  // names — legal ones go to "First/Last name", preferred ones to "Preferred…"
  legal_first_name: string | null
  legal_middle_name: string | null
  legal_last_name: string | null
  preferred_first_name: string | null
  preferred_last_name: string | null
  /** as forms ask for it: "October 30" or "1999-10-30" */
  date_of_birth: string | null

  // permanent address
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null

  // eligibility
  work_authorized: YesNo | null
  needs_sponsorship: YesNo | null

  // availability and location
  /** "June 2027", "Immediately", "2 weeks after an offer" */
  earliest_start: string | null
  relocate: YesNo | null
  travel: YesNo | null
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
}

export const EMPTY_ANSWERS: ApplicationAnswers = {
  legal_first_name: null, legal_middle_name: null, legal_last_name: null, preferred_first_name: null, preferred_last_name: null,
  date_of_birth: null, address_line1: null, address_line2: null, city: null, state: null, postal_code: null, country: null,
  work_authorized: null, needs_sponsorship: null, earliest_start: null, relocate: null, travel: null, preferred_locations: [],
  open_to_other_locations: null, previously_employed: null, non_compete: null, heard_from: null, talent_network: null,
  gender: null, hispanic_latino: null, race: null, veteran: null, disability: null, agree_to_terms: false, custom: [],
}

export const MAX_CUSTOM_ANSWERS = 40
export const MAX_PREFERRED_LOCATIONS = 3

const TEXT_FIELDS = {
  legal_first_name: 80, legal_middle_name: 80, legal_last_name: 80, preferred_first_name: 80, preferred_last_name: 80,
  date_of_birth: 40, address_line1: 200, address_line2: 200, city: 100, state: 100, postal_code: 20, country: 80,
  earliest_start: 80, heard_from: 100, gender: 80, race: 120,
} as const
const YES_NO_FIELDS = [
  'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations', 'previously_employed',
  'non_compete', 'talent_network', 'hispanic_latino', 'veteran', 'disability',
] as const

const text = (v: unknown, max: number) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)
const yesNo = (v: unknown): YesNo | null => (v === 'yes' || v === 'no' ? v : null)

/** Validate stored or submitted answers: known fields only, trimmed text,
 *  yes/no or nothing. Anything else becomes "not answered". */
export function parseApplicationAnswers(raw: unknown): ApplicationAnswers {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: ApplicationAnswers = { ...EMPTY_ANSWERS, preferred_locations: [], custom: [] }
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
  return out
}

/** `next` on top of `base`: what `next` answers replaces, blanks keep
 *  `base`'s, custom questions merge by question, the consent switch stays
 *  as it was. For an agent's read of a filled form, saved over what the
 *  user already had. */
export function mergeAnswers(base: ApplicationAnswers, next: ApplicationAnswers): ApplicationAnswers {
  const out: ApplicationAnswers = { ...base }
  for (const [key, value] of Object.entries(next) as [keyof ApplicationAnswers, unknown][]) {
    if (key === 'custom' || key === 'preferred_locations' || key === 'agree_to_terms') continue
    if (value !== null) (out as Record<string, unknown>)[key] = value
  }
  if (next.preferred_locations.length) out.preferred_locations = next.preferred_locations
  // Ticking consent is the user's own switch, never something an agent read.
  out.agree_to_terms = base.agree_to_terms
  const custom = new Map(base.custom.map((c) => [c.question.toLowerCase(), c]))
  for (const c of next.custom) custom.set(c.question.toLowerCase(), c)
  out.custom = [...custom.values()].slice(0, MAX_CUSTOM_ANSWERS)
  return out
}

/** How many questions are answered, for "18 answered". */
export function answeredCount(a: ApplicationAnswers): number {
  const { custom, preferred_locations, agree_to_terms: _, ...rest } = a
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
    // An agent's read never turns on the consent switch.
    answers = { ...parseApplicationAnswers(JSON.parse(reply.slice(bodyStart, end))), agree_to_terms: false }
  } catch {
    answers = null
  }
  if (answers && answeredCount(answers) === 0) answers = null
  return { text: after ? `${before}\n\n${after}` : before, answers, drafting: false }
}
