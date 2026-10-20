// Application answers Landed already knows (docs/apply-assist.md): what the
// resume and the active job search say, filled in on their own for the
// questions still blank (hooks/answers.ts, useKnownAnswers) so the user
// doesn't type them again; the Extension page marks them, and the user
// changes what's wrong. Each question is filled in once (`prefilled`), so one
// the user cleared stays clear. Only what the resume or the search states
// outright: never date of birth, street address, work authorization, EEO or
// consent.
import type { Resume } from '@landed/schema'
import type { ApplicationAnswers, Prefilled, YesNo } from '@landed/schema/application-answers'
import type { SearchBrief } from '@landed/schema/search-brief'

export type Suggestion =
  | { key: 'legal_first_name' | 'legal_last_name' | 'linkedin' | 'github' | 'website' | 'city' | 'state' | 'country' | 'earliest_start'; value: string; from: 'resume' }
  | { key: 'preferred_locations'; value: string[]; from: 'search' }
  | { key: 'needs_sponsorship'; value: YesNo; from: 'search' }

export const SUGGESTION_LABELS: Record<Suggestion['key'], string> = {
  legal_first_name: 'First name', legal_last_name: 'Last name',
  linkedin: 'LinkedIn', github: 'GitHub', website: 'Website', city: 'City', state: 'State', country: 'Country',
  earliest_start: 'Start date', preferred_locations: 'Preferred locations', needs_sponsorship: 'Sponsorship',
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}
const PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan',
}
const lookup = (table: Record<string, string>, part: string): string | null => {
  const t = part.trim()
  if (/^[A-Z]{2}$/.test(t) && table[t]) return table[t]
  return Object.values(table).find((s) => s.toLowerCase() === t.toLowerCase()) ?? null
}
const isUS = (part: string) => /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(part.trim())

/** "Seattle, WA" → Seattle / Washington / United States; "Shanghai, China" →
 *  Shanghai / China. One word ("Remote", "Seattle") says too little: null. */
export function placeParts(location: string): { city: string; state: string | null; country: string } | null {
  const parts = location.split(/[,，]/).map((p) => p.replace(/\b\d{5}(-\d{4})?\b/, '').trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 3 || /remote|远程/i.test(location)) return null
  const [city, ...rest] = parts
  if (/\d/.test(city)) return null
  const last = rest[rest.length - 1]
  if (rest.length === 1) {
    const state = lookup(US_STATES, last)
    if (state) return { city, state, country: 'United States' }
    const province = lookup(PROVINCES, last)
    if (province) return { city, state: province, country: 'Canada' }
    // "Washington, USA" names a state, not a city.
    if (isUS(last)) return lookup(US_STATES, city) ? null : { city, state: null, country: 'United States' }
    return { city, state: null, country: last }
  }
  if (isUS(last)) {
    const state = lookup(US_STATES, rest[0])
    return state ? { city, state, country: 'United States' } : null
  }
  return { city, state: lookup(PROVINCES, rest[0]) ?? rest[0], country: last }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2027-06", "06/2027", "Jun 2027", "2027" → { year, month (1–12) | null }. */
function dateOf(text: string): { year: number; month: number | null } | null {
  const t = text.trim()
  let m = t.match(/^(\d{4})[-/.](\d{1,2})/)
  if (m) return { year: +m[1], month: +m[2] }
  m = t.match(/^(\d{1,2})[-/.](\d{4})$/)
  if (m) return { year: +m[2], month: +m[1] }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/)
  if (m) {
    const i = MONTHS.findIndex((name) => name.toLowerCase().startsWith(m![1].toLowerCase().slice(0, 3)))
    return i >= 0 ? { year: +m[2], month: i + 1 } : null
  }
  m = t.match(/^(\d{4})$/)
  return m ? { year: +m[1], month: null } : null
}

/** When the resume says school ends, if that's still ahead: "June 2027". */
export function graduation(resume: Resume, now: Date): string | null {
  const ends = resume.education.map((e) => dateOf(String(e.end_date ?? ''))).filter((d): d is NonNullable<typeof d> => d !== null)
  const last = ends.sort((a, b) => b.year - a.year || (b.month ?? 12) - (a.month ?? 12))[0]
  if (!last) return null
  const ahead = last.year > now.getFullYear() || (last.year === now.getFullYear() && (last.month ?? 12) > now.getMonth() + 1)
  if (!ahead) return null
  return last.month ? `${MONTHS[last.month - 1]} ${last.year}` : String(last.year)
}

