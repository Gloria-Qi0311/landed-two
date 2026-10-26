// Public job sources → Leads (#90, #91; docs/leads-model.md): the
// SimplifyJobs lists here, followed companies' job boards in ./boards.ts.
// The browser fetches the SimplifyJobs lists itself (never through the server), keeps what fits
// the active search (packages/supply) and ingests it like any agent's finds,
// so a posting an agent also found is one lead with both sources. Then every
// lead a list made gets its posting date, and closed_at once the list marks
// the posting closed (closed leads leave the Leads column; the data stays).
//
// Lives in a store, not a component: the automatic refresh (useAutoSupply)
// and the Leads column's button share one run. Each source's result is kept
// on the search (job_searches.source_runs): its schedule counts from it, and
// Workflow shows what it found.
import { create } from 'zustand'
import type { PublicSource, SourceRun, SourceRuns } from '@landed/schema/automation'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  listsForBrief, parseSimplifyListings, selectForBrief, simplifyObservationId, simplifySourceOf, SIMPLIFY_LISTS, toFoundJob,
  type SimplifyList, type SimplifyListing,
} from '@landed/supply'
import { followedBoards, refreshBoards, resolveBoards } from './boards'
import { ingestFoundJobs } from './inbox'
import { screenLeads } from './screen'
import { scoreLeads } from './fit'
import type { DataStore, DbJobLead } from './store/types'

export type SupplyResult = {
  lists: SimplifyList[]
  /** postings that fit the search */
  found: number
  added: number
  merged: number
  /** leads whose posting closed since the last refresh */
  closed: number
  /** lists that couldn't be fetched or read */
  failed: SimplifyList[]
  at: string
}

/** A whole check: the lists, then the followed companies' boards. */
export type SupplyCheck = SupplyResult & {
  /** company boards checked */
  boards: number
  /** "greenhouse:acme" for boards that couldn't be fetched */
  boards_failed: string[]
  /** what each source that ran found, to keep on the search */
  runs: SourceRuns
}

const sourceRun = (r: { found: number; added: number; merged: number; closed: number }, at: string, checked: number, failed: number): SourceRun =>
  ({ at, found: r.found, added: r.added, merged: r.merged, closed: r.closed, checked, failed })

export async function refreshSupply(
  store: DataStore,
  brief: SearchBrief,
  opts: { fetchFn?: typeof fetch; now?: Date; sources?: { job_lists: boolean; company_boards: boolean } } = {},
): Promise<SupplyCheck> {
  // Find new jobs → Search with: either source can be left out.
  const now = opts.now ?? new Date()
  const lists = opts.sources?.job_lists === false
    ? { lists: [], found: 0, added: 0, merged: 0, closed: 0, failed: [], at: now.toISOString() }
    : await refreshSimplify(store, brief, opts)
  const runs: SourceRuns = {}
  if (opts.sources?.job_lists !== false) runs.job_lists = sourceRun(lists, now.toISOString(), lists.lists.length, lists.failed.length)
  if (opts.sources?.company_boards === false) return { ...lists, boards: 0, boards_failed: [], runs }
  const [applications, companies, leads, resolved] = await Promise.all([
    store.listApplications(), store.listCompanies(), store.listJobLeads(), resolveBoards(brief.include_companies, opts.fetchFn),
  ])
  const boards = followedBoards({ applications, companies, leads, brief, resolved })
  const b = await refreshBoards(store, brief, boards, opts)
  runs.company_boards = sourceRun(b, now.toISOString(), b.boards, b.failed.length)
  await screenLeads(store)
  await scoreLeads(store, opts.now)
  return {
    ...lists,
    found: lists.found + b.found, added: lists.added + b.added, merged: lists.merged + b.merged, closed: lists.closed + b.closed,
    boards: b.boards, boards_failed: b.failed, runs,
  }
}

