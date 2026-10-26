// Remove duplicates with the user's own agent (lib/dedupe.ts): mounted once
// (App). When Workflow → Remove duplicates is set to the agent and the
// extension is here, each change to the leads asks about the pairs the rules
// can't call, one batch at a time.
import { useEffect } from 'react'
import { create } from 'zustand'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { bridgeCall } from '../lib/extension-bridge'
import { dedupeWithAgent, splitDuplicate, type AskSameJob, type DedupeBatch, type SameJobAnswer } from '../lib/dedupe'
import type { DbJobLead } from '../lib/store/types'
import { useStore } from '../lib/store'
import { useAutomations } from './automation'
import { useJobLeads } from './inbox'
import { useExtension } from './auto-apply'

/** After the agent couldn't be asked, wait this long before trying again. */
const RETRY_MS = 15 * 60_000

type DedupeState = { running: boolean; last: DedupeBatch | null; error: string | null; failedAt: number }
export const useDedupeState = create<DedupeState>(() => ({ running: false, last: null, error: null, failedAt: 0 }))

/** Ask the user's own agent, through the extension and Landed for Mac. */
const askAgent: AskSameJob = async (pairs) => {
  const res = await bridgeCall<SameJobAnswer>('same-job', { pairs }, 150_000)
  if (!res.ok) throw new Error(res.error === 'no_extension' ? 'The Landed extension isn\'t in this browser' : res.error)
  return res.data
}

export function useLeadDedupe() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { automations, loaded } = useAutomations()
  const leads = useJobLeads()
  const extension = useExtension().data
  const on = ready && loaded && automations.job_search.enabled && automations.job_search.dedupe_by === 'agent' && !!extension
  useEffect(() => {
    const s = useDedupeState.getState()
    if (!on || !leads.data || s.running || Date.now() - s.failedAt < RETRY_MS) return
    useDedupeState.setState({ running: true })
    dedupeWithAgent(store, askAgent).then((batch) => {
      useDedupeState.setState({ running: false, error: null, ...(batch ? { last: batch } : {}) })
      // The leads changed: the next batch, if any, runs from here.
      if (batch) qc.invalidateQueries({ queryKey: ['job_leads'] })
    }, (e) => {
      console.warn('[landed] asking about duplicates failed', e)
      useDedupeState.setState({ running: false, error: e instanceof Error ? e.message : String(e), failedAt: Date.now() })
    })
  }, [on, store, qc, leads.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Split a lead the agent judged a duplicate back out. */
export function useSplitDuplicate() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (lead: DbJobLead) => splitDuplicate(store, lead),
    onSettled: () => qc.invalidateQueries({ queryKey: ['job_leads'] }),
  })
}
