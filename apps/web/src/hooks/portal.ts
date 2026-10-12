// Portal checks (lib/portal-check.ts): which computer can run them, and the
// app-level binding so a check started from the panel finishes (and is
// picked back up after a reload) wherever the user is.
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../lib/auth'
import { usePortalCheck, type PortalTarget } from '../lib/portal-check'
import { useStore } from '../lib/store'
import { canRun, type Runtime } from './runtimes'

/** The first online agent that can look at portals in the user's browser. */
export function portalTarget(runtimes: Runtime[] | undefined): PortalTarget | null {
  for (const runtime of runtimes ?? []) {
    if (!runtime.online || runtime.revoked_at) continue
    const agent = runtime.agents.find((a) => canRun(a, 'portal_check'))
    if (agent) return { runtime, agent }
  }
  return null
}

/** Any paired agent (online or not) that has a browser. */
export function browserAgent(runtimes: Runtime[] | undefined) {
  for (const runtime of runtimes ?? []) {
    if (runtime.revoked_at) continue
    const agent = runtime.agents.find((a) => a.browser && canRun(a, 'portal_check'))
    if (agent) return { runtime, agent, browser: agent.browser! }
  }
  return null
}

export function usePortalRunner() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const userId = useAuth((s) => s.user?.id)
  useEffect(() => {
    if (!ready || !userId) return
    usePortalCheck.getState().bind(userId, {
      store,
      onData: () => {
        for (const key of ['applications', 'suggestions', 'portal_events']) qc.invalidateQueries({ queryKey: [key] })
      },
    })
  }, [ready, userId, store, qc])
}
