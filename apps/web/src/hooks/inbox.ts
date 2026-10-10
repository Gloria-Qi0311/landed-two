// Hooks for the observation processor's output: the job-leads list, the
// review queue, the account preference that governs auto-adding, and the
// background runner that turns new agent reports into those.
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  acceptSuggestion, addLeadToPipeline, dismissLead, processPending, rejectSuggestion, restoreLead, undoSuggestion,
} from '../lib/inbox'
import { useStore, type DbJobLead, type DbSuggestion } from '../lib/store'

const RUN_INTERVAL_MS = 30_000
/** Fired by useAgentRelay when new observations land in this browser. */
export const OBSERVATIONS_ARRIVED = 'landed:observations-arrived'

const AFFECTED = ['job_leads', 'suggestions', 'applications', 'companies', 'portal_events', 'agent_observations']

export function useJobLeads() {
  const { store, ready } = useStore()
  return useQuery({ queryKey: ['job_leads', store.kind], enabled: ready, queryFn: () => store.listJobLeads() })
}

export function useSuggestions() {
  const { store, ready } = useStore()
  return useQuery({ queryKey: ['suggestions', store.kind], enabled: ready, queryFn: () => store.listSuggestions() })
}

type Me = { auto_add_applications: boolean; onboarded_at: string | null; created_at: string }

export function useAccountPrefs() {
  const online = useAuth((s) => s.ready && !s.offline && !s.unreachable)
  return useQuery({ queryKey: ['profile', 'me'], enabled: online, queryFn: () => api.get<Me>('/me') })
}

export function useSetAutoAdd() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (on: boolean) => api.patch<Me>('/me', { auto_add_applications: on }),
    onSuccess: (me) => qc.setQueryData(['profile', 'me'], me),
  })
}

/** Process new agent reports in the background while Landed is open. */
export function useObservationProcessor() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const autoAdd = useAccountPrefs().data?.auto_add_applications ?? false

  useEffect(() => {
    if (!ready) return
    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        const handled = await processPending(store, { autoAddApplications: autoAdd })
        if (handled > 0) for (const key of AFFECTED) qc.invalidateQueries({ queryKey: [key] })
      } catch (e) {
        console.warn('[landed] processing agent reports failed', e)
      } finally {
        running = false
      }
    }
    void run()
    const timer = setInterval(run, RUN_INTERVAL_MS)
    window.addEventListener(OBSERVATIONS_ARRIVED, run)
    window.addEventListener('focus', run)
    return () => {
      clearInterval(timer)
      window.removeEventListener(OBSERVATIONS_ARRIVED, run)
      window.removeEventListener('focus', run)
    }
  }, [store, ready, autoAdd, qc])
}

function useInvalidating<T>(fn: (input: T) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      for (const key of AFFECTED) qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

export function useLeadActions() {
  const { store } = useStore()
  return {
    add: useInvalidating(({ lead, stage }: { lead: DbJobLead; stage: 'saved' | 'applied' }) => addLeadToPipeline(store, lead, stage)),
    dismiss: useInvalidating((id: string) => dismissLead(store, id)),
    restore: useInvalidating((id: string) => restoreLead(store, id)),
  }
}

export function useSuggestionActions() {
  const { store } = useStore()
  return {
    accept: useInvalidating(async ({ s, applicationId }: { s: DbSuggestion; applicationId?: string }) =>
      acceptSuggestion(store, s, await store.listApplications(), applicationId)),
    reject: useInvalidating((id: string) => rejectSuggestion(store, id)),
    undo: useInvalidating(async (s: DbSuggestion) => undoSuggestion(store, s, await store.listApplications())),
  }
}
