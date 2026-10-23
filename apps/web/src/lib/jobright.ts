// jobright-ai's lists → Leads (#138; packages/supply/src/jobright.ts). Part of
// Find jobs → Job lists, next to the SimplifyJobs lists: the browser fetches
// the README of each list the search's directions and level want, keeps the
// rows that fit, and ingests them like any other source.
//
// jobright gives its own page, never the application. A new row whose
// company's Greenhouse, Lever or Ashby board (found by name, ./boards.ts) has
// a posting with the very same title takes that posting: its link, places,
// dates and description. The others keep the jobright.ai link, and auto apply
// skips them (apply-batch.ts, `isListingPage`).
//
// Closed: a row gone from the README hasn't closed (it keeps a few days). A
// lead on its company's posting closes when the board no longer lists it; one
// on the jobright link, 30 days after it was posted (jobright's `validThrough`).
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  boardFromUrl, boardKey, boardListUrl, greenhouseJobUrl, isListingPage, JOBRIGHT_DIRECTIONS, JOBRIGHT_MAX_AGE_DAYS,
  jobrightListsForBrief, jobrightObservationId, jobrightSourceOf, jobrightToFoundJob, jobrightUrl, matchBoardPosting, parseBoard,
  parseGreenhouseJob, parseJobrightReadme, postingIdFromAtsKey, selectJobright, type Board, type BoardPosting, type JobrightListing,
} from '@landed/supply'
import { companyKey } from '@landed/observation-processor'
import { resolveBoards } from './boards'
import { ingestFoundJobs } from './inbox'
import type { DataStore, DbJobLead } from './store/types'

export type JobrightResult = {
  /** repos read, e.g. "2026-Data-Analysis-New-Grad" */
  lists: string[]
  failed: string[]
  found: number
  added: number
  merged: number
  closed: number
  /** new leads that got their company's own posting */
  linked: number
}

/** Companies whose boards are looked for in one refresh (each name tries a
 *  few slugs on three ATSs; remembered for the session). */
export const MAX_COMPANIES_PER_REFRESH = 25

