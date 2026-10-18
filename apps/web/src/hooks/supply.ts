// Public job lists and followed companies' boards → Leads (lib/supply.ts,
// lib/boards.ts). Part of "Find new jobs": while that automation is on and
// there's an active search, the open app checks them on start and every few
// hours. The Leads column can check now.
import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { followedBoards, resolveBoards, type FollowedBoard } from '../lib/boards'
import { useStore } from '../lib/store'
import { useSupply } from '../lib/supply'
import { useAutomations } from './automation'
import { useActiveSearch } from './search'

const REFRESH_MS = 6 * 60 * 60_000
const SETTLE_MS = 30_000

/** Check the lists now (null when there's no active search to fit). */
export function useSupplyRefresh() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const search = useActiveSearch()
  const { running, last, error, refresh } = useSupply()
  const brief = search?.brief ?? null
  const run = useCallback(() => {
    if (!ready || !brief) return
    void refresh(store, brief, () => {
      for (const key of ['job_leads', 'followed_boards']) qc.invalidateQueries({ queryKey: [key] })
    })
  }, [ready, brief, refresh, store, qc])
  return { refresh: brief && ready ? run : null, running, last, error }
}

/** Mounted once (App): the automatic refresh, with "Find new jobs" on. */
export function useAutoSupply() {
  const { automations, loaded } = useAutomations()
  const search = useActiveSearch()
  const { refresh } = useSupplyRefresh()
  const on = loaded && automations.job_search.enabled && !!refresh
  const searchId = search?.id ?? null

  // Again when the search changes: a new brief fits other postings. Each
  // criteria edit makes a new search, so wait until the edits settle —
  // checking after the first one (roles only, anywhere) would pull every
  // posting for those roles.
  useEffect(() => {
    if (!on || !refresh) return
    let timer = setTimeout(function tick() {
      refresh()
      timer = setTimeout(tick, REFRESH_MS)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [on, searchId]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The company boards a check looks at (Automation → Find new jobs). */
export function useFollowedBoards() {
  const { store, ready } = useStore()
  const search = useActiveSearch()
  const brief = search?.brief ?? null
  return useQuery({
    queryKey: ['followed_boards', store.kind, search?.id ?? null],
    enabled: ready && !!brief,
    staleTime: 60_000,
    queryFn: async (): Promise<FollowedBoard[]> => {
      const [applications, companies, leads, resolved] = await Promise.all([
        store.listApplications(), store.listCompanies(), store.listJobLeads(), resolveBoards(brief!.include_companies),
      ])
      return followedBoards({ applications, companies, leads, brief: brief!, resolved })
    },
  })
}
