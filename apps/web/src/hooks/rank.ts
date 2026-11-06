// Rank with the user's own agent (lib/rank.ts): mounted once (App). When
// Workflow → Rank is set to the agent and the extension is here, each change
// to the leads scores the newest ones not yet scored for the active search,
// one batch at a time. New leads wait for their score (useRankHold), at most
// RANK_WAIT_MS.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import { bridgeCall } from '../lib/extension-bridge'
import { RANK_WAIT_MS, rankWithAgent, waitingForRank, type AskRank, type RankAnswer, type RankBatch } from '../lib/rank'
import type { DbJobLead } from '../lib/store/types'
import { useStore } from '../lib/store'
import { useAutomations } from './automation'
import { useJobLeads } from './inbox'
import { useActiveSearch } from './search'
import { useExtension } from './auto-apply'

/** After the agent couldn't be asked, wait this long before trying again. */
const RETRY_MS = 15 * 60_000

type RankState = { running: boolean; last: RankBatch | null; error: string | null; failedAt: number }
export const useRankState = create<RankState>(() => ({ running: false, last: null, error: null, failedAt: 0 }))
/** Leads already asked about, by search: one the agent gave no score isn't asked again. */
const asked = new Map<string, Set<string>>()

const askAgent: AskRank = async (context, leads) => {
  const res = await bridgeCall<RankAnswer>('rank-leads', { context, leads }, 180_000)
  if (!res.ok) throw new Error(res.error === 'no_extension' ? 'The Landed extension isn\'t in this browser' : res.error)
  return res.data
}

/** Whether the agent's scores count, and for which search (lib/fit.ts → rankOf). */
export function useRankSettings() {
  const { automations } = useAutomations()
  const search = useActiveSearch()
  return { on: automations.job_search.rank_by === 'agent', searchId: search?.id ?? null }
}

export function useLeadRanking() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const { automations, loaded } = useAutomations()
  const search = useActiveSearch()
  const leads = useJobLeads()
  const extension = useExtension().data
  const on = ready && loaded && automations.job_search.enabled && automations.job_search.rank_by === 'agent' && !!extension && !!search
  useEffect(() => {
    const s = useRankState.getState()
    if (!on || !search || !leads.data || s.running || Date.now() - s.failedAt < RETRY_MS) return
    const skip = asked.get(search.id) ?? new Set<string>()
    asked.set(search.id, skip)
    useRankState.setState({ running: true })
    rankWithAgent(store, askAgent, skip).then((batch) => {
      useRankState.setState({ running: false, error: null, ...(batch ? { last: batch } : {}) })
      if (batch) qc.invalidateQueries({ queryKey: ['job_leads'] })
    }, (e) => {
      console.warn('[landed] ranking leads failed', e)
      useRankState.setState({ running: false, error: e instanceof Error ? e.message : String(e), failedAt: Date.now() })
    })
  }, [on, search?.id, store, qc, leads.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The leads held out of Leads while the agent scores them: none unless Rank
 *  is on the agent and it can be asked; each for at most RANK_WAIT_MS. */
export function useRankHold(leads: DbJobLead[]): Set<string> {
  const { automations } = useAutomations()
  const { searchId } = useRankSettings()
  const extension = !!useExtension().data
  const error = useRankState((s) => s.error)
  // Re-render when the first held lead's wait is over.
  const [, tick] = useState(0)
  const hold = automations.job_search.enabled && automations.job_search.rank_by === 'agent' && extension && !error
  const now = Date.now()
  const held = hold ? leads.filter((l) => waitingForRank(l, { searchId, now })) : []
  const next = held.length ? Math.min(...held.map((l) => Date.parse(l.first_seen_at) + RANK_WAIT_MS)) : null
  useEffect(() => {
    if (next === null) return
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(1000, next - Date.now() + 50))
    return () => clearTimeout(timer)
  }, [next])
  return new Set(held.map((l) => l.id))
}
