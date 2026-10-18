// Company job boards → found jobs (#91). Greenhouse, Lever and Ashby each
// publish a company's open postings without a login: structured data, the
// posting date and the whole job description, and a posting that closed is
// simply gone from the list. The browser fetches them (docs/leads-model.md:
// never through the server, which would learn which companies a person
// follows); these are the pure parts: which board a link belongs to, the
// URLs, the parsers, and what fits a search.
import { companyKey } from '@landed/observation-processor'
import { parsePostedAt } from '@landed/schema/lead-queue'
import { parseDeadline } from '@landed/schema/pipeline'
import type { FoundJob, SearchBrief } from '@landed/schema/search-brief'
import { placeMatches, roleMatches } from './simplify'

export const ATS = ['greenhouse', 'lever', 'ashby'] as const
export type Ats = typeof ATS[number]
export type Board = { ats: Ats; board: string }

export const ATS_LABELS: Record<Ats, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' }

/** At most this many postings per board become leads per refresh. */
export const MAX_PER_BOARD = 15
/** Descriptions are kept up to this many characters. */
export const MAX_DESCRIPTION = 20_000

export const boardKey = (b: Board) => `${b.ats}:${b.board}`

const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/i

/** The board a job or careers link belongs to: boards.greenhouse.io/{board},
 *  job-boards.greenhouse.io/{board}, …/embed/job_app?for={board},
 *  jobs.lever.co/{company}, jobs.ashbyhq.com/{org}. Company sites that only
 *  carry ?gh_jid= don't name their board: null. */
export function boardFromUrl(raw: string | null | undefined): Board | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const first = url.pathname.split('/').filter(Boolean)[0] ?? ''
  const board = (ats: Ats, slug: string | null) => (slug && SLUG.test(slug) ? { ats, board: slug.toLowerCase() } : null)
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    return first === 'embed' ? board('greenhouse', url.searchParams.get('for')) : board('greenhouse', first)
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) return board('lever', first)
  if (host === 'jobs.ashbyhq.com') return board('ashby', first)
  return null
}

/** Where a board's postings are listed (and, for Greenhouse, where one
 *  posting's description is: its list carries none, to stay small). */
