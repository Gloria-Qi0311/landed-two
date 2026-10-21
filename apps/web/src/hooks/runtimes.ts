// The user's own computers running the Landed daemon (apps/daemon) — pair,
// list (with live online status), remove, and run a task on one with its
// output streamed back. Account-level: works with or without Cloud sync.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EmailFinding } from '@landed/schema/email-check'
import type { PortalResult } from '@landed/schema/portal-check'
import type { FoundJob } from '@landed/schema/search-brief'
import { ApiError, api } from '../lib/api'
import { useAuth } from '../lib/auth'

export type TaskKind = 'chat' | 'job_search' | 'email_check' | 'portal_check' | 'resume_parse' | 'resume_merge' | 'resume_tailor' | 'automation_sync'
/** `kinds`: the tasks this agent's daemon can run (older daemons: chat only).
 *  `mail`: the mailbox it can read through a connector (e.g. "Gmail").
 *  `browser`: "Chrome" when it can look at pages in the user's Chrome. */
export type RuntimeAgent = {
  id: string; label: string; version: string | null; kinds?: TaskKind[]; mail?: string | null; browser?: string | null
  auth?: 'signed_out'
}
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
  | { type: 'done'; text: string; session_id?: string; jobs?: FoundJob[]; findings?: EmailFinding[]; results?: PortalResult[]; output?: unknown }
  | { type: 'error'; message: string }

export const canRun = (a: RuntimeAgent, kind: TaskKind) => (a.kinds ?? ['chat']).includes(kind)

/** The first online agent that can run `kind`; `outdated` when computers
 *  are online but their daemons predate it (restart to update). */
export function agentFor(runtimes: Runtime[] | undefined, kind: TaskKind) {
  const online = (runtimes ?? []).filter((r) => r.online && !r.revoked_at)
  for (const runtime of online) {
    const agent = runtime.agents.find((a) => canRun(a, kind))
    if (agent) return { runtime, agent, outdated: false }
  }
  return { runtime: null, agent: null, outdated: online.some((r) => r.agents.length > 0) }
}

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

/** Start a task on a computer; returns its id (the server relays it, in memory). */
export async function startJob(runtimeId: string, agent: string, kind: TaskKind, input: Record<string, unknown>): Promise<string> {
  return (await api.post<{ job_id: string }>('/runtime-jobs', { runtime_id: runtimeId, agent, kind, input })).job_id
}

/** Follow a task's output: replays what happened so far, then streams the
 *  rest until done/error. Returns a stop function. */
export function followJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
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

/** Start a task on a computer and follow its output. Returns a stop function. */
export async function runOnComputer(
  runtimeId: string,
  agent: string,
  kind: TaskKind,
  input: Record<string, unknown>,
  onEvent: (e: JobEvent) => void,
): Promise<() => void> {
  try {
    return followJob(await startJob(runtimeId, agent, kind, input), onEvent)
  } catch (e) {
    onEvent({ type: 'error', message: e instanceof ApiError ? e.message : String(e) })
    return () => {}
  }
}
