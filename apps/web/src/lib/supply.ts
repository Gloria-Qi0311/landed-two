// Public job lists → Leads (#90; docs/leads-model.md). The browser fetches
// the SimplifyJobs lists itself (never through the server), keeps what fits
// the active search (packages/supply) and ingests it like any agent's finds,
// so a posting an agent also found is one lead with both sources. Then every
// lead a list made gets its posting date, and closed_at once the list marks
// the posting closed (closed leads leave the Leads column; the data stays).
//
// Lives in a store, not a component: the automatic refresh (useAutoSupply)
// and the Leads column's button share one run.
import { create } from 'zustand'
import type { SearchBrief } from '@landed/schema/search-brief'
import {
  listsForBrief, parseSimplifyListings, selectForBrief, simplifyObservationId, simplifySourceOf, SIMPLIFY_LISTS, toFoundJob,
  type SimplifyList, type SimplifyListing,
} from '@landed/supply'
import { ingestFoundJobs } from './inbox'
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
  last: SupplyResult | null
  error: string | null
  refresh: (store: DataStore, brief: SearchBrief, onData: () => void) => Promise<void>
}

export const useSupply = create<State>((set, get) => ({
  running: false,
  last: null,
  error: null,
  async refresh(store, brief, onData) {
    if (get().running) return
    set({ running: true, error: null })
    try {
      const last = await refreshSimplify(store, brief)
      set({ last })
      if (last.added + last.merged + last.closed > 0) onData()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ running: false })
    }
  },
}))