export function boardListUrl(b: Board): string {
  const slug = encodeURIComponent(b.board)
  if (b.ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
  if (b.ats === 'lever') return `https://api.lever.co/v0/postings/${slug}?mode=json`
  return `https://api.ashbyhq.com/posting-api/job-board/${slug}`
}

export function greenhouseJobUrl(board: string, id: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`
}

export type BoardPosting = {
  /** the ATS's own id (Greenhouse number, Lever / Ashby uuid) */
  id: string
  /** null when the board doesn't say (Lever, Ashby) */
  company: string | null
  title: string
  url: string
  locations: string[]
  remote: boolean
  /** "YYYY-MM-DD" */
  posted_at: string | null
  /** apply-by date, "YYYY-MM-DD" */
  deadline: string | null
  /** plain text */
  description: string | null
  /** false for an Ashby posting that's open but not on its board's page:
   *  never a new lead, but not closed either */
  listed: boolean
}

// ── text ───────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** HTML (Greenhouse sends it entity-escaped) → readable plain text. */
export function htmlToText(html: string): string {
  let s = html
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s)
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function longText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return t ? t.slice(0, MAX_DESCRIPTION) : null
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

const isRemote = (s: string) => /\bremote\b/i.test(s)

function posting(p: Omit<BoardPosting, 'remote' | 'listed'> & { remote?: boolean; listed?: boolean }): BoardPosting {
  return { ...p, remote: p.remote ?? p.locations.some(isRemote), listed: p.listed ?? true }
}

// ── parsers: a board's list → its postings (bad rows skipped, never throws) ─

/** GET boards-api.greenhouse.io/v1/boards/{board}/jobs[?content=true] */
export function parseGreenhouseJobs(raw: unknown): BoardPosting[] {
  const jobs = raw && typeof raw === 'object' && Array.isArray((raw as { jobs?: unknown }).jobs) ? (raw as { jobs: unknown[] }).jobs : []
  return jobs.flatMap((j) => {
    const p = parseGreenhouseJob(j)
    return p ? [p] : []
  })
}

/** One Greenhouse posting (also the single-job endpoint, which has content). */
export function parseGreenhouseJob(raw: unknown): BoardPosting | null {
  if (!raw || typeof raw !== 'object') return null
  const j = raw as Record<string, unknown>
  const id = typeof j.id === 'number' || typeof j.id === 'string' ? String(j.id) : ''
  const title = text(j.title, 200)
  const url = httpUrl(j.absolute_url)
  if (!/^\d+$/.test(id) || !title || !url) return null
  const location = text((j.location as { name?: unknown } | null)?.name, 200)
  return posting({
    id, title, url,
    company: text(j.company_name, 120),
    locations: location ? location.split(/\s*[;|]\s*/).filter(Boolean) : [],
    posted_at: parsePostedAt(j.first_published) ?? parsePostedAt(j.updated_at),
    deadline: parseDeadline(j.application_deadline),
    description: typeof j.content === 'string' ? longText(htmlToText(j.content)) : null,
  })
}

/** GET api.lever.co/v0/postings/{company}?mode=json */
export function parseLeverPostings(raw: unknown): BoardPosting[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): BoardPosting[] => {
    if (!item || typeof item !== 'object') return []
    const p = item as Record<string, unknown>
    const id = text(p.id, 80)
    const title = text(p.text, 200)
    const url = httpUrl(p.hostedUrl)
    if (!id || !title || !url) return []
    const cats = (p.categories && typeof p.categories === 'object' ? p.categories : {}) as Record<string, unknown>
    const all = Array.isArray(cats.allLocations) ? cats.allLocations : [cats.location]
    const lists = Array.isArray(p.lists) ? p.lists : []
    const sections = [
      typeof p.descriptionPlain === 'string' ? p.descriptionPlain : '',
      ...lists.map((l) => {
        const list = (l ?? {}) as { text?: unknown; content?: unknown }
        return `${typeof list.text === 'string' ? list.text : ''}\n${typeof list.content === 'string' ? htmlToText(list.content) : ''}`
      }),
      typeof p.additionalPlain === 'string' ? p.additionalPlain : '',
    ]
    return [posting({
      id, title, url,
      company: null,
      locations: all.map((l) => text(l, 120)).filter((l): l is string => !!l),
      remote: p.workplaceType === 'remote' || undefined,
      posted_at: parsePostedAt(p.createdAt),
      deadline: null,
      description: longText(sections.filter((s) => s.trim()).join('\n\n')),
    })]
  })
}

/** GET api.ashbyhq.com/posting-api/job-board/{org}. Unlisted postings are
 *  kept (listed: false): still open, so a lead for one isn't closed. */
export function parseAshbyJobs(raw: unknown): BoardPosting[] {
  const jobs = raw && typeof raw === 'object' && Array.isArray((raw as { jobs?: unknown }).jobs) ? (raw as { jobs: unknown[] }).jobs : []
  return jobs.flatMap((item): BoardPosting[] => {
    if (!item || typeof item !== 'object') return []
    const j = item as Record<string, unknown>
    const id = text(j.id, 80)
    const title = text(j.title, 200)
    const url = httpUrl(j.jobUrl)
    if (!id || !title || !url) return []
    const secondary = Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((l) => text((l as { location?: unknown } | null)?.location, 120)) : []
    return [posting({
      id, title, url,
      company: null,
      locations: [text(j.location, 120), ...secondary].filter((l): l is string => !!l),
      remote: j.isRemote === true || undefined,
      posted_at: parsePostedAt(j.publishedAt),
      deadline: null,
      description: longText(j.descriptionPlain),
      listed: j.isListed !== false,
    })]
  })
}

export function parseBoard(ats: Ats, raw: unknown): BoardPosting[] {
  return ats === 'greenhouse' ? parseGreenhouseJobs(raw) : ats === 'lever' ? parseLeverPostings(raw) : parseAshbyJobs(raw)
}

// ── what fits a search ────────────────────────────────────────────────────

const INTERN = /\bintern(ship)?s?\b|co-?op|实习/
const ENTRY = /new ?grad|graduate|entry|junior|early career|university|campus|校招|应届/
const SENIOR = /\b(senior|sr|staff|principal|lead|manager|director|head|distinguished|architect)\b|资深|高级|主管|经理/

/** A board carries every level (the SimplifyJobs lists only one): an
 *  internship search wants intern / co-op titles, a new-grad or entry search
 *  skips senior, staff, lead and manager titles (and internships, unless it
 *  wants those too). A search that names no level takes any. */
export function levelMatches(brief: SearchBrief, title: string): boolean {
  const said = [brief.seniority ?? '', ...brief.roles].join(' ').toLowerCase()
  const t = title.toLowerCase()
  const intern = INTERN.test(said)
  const entry = ENTRY.test(said)
  if (intern && !entry) return INTERN.test(t)
  if (entry) return !SENIOR.test(t) && (intern || !INTERN.test(t))
  return true
}

/** The postings worth a lead: listed, the brief's roles, level and places
 *  (remote when the brief wants remote); newest first, at most MAX_PER_BOARD. A company
 *  you follow can have an older posting worth seeing, so no age limit. */
export function selectPostings(postings: BoardPosting[], brief: SearchBrief): BoardPosting[] {
  return postings
    .filter((p) => p.listed && roleMatches(brief.roles, p.title) && levelMatches(brief, p.title) && placeMatches(brief, p.remote ? [...p.locations, 'Remote'] : p.locations))
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))
    .slice(0, MAX_PER_BOARD)
}

export function postingToFoundJob(p: BoardPosting, company: string): FoundJob {
  return {
    company: p.company ?? company,
    title: p.title,
    job_url: p.url,
    location: p.locations.join('; ').slice(0, 120) || null,
    posted: p.posted_at,
    deadline: p.deadline,
    salary: null,
    sponsorship: null,
    why: null,
  }
}

/** Stable per posting, so a refresh never adds the same source twice. */
export function boardObservationId(b: Board, postingId: string): string {
  return `ats:${b.ats}:${b.board}:${postingId}`
}

export function boardSourceOf(observationId: string): (Board & { id: string }) | null {
  const m = observationId.match(/^ats:(greenhouse|lever|ashby):([^:]+):(.+)$/)
  return m ? { ats: m[1] as Ats, board: m[2], id: m[3] } : null
}

/** A posting id from a job link, for a board's own links (the processor's
 *  ATS key: Greenhouse number, Lever / Ashby uuid). */
export function postingIdFromAtsKey(atsKey: string | null, ats: Ats): string | null {
  const m = atsKey?.match(/^(greenhouse|lever|ashby):(.+)$/)
  return m && m[1] === ats ? m[2] : null
}

/** Board slugs to try for a company name: "Scale AI" → scaleai, scale-ai, scale. */
export function slugCandidates(name: string): string[] {
  const words = companyKey(name).split(' ').filter((w) => /^[a-z0-9]+$/.test(w))
  if (words.length === 0) return []
  return [...new Set([words.join(''), words.join('-'), words[0]])].filter((s) => SLUG.test(s))
}
