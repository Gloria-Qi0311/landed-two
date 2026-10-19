// Hard filters (#92): postings a person plainly can't apply to, and why.
// Three rules, each only on what the posting says outright — a filter that
// isn't sure doesn't filter (better to miss one than hide a real chance):
//
//   graduation    the posting names a graduation window and the master
//                 resume's graduation falls outside it
//   sponsorship   the posting says it won't sponsor visas and the saved
//                 answers say the person needs sponsorship
//   citizenship   the posting requires US citizenship or a security
//                 clearance and the saved answers say the person needs
//                 sponsorship (so isn't a citizen). The answers have no
//                 citizenship field, so that is the only sure case.
//
// A rule whose input is missing (no master resume, no saved answers) is
// skipped, and so are the two that rest on US sponsorship for a job plainly
// outside the US. Runs in the browser: it reads the resume and answers.
import type { Resume } from '@landed/schema'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
import type { LeadScreen } from '@landed/schema/lead-queue'

export type ScreenInput = {
  /** what the posting says: title, description (full text when we have it) */
  text: string
  /** where the job is; a job plainly outside the US skips the rules that
   *  rest on US sponsorship */
  location?: string | null
  resume: Resume | null
  answers: ApplicationAnswers | null
}

/** A month as one number (year × 12 + month − 1). */
type Ym = number
const ym = (y: number, m: number): Ym => y * 12 + (m - 1)
const yearOf = (v: Ym) => Math.floor(v / 12)
const monthOf = (v: Ym) => (v % 12) + 1
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const SEASONS: Record<string, number> = { spring: 5, summer: 8, fall: 12, autumn: 12, winter: 12 }

function monthWord(w: string | undefined): number | null {
  if (!w) return null
  const t = w.toLowerCase().replace(/\.$/, '')
  if (SEASONS[t]) return SEASONS[t]
  const i = MONTHS.indexOf(t.slice(0, 3))
  return i >= 0 && (t.length === 3 || t.startsWith(MONTHS[i])) ? i + 1 : null
}

const sane = (y: number) => y >= 2000 && y <= 2100

// ── graduation ─────────────────────────────────────────────────────────────

/** Months a posting accepts graduates in; null bounds are open. */
export type GradWindow = { from: Ym | null; to: Ym | null }

const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?|spring|summer|fall|autumn|winter'
const DATE_RE = `(?:(${MONTH_RE})\\s+)?(\\d{4})`

