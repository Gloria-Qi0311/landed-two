// Job searches: the brief the user confirmed on the Agent page (data store, so it
// follows local-first like everything else), and the runner that searches
// with their agents (lib/job-search.ts).
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchBrief } from '@landed/schema/search-brief'
import { pickSearchAgents, type Automations } from '@landed/schema/automation'
import { useAuth } from '../lib/auth'
import { designate, syncTargets } from '../lib/automation-sync'
import { useJobSearch, type SearchTarget } from '../lib/job-search'
import { useStore } from '../lib/store'
import { canRun, type Runtime } from './runtimes'

const AFFECTED = ['job_searches', 'job_leads', 'applications']

export function useJobSearches() {
  const { store, ready } = useStore()
  return useQuery({ queryKey: ['job_searches', store.kind], enabled: ready, queryFn: () => store.listJobSearches() })
}

export function useActiveSearch() {
  return useJobSearches().data?.find((s) => s.status === 'active') ?? null
}

/** Every agent on an online computer that can run searches. */
export function searchTargets(runtimes: Runtime[] | undefined): SearchTarget[] {
  return (runtimes ?? [])
    .filter((r) => r.online && !r.revoked_at)
    .flatMap((runtime) => runtime.agents.filter((a) => canRun(a, 'job_search')).map((agent) => ({ runtime, agent })))
}

/** Who searches now (Run now, "Save & search now"): the computer that runs
 *  the Workflow schedule (else the first online one that can search),
 *  with the agents chosen under Find new jobs → Search with, so a search
 *  now and the scheduled one use the same agents. */
export function chosenSearchTargets(runtimes: Runtime[] | undefined, automations: Automations): SearchTarget[] {
  const here = searchComputer(runtimes, automations)
  if (here.length === 0) return []
  const picked = pickSearchAgents(here.map((t) => t.agent), automations.job_search.sources)
  return here.filter((t) => picked.includes(t.agent))
}

/** The agents that could search on that computer (the Search with choices). */
export function searchComputer(runtimes: Runtime[] | undefined, automations: Automations): SearchTarget[] {
  const all = searchTargets(runtimes)
  if (all.length === 0) return []
  const on = { ...automations, job_search: { ...automations.job_search, enabled: true } }
  const designated = designate(syncTargets(runtimes ?? []), on)?.runtime.id
  const id = designated && all.some((t) => t.runtime.id === designated) ? designated : all[0].runtime.id
  return all.filter((t) => t.runtime.id === id)
}

/** Online, but every daemon predates searching (needs a restart to update). */
export function needsDaemonUpdate(runtimes: Runtime[] | undefined) {
  const online = (runtimes ?? []).filter((r) => r.online && !r.revoked_at && r.agents.length > 0)
  return online.length > 0 && searchTargets(runtimes).length === 0
}

/** Confirm a brief (it becomes the active search) and start searching. */
/** Change the search criteria in place (Workflow page): the edited brief
 *  becomes the active search, and the previous one is archived — the same
 *  as confirming a new brief in the chat. */
export function useEditBrief() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (brief: SearchBrief) => store.addJobSearch(brief),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job_searches'] }),
  })
}

export function useStartSearch() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async ({ brief, existingId, targets }: { brief: SearchBrief; existingId?: string; targets: SearchTarget[] }) => {
      const searches = await store.listJobSearches()
      const search = searches.find((s) => s.id === existingId) ?? (await store.addJobSearch(brief))
      qc.invalidateQueries({ queryKey: ['job_searches'] })
      await useJobSearch.getState().start(search, targets)
      return search
    },
  })
}

/** Mount once below the login gate: lets searches finish (and resume after
 *  a reload) wherever the user is in the app. */
export function useSearchRunner() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const userId = useAuth((s) => s.user?.id)
  useEffect(() => {
    if (!ready || !userId) return
    useJobSearch.getState().bind(userId, {
      store,
      onData: () => AFFECTED.forEach((key) => qc.invalidateQueries({ queryKey: [key] })),
    })
  }, [ready, userId, store, qc])
}
