// Company job boards → Leads (#91; docs/leads-model.md). The companies a
// person follows are worked out in the browser and never leave it: the
// boards of companies they applied to, leads they approved (moved into the
// queue), and the brief's "Look at first" companies (whose board is found by
// trying a few slugs on each ATS). "Skip" removes a company. Each board's
// postings that fit the search are ingested like any agent's finds; a
// posting that was on its board and is gone now gets closed_at.
import { companyKey } from '@landed/observation-processor'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  ATS, ATS_LABELS, boardFromUrl, boardKey, boardListUrl, boardObservationId, boardSourceOf, greenhouseJobUrl, parseBoard,
  parseGreenhouseJob, postingIdFromAtsKey, postingToFoundJob, selectPostings, slugCandidates, type Board, type BoardPosting,
} from '@landed/supply'
import { ingestFoundJobs } from './inbox'
import type { DataStore, DbApplication, DbCompany, DbJobLead } from './store/types'

/** At most this many boards are checked per refresh. */
export const MAX_BOARDS = 25
const CONCURRENCY = 4

export type FollowedBoard = Board & {
  company: string
  /** why it's followed */
  from: 'search' | 'application' | 'lead'
}

/** Map with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

/** The boards to check: "Look at first" companies (resolved), then
 *  applications (newest first), then approved leads; Skip'd companies out;
 *  one entry per board, at most MAX_BOARDS. */
export function followedBoards(
  { applications, companies, leads, brief, resolved }:
  { applications: DbApplication[]; companies: DbCompany[]; leads: DbJobLead[]; brief: SearchBrief; resolved: Map<string, Board | null> },
): FollowedBoard[] {
  const skip = new Set(brief.exclude_companies.map(companyKey))
  const nameOf = new Map(companies.map((c) => [c.id, c.name]))
  const candidates: FollowedBoard[] = []
  for (const name of brief.include_companies) {
    const board = resolved.get(companyKey(name))
    if (board) candidates.push({ ...board, company: name, from: 'search' })
  }
  for (const app of [...applications].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const board = boardFromUrl(app.portal_application_url)
    if (board) candidates.push({ ...board, company: nameOf.get(app.company_id) ?? board.board, from: 'application' })
  }
  for (const lead of [...leads].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))) {
    if (lead.status !== 'saved' || lead.closed_at) continue
    const board = boardFromUrl(lead.job_url)
    if (board) candidates.push({ ...board, company: lead.company_name, from: 'lead' })
  }
  const seen = new Set<string>()
  return candidates.filter((b) => {
    const key = boardKey(b)
    if (seen.has(key) || skip.has(companyKey(b.company))) return false
    seen.add(key)
    return true
  }).slice(0, MAX_BOARDS)
}

// "Look at first" names → boards, tried once per session.
const resolvedNames = new Map<string, Board | null>()

/** Find each named company's public board: its slugs on Greenhouse, Lever
 *  and Ashby, first that answers. Unknown → null (remembered this session). */
export async function resolveBoards(names: string[], fetchFn: typeof fetch = fetch): Promise<Map<string, Board | null>> {
  const todo = [...new Set(names.map(companyKey))].filter((k) => k && !resolvedNames.has(k))
  await mapLimit(todo, CONCURRENCY, async (key) => {
    for (const slug of slugCandidates(key)) {
      for (const ats of ATS) {
        try {
          const res = await fetchFn(boardListUrl({ ats, board: slug }), { cache: 'force-cache' })
          if (res.ok && parseBoard(ats, await res.json()).length > 0) {
            resolvedNames.set(key, { ats, board: slug })
            return
          }
        } catch { /* not this one */ }
      }
    }
    resolvedNames.set(key, null)
  })
  return resolvedNames
}

export function forgetResolvedBoards() {
  resolvedNames.clear()
}

export type BoardsResult = { boards: number; found: number; added: number; merged: number; closed: number; failed: string[] }

/** Which board a lead's posting is on, and its id there: from the source a
 *  board fetch gave it, else from its own link (an agent found it there). */
function postingOf(lead: DbJobLead): (Board & { id: string }) | null {
  for (const s of lead.sources) {
    const src = boardSourceOf(s.observation_id)
    if (src) return src
  }
  const board = boardFromUrl(lead.job_url)
  const id = board && postingIdFromAtsKey(lead.ats_key, board.ats)
  return board && id ? { ...board, id } : null
}

export async function refreshBoards(
  store: DataStore,
  brief: SearchBrief,
  boards: FollowedBoard[],
  { fetchFn = fetch, now = new Date() }: { fetchFn?: typeof fetch; now?: Date } = {},
): Promise<BoardsResult> {
  const result: BoardsResult = { boards: boards.length, found: 0, added: 0, merged: 0, closed: 0, failed: [] }
  const fetched = new Map<string, Map<string, BoardPosting>>()
  const lists = await mapLimit(boards, CONCURRENCY, async (b) => {
    try {
      const res = await fetchFn(boardListUrl(b), { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.json()
      const postings = parseBoard(b.ats, raw)
      // An empty board is fine; a body that isn't a board at all is not.
      if (postings.length === 0 && !(Array.isArray(raw) || Array.isArray((raw as { jobs?: unknown } | null)?.jobs))) throw new Error('not a job board')
      return postings
    } catch (e) {
      console.warn(`[landed] ${ATS_LABELS[b.ats]} board ${b.board} unavailable`, e)
      result.failed.push(boardKey(b))
      return null
    }
  })

  for (const [i, b] of boards.entries()) {
    const postings = lists[i]
    if (!postings) continue
    fetched.set(boardKey(b), new Map(postings.map((p) => [p.id, p])))
    let picked = selectPostings(postings, brief)
    // Greenhouse lists carry no description (they'd be MBs); fetch the ones we keep.
    if (b.ats === 'greenhouse') {
      picked = await mapLimit(picked, CONCURRENCY, async (p) => {
        try {
          const res = await fetchFn(greenhouseJobUrl(b.board, p.id), { cache: 'force-cache' })
          const full = res.ok ? parseGreenhouseJob(await res.json()) : null
          return full ? { ...p, description: full.description } : p
        } catch {
          return p
        }
      })
    }
    const r = await ingestFoundJobs(store, picked.map((p) => postingToFoundJob(p, b.company)), {
      run_id: `board:${boardKey(b)}`, runtime_id: 'boards', agent: `${ATS_LABELS[b.ats]} · ${b.company}`,
    }, {
      observationIds: picked.map((p) => boardObservationId(b, p.id)),
      connectionId: 'supply:boards',
      descriptions: picked.map((p) => p.description),
    })
    result.found += picked.length
    result.added += r.added
    result.merged += r.merged
  }

  // Posting dates, and closed_at for postings gone from a board fetched now.
  for (const lead of await store.listJobLeads()) {
    const at = postingOf(lead)
    const board = at && fetched.get(boardKey(at))
    if (!at || !board) continue
    const posting = board.get(at.id)
    const patch: Partial<Pick<DbJobLead, 'posted_at' | 'closed_at'>> = {}
    if (!lead.posted_at && posting?.posted_at) patch.posted_at = posting.posted_at
    if (!lead.closed_at && !posting) patch.closed_at = now.toISOString()
    if (Object.keys(patch).length === 0) continue
    await store.updateJobLead(lead.id, patch)
    if (patch.closed_at) result.closed++
  }
  return result
}
