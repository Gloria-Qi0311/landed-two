// jobright-ai's lists by direction → found jobs (#138). jobright.ai keeps a
// GitHub repo per direction and level ("2026-Data-Analysis-New-Grad",
// "2026-Product-Management-Internship"), updated daily: the product, data and
// business directions the SimplifyJobs lists barely carry (2026-10-22: 298 of
// 310 data-analysis new-grad rows weren't on SimplifyJobs). Only a README
// table: company, title, a jobright.ai link (never the application itself),
// location, work model, "Oct 22". The table keeps a rolling few days, so a row
// that's gone hasn't closed.
//
// The browser fetches it like the SimplifyJobs lists (raw GitHub allows any
// origin). A row whose company's Greenhouse, Lever or Ashby board has a posting
// with the very same title takes that posting's link (apps/web/src/lib/jobright.ts);
// the rest keep the jobright.ai link, which auto apply never opens.
import { companyKey, titleKey, titleWords } from '@landed/observation-processor'
import type { FoundJob, SearchBrief } from '@landed/schema/search-brief'
import type { BoardPosting } from './ats'
import { listsForBrief, placeMatches, tooSenior, type SimplifyList } from './simplify'

export type JobrightDirection = 'product' | 'data' | 'business'

/** The repos read, by direction and level. Only these three for now: the
 *  directions the issue asks for first. */
export const JOBRIGHT_DIRECTIONS: Record<JobrightDirection, { label: string; repo: Record<SimplifyList, string>; asks: RegExp }> = {
  product: {
    label: 'Product management',
    repo: { new_grad: '2026-Product-Management-New-Grad', internships: '2026-Product-Management-Internship' },
    asks: /\bproduct\b|\bpm\b|\bapm\b|产品/i,
  },
  data: {
    label: 'Data analysis',
    repo: { new_grad: '2026-Data-Analysis-New-Grad', internships: '2026-Data-Analysis-Internship' },
    // A product analyst's work is mostly data analysis: both lists.
    asks: /\bdata\b|\banalytics\b|product analyst|business intelligence|\bbi\b|数据/i,
  },
  business: {
    label: 'Business analysis',
    repo: { new_grad: '2026-Business-Analyst-New-Grad', internships: '2026-Business-Analyst-Internship' },
    asks: /business (analyst|analysis|analytics|operations)|\bstrategy\b|operations analyst|商业分析|商务分析/i,
  },
}

export const jobrightUrl = (repo: string) => `https://raw.githubusercontent.com/jobright-ai/${repo}/master/README.md`

/** Only postings at least this new become leads, and a lead kept on jobright's
 *  link is closed this long after it was posted: jobright's own pages say a
 *  posting is valid 30 days (`validThrough`). */
export const JOBRIGHT_MAX_AGE_DAYS = 30
/** At most this many new leads per list per refresh, newest first. */
export const JOBRIGHT_MAX_PER_LIST = 60

export type JobrightListing = {
  /** jobright's job id (24 hex), stable across updates and across lists */
  id: string
  company: string
  title: string
  /** jobright.ai's page for it (tracking parameters dropped) */
  url: string
  location: string | null
  remote: boolean
  /** "YYYY-MM-DD" */
  posted_at: string | null
}

/** The lists a search wants: each direction its roles name, at its level. */
export function jobrightListsForBrief(brief: SearchBrief): { direction: JobrightDirection; level: SimplifyList; repo: string }[] {
  const levels = listsForBrief(brief)
  const roles = brief.roles.join(' · ')
  return (Object.keys(JOBRIGHT_DIRECTIONS) as JobrightDirection[])
    .filter((d) => JOBRIGHT_DIRECTIONS[d].asks.test(roles))
    .flatMap((direction) => levels.map((level) => ({ direction, level, repo: JOBRIGHT_DIRECTIONS[direction].repo[level] })))
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** "Oct 22" (no year) → the latest such day not after tomorrow. */
export function jobrightDate(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/)
  const month = m ? MONTHS[m[1].toLowerCase()] : undefined
  if (!m || !month) return null
  const day = Number(m[2])
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() - 1]) {
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCMonth() !== month - 1) return null
    if (d.getTime() <= now.getTime() + 86_400_000) return d.toISOString().slice(0, 10)
  }
  return null
}

const cell = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/** A README → its rows. A "↳" row is the company above's. Rows without a
 *  jobright job id or a title are skipped. */