/** The graduation window a posting states, or null when it states none. */
export function graduationWindow(raw: string): GradWindow | null {
  const t = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ')
  const windows: GradWindow[] = []
  const add = (from: Ym | null, to: Ym | null) => {
    if ((from === null || sane(yearOf(from))) && (to === null || sane(yearOf(to)))) windows.push({ from, to })
  }
  const start = (m: string | undefined, y: string) => ym(+y, monthWord(m) ?? 1)
  const end = (m: string | undefined, y: string) => ym(+y, monthWord(m) ?? 12)

  // "graduating between December 2025 and June 2026", "graduation date from May 2026 to Aug 2027"
  for (const m of t.matchAll(new RegExp(`graduat\\w*[^.;\\n]{0,60}?(?:between|from)\\s+${DATE_RE}\\s*(?:and|to|through|until|-|–|—)\\s*${DATE_RE}`, 'g'))) {
    add(start(m[1], m[2]), end(m[3], m[4]))
  }
  // "graduating in 2026", "expected graduation date of May 2026 or 2027", "graduate by June 2026", "graduating in 2027 or later"
  for (const m of t.matchAll(new RegExp(`(?:graduat(?:e|es|ing|ion)(?: date)?)\\s*[:\\-–]?\\s*(?:is\\s+|will be\\s+)?(in|by|of|during|before|no later than|between)?\\s*(?:the\\s+)?(?:(?:${MONTH_RE})\\s+)?(\\d{4}(?:\\s*(?:,|or|and|\\/)\\s*(?:(?:${MONTH_RE})\\s+)?\\d{4})*)(\\s+or\\s+(?:later|after|beyond))?`, 'g'))) {
    if (m[1] === 'between') continue // the range rule above
    const points = [...m[0].matchAll(new RegExp(DATE_RE, 'g'))].map((d) => ({ month: d[1], year: d[2] }))
    if (points.length === 0) continue
    const first = points[0]
    const last = points[points.length - 1]
    if (m[1] === 'by' || m[1] === 'before' || m[1] === 'no later than') add(null, end(last.month, last.year))
    else if (m[3]) add(start(first.month, first.year), null)
    else add(start(first.month, first.year), end(last.month, last.year))
  }
  // "class of 2026", "2026 graduates", "2026 new grads" — an academic year: from the September before
  for (const m of t.matchAll(/\bclass of (\d{4})\b|\b(\d{4}) (?:new )?grad(?:uate)?s\b/g)) {
    const y = +(m[1] ?? m[2])
    add(ym(y - 1, 9), ym(y, 12))
  }
  // 中文: "2025年10月至2026年9月毕业", "2026届", "2026年毕业"
  for (const m of t.matchAll(/(\d{4})年(\d{1,2})?月?\s*(?:至|到|-|–|—|~)\s*(\d{4})年(\d{1,2})?月?[^。；\n]{0,8}毕业/g)) {
    add(ym(+m[1], m[2] ? +m[2] : 1), ym(+m[3], m[4] ? +m[4] : 12))
  }
  for (const m of t.matchAll(/(\d{4})\s*届|(\d{4})\s*年\s*毕业/g)) {
    const y = +(m[1] ?? m[2])
    add(ym(y - 1, 9), ym(y, 12))
  }
  if (windows.length === 0) return null
  // Several statements: accept anything any of them accepts.
  const from = windows.some((w) => w.from === null) ? null : Math.min(...windows.map((w) => w.from!))
  const to = windows.some((w) => w.to === null) ? null : Math.max(...windows.map((w) => w.to!))
  return { from, to }
}

/** When the person graduates (or graduated): the latest education end
 *  date that reads, as a month range (a bare year is the whole year). Null
 *  when it doesn't read or is "present". */
export function graduationOf(resume: Resume | null): { from: Ym; to: Ym } | null {
  let best: { from: Ym; to: Ym } | null = null
  for (const e of resume?.education ?? []) {
    const s = String(e.end_date ?? '').toLowerCase()
    if (!s.trim() || /present|now|current|至今|在读/.test(s)) continue
    let range: { from: Ym; to: Ym } | null = null
    const iso = s.match(/(\d{4})[-/.年](\d{1,2})/)
    const word = s.match(new RegExp(`(${MONTH_RE})\\s*,?\\s*(\\d{4})`))
    const year = s.match(/(\d{4})/)
    if (iso && +iso[2] >= 1 && +iso[2] <= 12) range = { from: ym(+iso[1], +iso[2]), to: ym(+iso[1], +iso[2]) }
    else if (word && monthWord(word[1])) range = { from: ym(+word[2], monthWord(word[1])!), to: ym(+word[2], monthWord(word[1])!) }
    else if (year) range = { from: ym(+year[1], 1), to: ym(+year[1], 12) }
    if (range && sane(yearOf(range.from)) && (!best || range.to > best.to)) best = range
  }
  return best
}

const label = (v: Ym) => `${MONTHS[monthOf(v) - 1].replace(/^./, (c) => c.toUpperCase())} ${yearOf(v)}`
function windowLabel(w: GradWindow): string {
  if (w.from !== null && w.to !== null) return `${label(w.from)} – ${label(w.to)}`
  return w.from !== null ? `${label(w.from)} or later` : `by ${label(w.to!)}`
}

// ── sponsorship, citizenship ───────────────────────────────────────────────

