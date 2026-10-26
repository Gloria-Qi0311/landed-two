// Public job lists and followed companies' boards → Leads (lib/supply.ts,
// lib/boards.ts). Part of "Find new jobs": while that automation is on and
// there's an active search, the open app checks each source on its own
// schedule (Workflow → Job lists / Company boards), and a new search right
// away. The Leads column and Run now check both now.
import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { dueSources } from '@landed/schema/automation'
import { followedBoards, resolveBoards, type FollowedBoard } from '../lib/boards'
import { putBack, screenLeads } from '../lib/screen'
import { scoreLeads } from '../lib/fit'
import type { DbJobLead } from '../lib/store/types'
import { useApplicationAnswers } from './answers'
import { useJobLeads } from './inbox'
import { useResumes } from './resumes'
import { useStore } from '../lib/store'
import { useSupply } from '../lib/supply'
import { useAutomations } from './automation'
import { useActiveSearch, useJobSearches } from './search'

/** How often the open app looks at what's due. */
const TICK_MS = 60_000
/** Each criteria edit makes a new search: wait until the edits settle. */
const SETTLE_MS = 30_000
/** A check that couldn't reach a source isn't kept, so it's tried again: not sooner than this. */
const RETRY_MS = 15 * 60_000

function afterCheck(qc: QueryClient, leadsChanged: boolean) {
  qc.invalidateQueries({ queryKey: ['job_searches'] })
  if (leadsChanged) for (const key of ['job_leads', 'followed_boards']) qc.invalidateQueries({ queryKey: [key] })
}

/** Check the lists now (null when there's no active search to fit). */
export function useSupplyRefresh() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const search = useActiveSearch()
  const { running, last, error, refresh } = useSupply()
  const sources = useAutomations().automations.job_search.sources
  const lists = sources?.job_lists !== false
  const boards = sources?.company_boards !== false
  const run = useCallback(() => {
    if (!ready || !search) return
    void refresh(store, search, (changed) => afterCheck(qc, changed), { job_lists: lists, company_boards: boards })
  }, [ready, search, refresh, store, qc, lists, boards])
  return { refresh: search && ready && (lists || boards) ? run : null, running, last, error }
}

/** Mounted once (App): the automatic checks, with "Find new jobs" on. */
export function useAutoSupply() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { automations, loaded } = useAutomations()
  const search = useActiveSearch()
  const refresh = useSupply((s) => s.refresh)
  const on = loaded && ready && automations.job_search.enabled && !!search
  const searchId = search?.id ?? null
  // The tick reads the latest settings and runs, not the ones it started with.
  const latest = useRef({ search, sources: automations.job_search.sources })
  latest.current = { search, sources: automations.job_search.sources }

  // A new search (a new brief fits other postings) has no runs yet, so both
  // sources are due once its edits settle — checking after the first edit
  // (roles only, anywhere) would pull every posting for those roles.
  useEffect(() => {
    if (!on) return
    let tried = 0
    let timer = setTimeout(function tick() {
      const { search: s, sources } = latest.current
      if (s && sources && Date.now() - tried >= RETRY_MS) {
        const due = dueSources(sources, s.source_runs)
        if (due.job_lists || due.company_boards) {
          tried = Date.now()
          void refresh(store, s, (changed) => afterCheck(qc, changed), due)
        }
      }
      timer = setTimeout(tick, TICK_MS)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [on, searchId, store]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The company boards a check looks at (Workflow → Find new jobs). */
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

/** Mounted once (App): screen and score the Leads (lib/screen.ts,
 *  lib/fit.ts) when they, the resumes, the saved answers or the search
 *  change. Writes only what changed, so it settles after one pass. */
export function useLeadScreening() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const leads = useJobLeads()
  const resumes = useResumes()
  const answers = useApplicationAnswers()
  const searches = useJobSearches()
  useEffect(() => {
    if (!ready || !leads.data || !resumes.data || answers.isLoading || !searches.data) return
    let cancelled = false
    Promise.all([screenLeads(store), scoreLeads(store)]).then(([screened, scored]) => screened + scored).then((changed) => {
      if (!cancelled && changed > 0) qc.invalidateQueries({ queryKey: ['job_leads'] })
    }, (e) => console.warn('[landed] screening leads failed', e))
    return () => { cancelled = true }
  }, [ready, store, qc, leads.dataUpdatedAt, resumes.dataUpdatedAt, answers.dataUpdatedAt, searches.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePutBack() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (lead: DbJobLead) => putBack(store, lead),
    onSettled: () => qc.invalidateQueries({ queryKey: ['job_leads'] }),
  })
}
