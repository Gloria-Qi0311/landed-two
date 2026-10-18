// Public job lists → Leads (lib/supply.ts). Part of "Find new jobs": while
// that automation is on and there's an active search, the open app checks
// the lists on start and every few hours. The Leads column can check now.
import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
    void refresh(store, brief, () => qc.invalidateQueries({ queryKey: ['job_leads'] }))
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