export async function refreshJobright(
  store: DataStore,
  brief: SearchBrief,
  { fetchFn = fetch, now = new Date() }: { fetchFn?: typeof fetch; now?: Date } = {},
): Promise<JobrightResult> {
  const wanted = jobrightListsForBrief(brief)
  const result: JobrightResult = { lists: wanted.map((l) => l.repo), failed: [], found: 0, added: 0, merged: 0, closed: 0, linked: 0 }
  if (wanted.length === 0) return result

  // 1. The rows that fit, from every list (a job on two lists is one row).
  const picked = new Map<string, { row: JobrightListing; list: string }>()
  for (const list of wanted) {
    let rows: JobrightListing[]
    try {
      const res = await fetchFn(jobrightUrl(list.repo), { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      rows = parseJobrightReadme(await res.text(), now)
      if (rows.length === 0) throw new Error('no rows')
    } catch (e) {
      console.warn(`[landed] jobright ${list.repo} unavailable`, e)
      result.failed.push(list.repo)
      continue
    }
    const label = `jobright · ${JOBRIGHT_DIRECTIONS[list.direction].label}${list.level === 'internships' ? ' internships' : ' new grad'}`
    for (const row of selectJobright(rows, brief, now)) if (!picked.has(row.id)) picked.set(row.id, { row, list: label })
  }

  // 2. Only rows that aren't a lead yet: their company's own posting, if any.
  const leads = await store.listJobLeads()
  const known = new Set(leads.flatMap((l) => l.sources.map((s) => jobrightSourceOf(s.observation_id)).filter(Boolean)))
  const fresh = [...picked.values()].filter(({ row }) => !known.has(row.id))
  result.found = picked.size
  const boards = new Map<string, BoardPosting[] | null>()
  const listOf = async (b: Board) => {
    const key = boardKey(b)
    if (!boards.has(key)) {
      try {
        const res = await fetchFn(boardListUrl(b), { cache: 'no-cache' })
        boards.set(key, res.ok ? parseBoard(b.ats, await res.json()) : null)
      } catch {
        boards.set(key, null)
      }
    }
    return boards.get(key) ?? null
  }
  const names = [...new Set(fresh.map(({ row }) => row.company))].slice(0, MAX_COMPANIES_PER_REFRESH)
  const resolved = await resolveBoards(names, fetchFn)
  const postings: (BoardPosting | null)[] = []
  for (const { row } of fresh) {
    const board = names.includes(row.company) ? resolved.get(companyKey(row.company)) : null
    const list = board ? await listOf(board) : null
    let posting = list ? matchBoardPosting(row, list) : null
    // Greenhouse lists carry no description; fetch the one we keep.
    if (posting && board?.ats === 'greenhouse' && !posting.description) {
      try {
        const res = await fetchFn(greenhouseJobUrl(board.board, posting.id), { cache: 'force-cache' })
        const full = res.ok ? parseGreenhouseJob(await res.json()) : null
        if (full) posting = { ...posting, description: full.description }
      } catch { /* the lead goes in without it */ }
    }
    postings.push(posting)
  }
  result.linked = postings.filter(Boolean).length

  // 3. In, like any source: one observation id per jobright job.
  const byList = new Map<string, number[]>()
  fresh.forEach(({ list }, i) => byList.set(list, [...(byList.get(list) ?? []), i]))
  for (const [agent, idx] of byList) {
    const r = await ingestFoundJobs(store, idx.map((i) => jobrightToFoundJob(fresh[i].row, postings[i])), {
      run_id: 'jobright', runtime_id: 'jobright', agent,
    }, {
      observationIds: idx.map((i) => jobrightObservationId(fresh[i].row.id)),
      connectionId: 'supply:jobright',
      descriptions: idx.map((i) => postings[i]?.description ?? null),
    })
    result.added += r.added
    result.merged += r.merged
  }

  // 4. Posting dates (from the row, or its company's posting), then closed:
  //    on its company's posting, when the board no longer lists it; on
  //    jobright's page, 30 days after it was posted.
  const posted = new Map(fresh.map(({ row }, i) => [row.id, postings[i]?.posted_at ?? row.posted_at]))
  for (const { row } of picked.values()) if (!posted.has(row.id)) posted.set(row.id, row.posted_at)
  for (const lead of await store.listJobLeads()) {
    const id = lead.sources.map((s) => jobrightSourceOf(s.observation_id)).find(Boolean)
    const date = id ? posted.get(id) : null
    if (id && !lead.posted_at && date) await store.updateJobLead(lead.id, { posted_at: date })
  }
  for (const { id, patch } of await jobrightClosures(await store.listJobLeads(), listOf, now)) {
    await store.updateJobLead(id, patch)
    result.closed++
  }
  return result
}

/** Which jobright leads closed: those on their company's posting whose board
 *  no longer lists it (a board that couldn't be fetched says nothing), and
 *  those on jobright's page posted (else first seen) more than 30 days ago. */
export async function jobrightClosures(
  leads: DbJobLead[],
  listOf: (b: Board) => Promise<BoardPosting[] | null>,
  now: Date,
): Promise<{ id: string; patch: Pick<DbJobLead, 'closed_at'> }[]> {
  const out: { id: string; patch: Pick<DbJobLead, 'closed_at'> }[] = []
  const expired = new Date(now.getTime() - JOBRIGHT_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const lead of leads) {
    if (lead.closed_at || !lead.sources.some((s) => jobrightSourceOf(s.observation_id))) continue
    if (isListingPage(lead.job_url)) {
      // No posting date known (it left the table first): from when Landed first saw it.
      const since = lead.posted_at ?? lead.first_seen_at.slice(0, 10)
      if (since < expired) out.push({ id: lead.id, patch: { closed_at: now.toISOString() } })
      continue
    }
    const board = boardFromUrl(lead.job_url)
    const postingId = board && postingIdFromAtsKey(lead.ats_key, board.ats)
    if (!board || !postingId) continue
    const list = await listOf(board)
    if (list && !list.some((p) => p.id === postingId)) out.push({ id: lead.id, patch: { closed_at: now.toISOString() } })
  }
  return out
}

