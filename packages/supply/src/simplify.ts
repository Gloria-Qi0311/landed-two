// SimplifyJobs lists → found jobs (#90). The New Grad and Internships repos
// publish every listing as JSON (.github/scripts/listings.json, the file
// their README tables are generated from): company, title, link, locations,
// posting date, whether it's still open, sponsorship. The browser fetches
// it (docs/leads-model.md: public postings never go through the server),
// and only what fits the active search becomes a lead.
import { companyKey, titleWords } from '@landed/observation-processor'
import { parsePostedAt } from '@landed/schema/lead-queue'
import type { FoundJob, SearchBrief } from '@landed/schema/search-brief'

export type SimplifyList = 'new_grad' | 'internships'

export const SIMPLIFY_LISTS: Record<SimplifyList, { label: string; url: string }> = {
  new_grad: {
    label: 'SimplifyJobs New Grad',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  },
  internships: {
    label: 'SimplifyJobs Internships',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  },
}

export type SimplifyListing = {
  /** the list's own id for the posting (stable across updates) */
  id: string
  company: string
  title: string
  url: string
  locations: string[]
  /** "YYYY-MM-DD" */
  posted_at: string | null
  /** false once the posting closed */
  active: boolean
  /** null when the list says nothing ("Other") */
  sponsorship: string | null
  category: string | null
}

/** Only postings at least this new become leads. */
export const MAX_AGE_DAYS = 30
/** At most this many new leads per list per refresh, newest first. */
export const MAX_PER_LIST = 60

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function httpUrl(v: unknown): string | null {
  const t = text(v, 2000)
  if (!t) return null
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** The list file → its listings. Rows that don't read (no id, company, title
 *  or http link) and hidden ones are skipped; anything but an array is []. */
export function parseSimplifyListings(raw: unknown): SimplifyListing[] {
  if (!Array.isArray(raw)) return []
  const out: SimplifyListing[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = text(r.id, 100)
    const company = text(r.company_name, 120)
    const title = text(r.title, 200)
    const url = httpUrl(r.url)
    if (!id || !company || !title || !url || seen.has(id) || r.is_visible === false) continue
    seen.add(id)
    const sponsorship = text(r.sponsorship, 120)
    out.push({
      id, company, title, url,
      locations: (Array.isArray(r.locations) ? r.locations : []).map((l) => text(l, 120)).filter((l): l is string => !!l).slice(0, 20),
      // date_posted is in seconds
      posted_at: typeof r.date_posted === 'number' ? parsePostedAt(r.date_posted * 1000) : parsePostedAt(r.date_posted),
      active: r.active === true,
      sponsorship: sponsorship && sponsorship !== 'Other' ? sponsorship : null,
      category: text(r.category, 80),
    })
  }
  return out
}

/** Which lists a search wants: internships, new grad, or both when it
 *  doesn't say; none for senior roles, which these lists don't carry. */
export function listsForBrief(brief: SearchBrief): SimplifyList[] {
  const said = [brief.seniority ?? '', ...brief.roles].join(' ').toLowerCase()
  const intern = /\bintern(ship)?s?\b|co-?op|实习/.test(said)
  const grad = /new ?grad|graduate|entry|junior|early career|university|campus|校招|应届/.test(said)
  if (intern || grad) return [...(grad ? ['new_grad' as const] : []), ...(intern ? ['internships' as const] : [])]
  if (/\b(senior|staff|principal|lead|director|sr)\b|资深|高级/.test(said)) return []
  return ['new_grad', 'internships']
}

// Level words don't narrow a title here: the list already is the level.
const LEVEL_WORDS = new Set(['intern', 'internship', 'interns', 'new', 'grad', 'graduate', 'entry', 'level', 'junior', 'university', 'early', 'career', 'i', '1', 'co', 'op', 'coop'])

/** "engineer" finds "engineering"; short words must be exact. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short)
}

/** Every meaningful word of one of the brief's roles is in the title. */
export function roleMatches(roles: string[], title: string): boolean {
  const have = titleWords(title)
  return roles.some((role) => {
    const want = titleWords(role).filter((w) => !LEVEL_WORDS.has(w))
    return want.length > 0 && want.every((w) => have.some((h) => sameWord(w, h)))
  })
}

const PLACE_ALIASES: Record<string, string[]> = {
  nyc: ['new york'],
  'new york city': ['new york'],
  sf: ['san francisco'],
  'bay area': ['san francisco', 'san jose', 'mountain view', 'palo alto', 'sunnyvale', 'menlo park', 'oakland', 'santa clara', 'redwood city', 'cupertino', 'fremont', 'san mateo', 'berkeley'],
  la: ['los angeles'],
  dc: ['washington, dc', 'washington dc', 'washington, d.c.'],
}

/** Anywhere when the brief names no place; otherwise one of the posting's
 *  places is one of the brief's (or remote, when the brief wants remote). */
export function placeMatches(brief: SearchBrief, locations: string[]): boolean {
  // "NYC" on the posting is New York too.
  const places = locations.flatMap((l) => {
    const p = l.toLowerCase().trim()
    return [p, ...(PLACE_ALIASES[p] ?? [])]
  })
  const wantsRemote = brief.remote === 'remote' || brief.locations.some((l) => /remote|远程/i.test(l))
  if (wantsRemote && places.some((p) => /\bremote\b/.test(p))) return true
  if (brief.locations.length === 0) return true
  return brief.locations.some((want) => {
    const w = want.toLowerCase().trim()
    const names = PLACE_ALIASES[w] ?? [w.split(',')[0].trim()]
    return names.some((n) => n.length >= 2 && places.some((p) => p.includes(n)))
  })
}

/** The listings worth a lead for this search: open, posted in the last
 *  MAX_AGE_DAYS, the right role and place, not an excluded company; newest
 *  first, at most MAX_PER_LIST. */
export function selectForBrief(listings: SimplifyListing[], brief: SearchBrief, now: Date): SimplifyListing[] {
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10)
  const excluded = new Set(brief.exclude_companies.map(companyKey))
  return listings
    .filter((l) => l.active && l.posted_at !== null && l.posted_at >= cutoff)
    .filter((l) => !excluded.has(companyKey(l.company)))
    .filter((l) => roleMatches(brief.roles, l.title) && placeMatches(brief, l.locations))
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))
    .slice(0, MAX_PER_LIST)
}

export function toFoundJob(l: SimplifyListing): FoundJob {
  return {
    company: l.company,
    title: l.title,
    job_url: l.url,
    location: l.locations.join('; ').slice(0, 120) || null,
    posted: l.posted_at,
    deadline: null,
    salary: null,
    sponsorship: l.sponsorship,
    why: null,
  }
}

/** The observation id a listing becomes: stable, so refreshing again finds
 *  the lead it made instead of adding the same source twice. */
export function simplifyObservationId(list: SimplifyList, listingId: string): string {
  return `simplify:${list}:${listingId}`
}

/** The listing a lead's source came from, or null. */
export function simplifySourceOf(observationId: string): { list: SimplifyList; id: string } | null {
  const m = observationId.match(/^simplify:(new_grad|internships):(.+)$/)
  return m ? { list: m[1] as SimplifyList, id: m[2] } : null
}
