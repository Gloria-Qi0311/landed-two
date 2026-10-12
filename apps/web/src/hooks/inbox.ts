// Hooks for the observation processor's output: job leads (the Leads
// column), agent updates (applied automatically by default, plus the few
// that need the user), the auto-apply preference, and the background runner
// that turns new agent reports into those.
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  acceptSuggestion, addLeadToPipeline, dismissLead, flagQuietApplications, processPending, recordApplyClick, rejectSuggestion,
  restoreLead, settleQuestions, undoSuggestion, type ClickTarget,
} from '../lib/inbox'
import { useStore, type DbJobLead, type DbSuggestion } from '../lib/store'
import type { Stage } from '@landed/observation-processor'

const RUN_INTERVAL_MS = 30_000
const QUIET_SCAN_MS = 10 * 60_000
let lastQuietScan = 0
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

export type Me = {
  auto_apply_updates: boolean
  email_watch: boolean
  email_checked_at: string | null
  onboarded_at: string | null
  created_at: string
}

export function useAccountPrefs() {
  const online = useAuth((s) => s.ready && !s.offline && !s.unreachable)
  return useQuery({ queryKey: ['profile', 'me'], enabled: online, queryFn: () => api.get<Me>('/me') })
}

export function useSetAutoApply() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (on: boolean) => api.patch<Me>('/me', { auto_apply_updates: on }),
    onSuccess: (me) => qc.setQueryData(['profile', 'me'], me),
  })
}

/** Process new agent reports in the background while Landed is open. */
export function useObservationProcessor() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  // On by default; offline (no /me) keeps the default too.
  const autoApply = useAccountPrefs().data?.auto_apply_updates ?? true

  useEffect(() => {
    if (!ready) return
    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        const handled = await processPending(store, { autoApply })
        // Panel questions an email or a manual move already answered.
        let changed = handled + (await settleQuestions(store))
        // Applications that went quiet (checked every few minutes, not every run).
        if (Date.now() - lastQuietScan > QUIET_SCAN_MS) {
          lastQuietScan = Date.now()
          changed += await flagQuietApplications(store)
        }
        if (changed > 0) for (const key of AFFECTED) qc.invalidateQueries({ queryKey: [key] })
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
  }, [store, ready, autoApply, qc])
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
    add: useInvalidating(({ lead, stage }: { lead: DbJobLead; stage: Stage }) => addLeadToPipeline(store, lead, stage)),
    dismiss: useInvalidating((id: string) => dismissLead(store, id)),
    restore: useInvalidating((id: string) => restoreLead(store, id)),
  }
}

/** Opening a posting from Landed → "did you apply?" in the Ask Agent panel. */
export function useRecordApplyClick() {
  const { store } = useStore()
  const qc = useQueryClient()
  return (target: ClickTarget) => {
    recordApplyClick(store, target)
      .then((q) => q && qc.invalidateQueries({ queryKey: ['suggestions'] }))
      .catch((e) => console.warn('[landed] recording the click failed', e))
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
