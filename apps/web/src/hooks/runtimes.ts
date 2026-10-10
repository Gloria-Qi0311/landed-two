// The user's own computers running the Landed daemon (apps/daemon) — pair,
// list (with live online status), remove, and run a task on one with its
// output streamed back. Account-level: works with or without Cloud sync.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api'
import { useAuth } from '../lib/auth'

export type RuntimeAgent = { id: string; label: string; version: string | null }
export type Runtime = {
  id: string
  name: string
  agents: RuntimeAgent[]
  daemon_version: string | null
  last_seen_at: string | null
  revoked_at: string | null
  created_at: string
  online: boolean
}

export type JobEvent =
  | { type: 'started'; agent: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; session_id?: string }
  | { type: 'error'; message: string }

export function useRuntimes(opts: { poll?: boolean } = {}) {
  const online = useAuth((s) => s.ready && !s.offline && !s.unreachable)
  return useQuery({
    queryKey: ['runtimes'],
    enabled: online,
    queryFn: () => api.get<Runtime[]>('/runtimes'),
    refetchInterval: opts.poll ? 3000 : 15_000,
    // While pairing, the user is in a terminal running the command — keep
    // polling even though the page isn't focused, so it flips to "connected"
    // by the time they come back.
    refetchIntervalInBackground: !!opts.poll,
  })
}

export function usePairRuntime() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.post<{ runtime: Runtime; token: string }>('/runtimes', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runtimes'] }),
  })
}

export function useRemoveRuntime() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<Runtime>(`/runtimes/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runtimes'] }),
  })
}

/** Start a task on a computer and follow its output. Returns a stop function. */
export async function runOnComputer(
  runtimeId: string,
  agent: string,
  kind: 'chat',
  input: Record<string, unknown>,
  onEvent: (e: JobEvent) => void,
): Promise<() => void> {
  let jobId: string
  try {
    jobId = (await api.post<{ job_id: string }>('/runtime-jobs', { runtime_id: runtimeId, agent, kind, input })).job_id
  } catch (e) {
    onEvent({ type: 'error', message: e instanceof ApiError ? e.message : String(e) })
    return () => {}
  }
  const source = new EventSource(`/api/runtime-jobs/${jobId}/stream`)
  source.addEventListener('job_event', (msg) => {
    const e = JSON.parse((msg as MessageEvent).data) as JobEvent
    onEvent(e)
    if (e.type === 'done' || e.type === 'error') source.close()
  })
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onEvent({ type: 'error', message: 'Lost the connection to Landed.' })
  }
  return () => source.close()
}
