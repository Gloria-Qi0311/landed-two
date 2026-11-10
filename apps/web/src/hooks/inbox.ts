// Hooks for the observation processor's output: job leads (the Leads
// column), agent updates (applied automatically by default, plus the few
// that need the user), the auto-apply preference, and the background upkeep
// of Landed's questions.
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  acceptSuggestion, addLeadToPipeline, approveLeads, dismissLead, flagQuietApplications, recordApplyClick, rejectSuggestion,
  repairRoundOrder, restoreLead, settleQuestions, undoApprovals, undoSuggestion, type Approval, type ClickTarget,
} from '../lib/inbox'
import { useStore, type DbJobLead, type DbSuggestion } from '../lib/store'
import type { Stage } from '@landed/observation-processor'

const RUN_INTERVAL_MS = 30_000
const QUIET_SCAN_MS = 10 * 60_000
let lastQuietScan = 0

const AFFECTED = ['job_leads', 'suggestions', 'applications', 'companies', 'portal_events']

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
  /** schedule for recurring agent work (packages/schema/src/automation.ts) */
  automations?: unknown
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

/** Keep Landed's questions current in the background while Landed is open:
 *  close the ones an email or a manual move answered, and ask about
 *  applications that went quiet. */
let roundsRepaired = false

export function useQuestionUpkeep() {
  const qc = useQueryClient()
  const { store, ready } = useStore()

  useEffect(() => {
    if (!ready) return
    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        // Once per session for Cloud accounts (local ones: Dexie v9).
        if (store.kind === 'cloud' && !roundsRepaired) {
          roundsRepaired = true
          if (await repairRoundOrder(store)) qc.invalidateQueries({ queryKey: ['applications'] })
        }
        // Panel questions an email or a manual move already answered.
        let changed = await settleQuestions(store)
        // Applications that went quiet (checked every few minutes, not every run).
        if (Date.now() - lastQuietScan > QUIET_SCAN_MS) {
          lastQuietScan = Date.now()
          changed += await flagQuietApplications(store)
        }
        if (changed > 0) for (const key of AFFECTED) qc.invalidateQueries({ queryKey: [key] })
      } catch (e) {
        console.warn('[landed] updating Landed\'s questions failed', e)
      } finally {
        running = false
      }
    }
    void run()
    const timer = setInterval(run, RUN_INTERVAL_MS)
    window.addEventListener('focus', run)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', run)
    }
  }, [store, ready, qc])
}

function useInvalidating<T, R>(fn: (input: T) => Promise<R>) {
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
    approve: useInvalidating((leads: DbJobLead[]) => approveLeads(store, leads)),
    undoApprove: useInvalidating((approvals: Approval[]) => undoApprovals(store, approvals)),
    dismiss: useInvalidating((id: string) => dismissLead(store, id)),
    restore: useInvalidating((id: string) => restoreLead(store, id)),
    setDeadline: useInvalidating(({ id, deadline }: { id: string; deadline: string | null }) => store.updateJobLead(id, { deadline })),
  }
}

/** Opening a posting from Landed → "did you apply?" on the Agent page. */
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