/** Lead patches from what the lists now say: posting dates, and closed_at
 *  for postings they mark closed or no longer carry. Only lists that were
 *  fetched this time count, and a lead is only closed, never reopened. */
export function simplifyLeadUpdates(leads: DbJobLead[], byList: Map<SimplifyList, Map<string, SimplifyListing>>, now: Date) {
  const updates: { id: string; patch: Partial<Pick<DbJobLead, 'posted_at' | 'closed_at'>> }[] = []
  for (const lead of leads) {
    const from = lead.sources.map((s) => simplifySourceOf(s.observation_id)).find((src) => src && byList.has(src.list))
    if (!from) continue
    const listing = byList.get(from.list)!.get(from.id)
    const patch: Partial<Pick<DbJobLead, 'posted_at' | 'closed_at'>> = {}
    if (!lead.posted_at && listing?.posted_at) patch.posted_at = listing.posted_at
    if (!lead.closed_at && !listing?.active) patch.closed_at = now.toISOString()
    if (Object.keys(patch).length) updates.push({ id: lead.id, patch })
  }
  return updates
}

export async function refreshSimplify(
  store: DataStore,
  brief: SearchBrief,
  { fetchFn = fetch, now = new Date() }: { fetchFn?: typeof fetch; now?: Date } = {},
): Promise<SupplyResult> {
  const lists = listsForBrief(brief)
  const result: SupplyResult = { lists, found: 0, added: 0, merged: 0, closed: 0, failed: [], at: now.toISOString() }
  const byList = new Map<SimplifyList, Map<string, SimplifyListing>>()
  for (const list of lists) {
    let listings: SimplifyListing[]
    try {
      // The browser's HTTP cache revalidates (ETag), so an unchanged list is a 304.
      const res = await fetchFn(SIMPLIFY_LISTS[list].url, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      listings = parseSimplifyListings(await res.json())
      if (listings.length === 0) throw new Error('no listings')
    } catch (e) {
      console.warn(`[landed] ${SIMPLIFY_LISTS[list].label} unavailable`, e)
      result.failed.push(list)
      continue
    }
    byList.set(list, new Map(listings.map((l) => [l.id, l])))
    const picked = selectForBrief(listings, brief, now)
    const r = await ingestFoundJobs(store, picked.map(toFoundJob), { run_id: `simplify:${list}`, runtime_id: 'simplify', agent: SIMPLIFY_LISTS[list].label }, {
      observationIds: picked.map((l) => simplifyObservationId(list, l.id)),
      connectionId: 'supply:simplify',
    })
    result.found += picked.length
    result.added += r.added
    result.merged += r.merged
  }
  for (const { id, patch } of simplifyLeadUpdates(await store.listJobLeads(), byList, now)) {
    await store.updateJobLead(id, patch)
    if (patch.closed_at) result.closed++
  }
  return result
}

type State = {
  running: boolean
  last: SupplyCheck | null
  error: string | null
  /** Check `sources` for the search; `onData(leadsChanged)` once it's kept. */
  refresh: (store: DataStore, search: { id: string; brief: SearchBrief }, onData: (leadsChanged: boolean) => void, sources: Record<PublicSource, boolean>) => Promise<void>
}

export const useSupply = create<State>((set, get) => ({
  running: false,
  last: null,
  error: null,
  async refresh(store, search, onData, sources) {
    if (get().running || (!sources.job_lists && !sources.company_boards)) return
    set({ running: true, error: null })
    try {
      const last = await refreshSupply(store, search.brief, { sources })
      set({ last })
      // A source that couldn't be reached at all isn't kept, so it's tried
      // again. An archived search (the criteria changed meanwhile) keeps it
      // too: harmless.
      const kept = Object.fromEntries(Object.entries(last.runs).filter(([, r]) => r.checked === 0 || r.failed < r.checked))
      if (Object.keys(kept).length) await store.updateJobSearch(search.id, { source_runs: kept })
      onData(last.added + last.merged + last.closed > 0)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ running: false })
    }
  },
}))
