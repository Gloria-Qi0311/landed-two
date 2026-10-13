// External agents (Meta Muse, Claude, Codex…).
//
// Connections are account-level (they live on the server whatever the sync
// mode, like the login itself). Observations are data: they come from the
// account's store. For sync-off accounts the server is only a relay, so
// useAgentRelay() pulls held observations into this browser's database and
// acks them, after which the server purges the payload.
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { localStoreFor, useStore, type DbAgentObservation } from '../lib/store'
import { OBSERVATIONS_ARRIVED } from './inbox'
import { taskContext } from './automation'

export type AgentConnection = {
  id: string
  provider: string
  display_name: string
  scopes: string[]
  last_seen_at: string | null
  revoked_at: string | null
  created_at: string
}

const PULL_INTERVAL_MS = 60_000

const useOnline = () => useAuth((s) => s.ready && !s.offline && !s.unreachable)

export function useAgentConnections() {
  const online = useOnline()
  return useQuery({
    queryKey: ['agent_connections'],
    enabled: online,
    queryFn: () => api.get<AgentConnection[]>('/agent-connections'),
  })
}

export function useCreateAgentConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { provider: string; display_name: string }) =>
      api.post<{ connection: AgentConnection; token: string }>('/agent-connections', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent_connections'] }),
  })
}

export function useRevokeAgentConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<AgentConnection>(`/agent-connections/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent_connections'] }),
  })
}

export function useAgentObservations(limit = 50) {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['agent_observations', store.kind, limit],
    enabled: ready,
    queryFn: () => store.listAgentObservations(limit),
  })
}

/** Sync-off accounts: move held observations from the server's relay into
 *  this browser (on load, on focus, every minute), then ack them. */
export function useAgentRelay() {
  const qc = useQueryClient()
  const user = useAuth((s) => s.user)
  const online = useOnline()
  const relaying = !!user && !user.cloud_sync && online

  useEffect(() => {
    if (!relaying || !user) return
    const device = localStoreFor(user.id)
    let pulling = false
    const pull = async () => {
      if (pulling) return
      pulling = true
      try {
        // Drain in pages; each page is stored before it's acked, so a crash
        // in between just means the server re-delivers (and we dedupe).
        for (let page = 0; page < 10; page++) {
          const held = await api.get<DbAgentObservation[]>('/agent-inbox?limit=200')
          if (held.length === 0) break
          const ids = await device.receiveAgentObservations(held)
          await api.post('/agent-inbox/ack', { ids })
          qc.invalidateQueries({ queryKey: ['agent_observations'] })
          window.dispatchEvent(new Event(OBSERVATIONS_ARRIVED))
          if (held.length < 200) break
        }
      } catch (e) {
        console.warn('[landed] agent relay pull failed', e)
      } finally {
        pulling = false
      }
    }
    void pull()
    const timer = setInterval(pull, PULL_INTERVAL_MS)
    window.addEventListener('focus', pull)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', pull)
    }
  }, [relaying, user, qc])
}

/** While a cloud agent that reads tasks (a connector) is connected, share
 *  what its tasks need — the search brief and the application list
 *  (company, role, stage) — and nothing else. Sent when it changes (checked
 *  every minute and on focus). The server deletes it when the last such
 *  agent is disconnected (packages/schema/src/cloud-agent.ts). */
export function useCloudBriefing() {
  const { store, ready } = useStore()
  const connections = useAgentConnections()
  const readers = (connections.data ?? []).some((c) => !c.revoked_at && c.scopes.includes('tasks:read'))

  useEffect(() => {
    if (!ready || !readers) return
    let last = ''
    const push = async () => {
      try {
        const ctx = await taskContext(store, null)
        const briefing = { brief: ctx.brief, applications: ctx.applications }
        const key = JSON.stringify(briefing)
        if (key === last) return
        await api.put('/agent-briefing', briefing)
        last = key
      } catch (e) {
        console.warn('[landed] sharing the briefing with cloud agents failed', e)
      }
    }
    void push()
    const timer = setInterval(push, 60_000)
    window.addEventListener('focus', push)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', push)
    }
  }, [ready, readers, store])
}