const NO_SPONSORSHIP = [
  // "do not offer relocation or visa sponsorship": a few words may sit between
  /\b(?:not|unable to|cannot|can't|won't|will not|does not|do not|doesn't|don't|is not able to|are not able to|aren't able to)\s+(?:be able to\s+)?(?:currently\s+)?(?:offer|provide|support|consider)\w*\s+(?:[\w/-]+\s+){0,4}?sponsorship\b/,
  /\bwithout (?:the need for |requiring |need of |requiring the )?(?:current or future |now or in the future,? )?(?:employer[- ])?(?:visa |immigration |work visa )?sponsorship\b/,
  /\b(?:visa |immigration )?sponsorship (?:is |will )?(?:not|n't) (?:be )?(?:available|offered|provided|possible|supported)\b/,
  /\bno (?:visa |immigration |h-?1b )?sponsorship\b/,
  /\bnot eligible for (?:visa |immigration )?sponsorship\b/,
  /不(?:提供|支持|能提供|可提供)(?:工作)?签证(?:担保|赞助)?|无法(?:提供|办理)(?:工作)?签证/,
]
// "We offer visa sponsorship" — never a reason to filter.
const OFFERS_SPONSORSHIP = /\b(?:will|can|do|does|we)\s+(?:offer|provide|sponsor)\w*\s+(?:visa\s+)?sponsorship\b|\bsponsorship (?:is )?available\b|\boffers sponsorship\b/

const CITIZENSHIP = [
  /\bu\.?\s?s\.? citizenship (?:is )?(?:required|is a requirement)\b|\brequires? (?:u\.?\s?s\.? )?citizenship\b/,
  /\bmust (?:be|hold) (?:a |an )?(?:u\.?\s?s\.?|united states) citizen\b|\b(?:u\.?\s?s\.?|united states) citizens? only\b/,
  /\bmust be (?:a )?u\.?\s?s\.? person\b/,
  // A security clearance (holding one, or being eligible for one) needs US
  // citizenship: "Eligibility and willingness to obtain a US Security
  // clearance", "Active Full Scope Poly level US security clearance",
  // "clearance at the Top Secret level". Not "clearance pricing".
  // ("Active Full Scope Poly Level clearance": a word or two may sit between)
  /\b(?:security|secret|top secret|ts\/sci|ts|poly(?:graph)?|government|dod|u\.?\s?s\.?)\s+(?:(?:level|or higher|or above|and above)\s+)?(?:security\s+)?clearances?\b/,
  /\bclearance (?:at|of) the (?:secret|top secret|ts)\b|\bts\/sci\b/,
  /须为?美国公民|仅限美国公民/,
]
// "…clearance is beneficial", "US citizenship preferred": a plus, not a requirement.
const ONLY_A_PLUS = /\b(?:preferred|preferably|a plus|nice to have|bonus|beneficial|desired|desirable|an advantage|advantageous|helpful|ideally)\b|优先/
// "No security clearance required", "does not require a clearance",
// "clearance not needed", "不需要": the opposite of a requirement (review of #105).
const NOT_REQUIRED = /(?:\bno\b|\bnot\b|\bwithout\b|n't\b)[^.;]{0,40}\b(?:required|requirement|needed|necessary)\b|(?:\bnot\b|\bno\b|n't)\s+(?:require|need)\w*|\bwithout\b[^.;]{0,40}\b(?:welcome|encouraged|eligible|considered)\b|不需要|无需|不要求|不必/

// Another country's clearance ("Lithuanian Security Clearance", "DV UK
// security clearance"): needing US sponsorship says nothing about it.
const OTHER_COUNTRY = /\b(?:uk|british|lithuanian?|canadian|canada|australian?|german|germany|french|france|israeli|singapore(?:an)?|nato|eu|european|dv|sc|nz|new zealand|japanese|korean)\b/

/** A sentence or bullet that requires US citizenship or a US clearance —
 *  not one that calls it a plus, says it isn't needed, or is about another
 *  country's clearance. */
function requiresCitizenship(plain: string): boolean {
  return plain.split(/[.;](?=\s|$)|[•\n]|\s-\s/).some((sentence) =>
    !ONLY_A_PLUS.test(sentence) && !NOT_REQUIRED.test(sentence) && !OTHER_COUNTRY.test(sentence)
    && CITIZENSHIP.some((re) => re.test(sentence)))
}

// "will not sponsor …" counts only when the same sentence is about visas or
// applicants ("is not sponsoring the conference" isn't).
const WONT_SPONSOR = /\b(?:will not|won't|unable to|cannot|can't|do not|does not|don't|doesn't|not able to|are not)\s+(?:currently\s+)?sponsor(?:ing)?\b/g
const VISA_TALK = /visa|h-?1b|immigration|green card|work (?:permit|authori[sz]ation)|employment (?:authori[sz]ation|visa)|applicants?|candidates?|individuals|international|opt\b|cpt\b/

function wontSponsor(text: string): boolean {
  for (const m of text.matchAll(WONT_SPONSOR)) {
    const sentence = text.slice(Math.max(0, text.lastIndexOf('.', m.index) + 1), text.indexOf('.', m.index) === -1 ? undefined : text.indexOf('.', m.index))
    if (VISA_TALK.test(sentence)) return true
  }
  return false
}

function firstMatch(text: string, rules: RegExp[]): string | null {
  for (const re of rules) {
    const m = text.match(re)
    if (m) return m[0]
  }
  return null
}

// ── where the job is ───────────────────────────────────────────────────────

const US_PLACE = /\b(?:usa?|u\.s\.a?\.?|united states|remote|[a-z .]+,\s*(?:al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b|d\.c\.|new york|nyc|san francisco|seattle|boston|chicago|austin|los angeles|denver|washington)\b/i
const ABROAD = /\b(?:uk|united kingdom|england|london|germany|berlin|munich|norway|oslo|spain|madrid|singapore|japan|tokyo|australia|sydney|canberra|canada|toronto|vancouver|montreal|ottawa|france|paris|lithuania|vilnius|poland|warsaw|israel|tel aviv|india|bangalore|korea|seoul|netherlands|amsterdam|ireland|dublin|switzerland|zurich|denmark|copenhagen|sweden|stockholm|italy|milan|brazil|mexico|china|hong kong|taiwan|uae|dubai)\b/i

/** A job plainly outside the US: its place names another country, not the US. */
export function outsideUS(location: string | null | undefined): boolean {
  const l = location ?? ''
  return ABROAD.test(l) && !US_PLACE.test(l)
}

// ── the screen ─────────────────────────────────────────────────────────────

/** Whether a posting passes the hard filters, with a sentence per failure.
 *  null when no rule could run (neither a resume nor answers). */
/** Lowercase, one kind of apostrophe, and "U.S." as "us" (its dots aren't
 *  the end of a sentence). Line breaks stay: bullets are sentences too. */
function plainText(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/\bu\.\s?s\.(?:\s?a\.)?/g, 'us ').replace(/[ \t]+/g, ' ')
}

export function screenPosting({ text, location, resume, answers }: ScreenInput): LeadScreen | null {
  const plain = plainText(text)
  const t = plain.replace(/\s+/g, ' ')
  const reasons: string[] = []
  let ran = false

  const grad = graduationOf(resume)
  if (grad) {
    ran = true
    const w = graduationWindow(text)
    const outside = w && ((w.to !== null && grad.from > w.to) || (w.from !== null && grad.to < w.from))
    if (w && outside) reasons.push(`Wants graduates ${windowLabel(w)}; you graduate ${grad.from === grad.to ? label(grad.from) : yearOf(grad.from)}`)
  }

  // "Need sponsorship" is about US work visas: a job abroad isn't judged by it.
  const needs = outsideUS(location) ? null : answers?.needs_sponsorship
  if (needs === 'yes' || needs === 'no') ran = true
  if (needs === 'yes' && !OFFERS_SPONSORSHIP.test(t) && (firstMatch(t, NO_SPONSORSHIP) || wontSponsor(t))) {
    reasons.push("Says it doesn't sponsor visas; you need sponsorship")
  }
  if (needs === 'yes' && requiresCitizenship(plain)) {
    reasons.push('Requires US citizenship or a security clearance; you need sponsorship')
  }

  if (!ran) return null
  return { pass: reasons.length === 0, reasons }
}

/** What a user writes when they put a filtered lead back: re-screening
 *  leaves such a lead alone. */
export const PUT_BACK = 'You put this back'

export function isPutBack(screen: LeadScreen | null | undefined): boolean {
  return !!screen?.pass && screen.reasons.includes(PUT_BACK)
}
