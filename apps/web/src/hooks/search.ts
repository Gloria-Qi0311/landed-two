// Job searches: the brief the user confirmed in Ask Agent (data store, so it
// follows local-first like everything else), and the runner that searches
// with their agents (lib/job-search.ts).
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchBrief } from '@landed/schema/search-brief'
import { useAuth } from '../lib/auth'
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

/** Online, but every daemon predates searching (needs a restart to update). */
export function needsDaemonUpdate(runtimes: Runtime[] | undefined) {
  const online = (runtimes ?? []).filter((r) => r.online && !r.revoked_at && r.agents.length > 0)
  return online.length > 0 && searchTargets(runtimes).length === 0
}

/** Confirm a brief (it becomes the active search) and start searching. */
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