export function parseJobrightReadme(md: string, now: Date): JobrightListing[] {
  const out: JobrightListing[] = []
  const seen = new Set<string>()
  let company: string | null = null
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell)
    if (cells.length < 5 || /^-+$/.test(cells[0]) || cells[0] === 'Company') continue
    const [co, job, location, model, date] = cells
    const coLink = co.match(LINK)
    if (co !== '↳') company = (coLink ? coLink[1] : co).trim() || null
    const jobLink = job.match(LINK)
    const id = jobLink?.[2].match(/jobright\.ai\/jobs\/info\/([0-9a-f]{24})/)?.[1]
    if (!company || !jobLink || !id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      company: company.slice(0, 120),
      title: jobLink[1].trim().slice(0, 200),
      url: `https://jobright.ai/jobs/info/${id}`,
      location: location.slice(0, 120) || null,
      remote: /remote/i.test(model),
      posted_at: jobrightDate(date, now),
    })
  }
  return out
}

// Words that don't tie a title to a role: levels and the like.
const LOOSE = new Set(['intern', 'internship', 'new', 'grad', 'graduate', 'entry', 'level', 'junior', 'associate', 'summer', 'fall', 'spring', 'co', 'op', 'i', 'ii', '1', '2'])

/** A title shares a word with one of the search's roles ("Clinical Data
 *  Coordinator" for "Data Analyst"; not "Research Fellow"). Looser than
 *  `roleMatches`: the list already is the direction. */
export function touchesRole(roles: string[], title: string): boolean {
  const have = titleWords(title).filter((w) => !LOOSE.has(w))
  return roles.some((role) => titleWords(role).filter((w) => !LOOSE.has(w) && w.length >= 2)
    .some((w) => have.some((h) => h === w || (Math.min(h.length, w.length) >= 4 && (h.startsWith(w) || w.startsWith(h))))))
}

/** The rows worth a lead: posted in the last 30 days, not an excluded company,
 *  a word of one of the search's roles in the title, not a senior title for an
 *  internship or new-grad search, in one of the search's places; newest
 *  first, at most JOBRIGHT_MAX_PER_LIST. */
export function selectJobright(listings: JobrightListing[], brief: SearchBrief, now: Date): JobrightListing[] {
  const cutoff = new Date(now.getTime() - JOBRIGHT_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10)
  const excluded = new Set(brief.exclude_companies.map(companyKey))
  return listings
    .filter((l) => l.posted_at !== null && l.posted_at >= cutoff && !excluded.has(companyKey(l.company)))
    .filter((l) => touchesRole(brief.roles, l.title) && !tooSenior(brief, l.title) && placeMatches(brief, [...(l.location ? [l.location] : []), ...(l.remote ? ['Remote'] : [])]))
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))
    .slice(0, JOBRIGHT_MAX_PER_LIST)
}

/** The posting on the company's own board that is this row: the very same
 *  title (a name-guessed board can be another company's; one with the exact
 *  title is not). Several the same: the newest. */
export function matchBoardPosting(listing: JobrightListing, postings: BoardPosting[]): BoardPosting | null {
  const want = titleKey(listing.title)
  if (!want) return null
  return postings
    .filter((p) => p.listed && titleKey(p.title) === want)
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))[0] ?? null
}

/** A row → a found job: the company's own posting when it was found (its link,
 *  places and dates), else jobright's page. */
export function jobrightToFoundJob(l: JobrightListing, posting: BoardPosting | null = null): FoundJob {
  return {
    company: l.company,
    title: l.title,
    job_url: posting?.url ?? l.url,
    location: (posting?.locations.join('; ') || l.location || '').slice(0, 120) || null,
    posted: posting?.posted_at ?? l.posted_at,
    deadline: posting?.deadline ?? null,
    salary: null,
    sponsorship: null,
    why: null,
  }
}

/** One per jobright job, whichever list it's on: refreshing never adds it twice. */
export const jobrightObservationId = (id: string) => `jobright:${id}`

export function jobrightSourceOf(observationId: string): string | null {
  return observationId.match(/^jobright:([0-9a-f]{24})$/)?.[1] ?? null
}

/** A link that's a listing site's page, not the application: auto apply never
 *  opens it. */
export function isListingPage(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return /(^|\.)jobright\.ai$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}
