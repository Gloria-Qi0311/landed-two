// Job searches: the brief the user set in Workflow → What to look for (data
// store, so it follows local-first like everything else), and which agents on
// which computer search for it. The searches themselves run on that computer
// on the Workflow schedule (lib/automation-sync.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchBrief } from '@landed/schema/search-brief'
import { pickSearchAgents, type Automations } from '@landed/schema/automation'
import { designate, syncTargets } from '../lib/automation-sync'
import { useStore } from '../lib/store'
import { canRun, type Runtime, type RuntimeAgent } from './runtimes'

export type SearchTarget = { runtime: Runtime; agent: RuntimeAgent }

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

/** Who searches: the computer that runs the Workflow schedule (else the
 *  first online one that can search), with the agents ticked under Find new
 *  jobs. */
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

/** Change the search criteria (Workflow page): the edited brief becomes the
 *  active search, and the previous one is archived. */
export function useEditBrief() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (brief: SearchBrief) => store.addJobSearch(brief),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job_searches'] }),
  })
}