/** A link as forms want it: a full https URL. Text that isn't a link: null. */
export function fullLink(text: string, site?: 'linkedin' | 'github'): string | null {
  let t = text.trim().replace(/\s+/g, '')
  if (!t || t.includes('@')) return null
  if (site === 'linkedin' && /^in\//i.test(t)) t = `linkedin.com/${t}`
  if (!/^https?:\/\//i.test(t)) {
    if (!/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return null
    t = `https://${t}`
  }
  try {
    const url = new URL(t)
    if (site && !url.hostname.toLowerCase().endsWith(`${site}.com`)) return null
    if (site === 'linkedin' && url.hostname.toLowerCase() === 'linkedin.com') url.hostname = 'www.linkedin.com'
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)

/** Answers the resume and the active search give for questions still blank
 *  and never filled in before. */
export function suggestAnswers(
  { resume, brief, answers }: { resume: Resume | null; brief: SearchBrief | null; answers: ApplicationAnswers },
  now: Date = new Date(),
): Suggestion[] {
  const out: Suggestion[] = []
  // Answers saved before `prefilled` existed have none.
  const prefilled = answers.prefilled ?? {}
  const add = (s: Suggestion) => { if (blank(answers[s.key]) && !prefilled[s.key]) out.push(s) }
  if (resume) {
    const b = resume.basic
    // Both parts or neither: one name alone can't say which part it is.
    const name = resumeName(resume)
    if (name?.first && name.last) {
      add({ key: 'legal_first_name', value: name.first, from: 'resume' })
      add({ key: 'legal_last_name', value: name.last, from: 'resume' })
    }
    const linkedin = fullLink(b.linkedin, 'linkedin')
    const github = fullLink(b.github, 'github')
    const website = fullLink(b.portfolio)
    if (linkedin) add({ key: 'linkedin', value: linkedin, from: 'resume' })
    if (github) add({ key: 'github', value: github, from: 'resume' })
    if (website) add({ key: 'website', value: website, from: 'resume' })
    // City, state and country go together: only when none is answered yet,
    // so a half-typed address isn't mixed with the resume's.
    const place = placeParts(b.location)
    if (place && blank(answers.city) && blank(answers.state) && blank(answers.country)) {
      add({ key: 'city', value: place.city, from: 'resume' })
      if (place.state) add({ key: 'state', value: place.state, from: 'resume' })
      add({ key: 'country', value: place.country, from: 'resume' })
    }
    const start = graduation(resume, now)
    if (start) add({ key: 'earliest_start', value: start, from: 'resume' })
  }
  if (brief) {
    const places = brief.locations.map((l) => l.trim()).filter((l) => l && !/^remote$/i.test(l)).slice(0, 3)
    if (places.length) add({ key: 'preferred_locations', value: places, from: 'search' })
    if (brief.needs_sponsorship !== null) add({ key: 'needs_sponsorship', value: brief.needs_sponsorship ? 'yes' : 'no', from: 'search' })
  }
  return out
}

/** The answers with the suggestions filled in, each one noted in `prefilled`. */
export function withSuggestions(answers: ApplicationAnswers, suggestions: Suggestion[]): ApplicationAnswers {
  const next = { ...answers, prefilled: { ...(answers.prefilled ?? {}) } }
  for (const s of suggestions) {
    (next as Record<string, unknown>)[s.key] = s.value
    next.prefilled[s.key] = { value: s.value, from: s.from }
  }
  return next
}

/** Filled in on their own and still as written: the ones the page marks. */
export function stillPrefilled(answers: ApplicationAnswers): [Suggestion['key'], Prefilled][] {
  return (Object.entries(answers.prefilled ?? {}) as [Suggestion['key'], Prefilled][])
    .filter(([key, p]) => JSON.stringify(answers[key]) === JSON.stringify(p.value))
}

/** Undo: the ones still as written go back to blank; they stay noted, so
 *  they aren't filled in again. */
export function clearPrefilled(answers: ApplicationAnswers): ApplicationAnswers {
  const next = { ...answers }
  for (const [key] of stillPrefilled(answers)) (next as Record<string, unknown>)[key] = key === 'preferred_locations' ? [] : null
  return next
}

/** The name on the resume, split for the legal-name hints: first and last. */
export function resumeName(resume: Resume | null): { first: string; last: string; full: string } | null {
  if (!resume) return null
  const b = resume.basic
  const full = (b.name || [b.firstName, b.lastName].filter(Boolean).join(' ')).trim()
  if (!full) return null
  const words = full.split(/\s+/)
  return { first: b.firstName || (words.length > 1 ? words[0] : full), last: b.lastName || (words.length > 1 ? words[words.length - 1] : ''), full }
}
