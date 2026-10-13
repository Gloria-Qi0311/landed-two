// Portal checks — the fallback when email is silent: the user's own agent
// looks at candidate portals in their Chrome (Claude in Chrome), read-only
// by construction (it can navigate and read, never click or type), and
// reports what each shows. Always started by the user from the Agent
// panel; results go through the processor in ask-first mode
// (ingestPortalResults). Same store shape as lib/email-check.ts.
import { create } from 'zustand'
import { ApiError } from './api'
import { ingestPortalResults, type PortalIngestResult } from './inbox'
import type { DataStore } from './store/types'
import { followJob, startJob, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

export type PortalCheck = {
  job_id: string | null
  runtime_id: string
  agent: string
  /** "Claude Code on MacBook Pro" */
  label: string
  /** ref → application (ids stay in the browser; the agent sees refs) */
  items: { ref: string; application_id: string; company: string }[]
  status: 'running' | 'done' | 'error'
  /** pages opened/read so far */
  pages: number
  started_at: string
  summary?: string
  result?: PortalIngestResult
  error?: string
}

export type PortalTarget = { runtime: Runtime; agent: RuntimeAgent }
export type PortalApp = { id: string; company: string; role: string; stage: string; url: string }

type Binding = { store: DataStore; onData: () => void }

type State = {
  userId: string | null
  check: PortalCheck | null
  bind: (userId: string, binding: Binding) => void
  start: (target: PortalTarget, apps: PortalApp[]) => Promise<void>
}

const key = (userId: string) => `landed:portal-check:${userId}`
let binding: Binding | null = null
let following: { jobId: string; stop: () => void } | null = null

function restore(userId: string): PortalCheck | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    return saved && typeof saved === 'object' ? saved : null
  } catch {
    return null
  }
}

export const usePortalCheck = create<State>((set, get) => {
  const update = (fn: (c: PortalCheck) => PortalCheck) => set((s) => ({ check: s.check ? fn(s.check) : s.check }))

  function follow(check: PortalCheck) {
    if (!check.job_id || check.status !== 'running' || following?.jobId === check.job_id) return
    const jobId = check.job_id
    following?.stop()
    following = {
      jobId,
      stop: followJob(jobId, (e) => {
        if (e.type === 'tool') {
          if (/navigate|get_page_text|read_page/.test(e.name)) update((c) => ({ ...c, pages: c.pages + 1 }))
          return
        }
        if (e.type !== 'done' && e.type !== 'error') return
        following = null
        void (async () => {
          if (e.type === 'error') return update((c) => ({ ...c, status: 'error', error: e.message }))
          if (!e.results) return update((c) => ({ ...c, status: 'error', error: 'The agent finished without reporting what it saw.' }))
          try {
            if (!binding) throw new Error('not signed in')
            const result = await ingestPortalResults(binding.store, check.items, e.results, {
              run_id: jobId, runtime_id: check.runtime_id, agent: check.agent,
            })
            update((c) => ({ ...c, status: 'done', result, summary: e.text || undefined }))
            binding.onData()
          } catch (err) {
            update((c) => ({ ...c, status: 'error', error: `Couldn't apply what it found: ${(err as Error).message}` }))
          }
        })()
      }),
    }
  }

  return {
    userId: null,
    check: null,

    bind(userId, next) {
      binding = next
      if (get().userId !== userId) {
        following?.stop()
        following = null
        set({ userId, check: restore(userId) })
      }
      const check = get().check
      if (check) follow(check)
    },

    async start({ runtime, agent }, apps) {
      if (get().check?.status === 'running' || apps.length === 0) return
      const picked = apps.slice(0, 5).map((a, i) => ({ ...a, ref: String(i + 1) }))
      const base = {
        runtime_id: runtime.id, agent: agent.id, label: `${agent.label} on ${runtime.name}`,
        items: picked.map((a) => ({ ref: a.ref, application_id: a.id, company: a.company })),
        pages: 0, started_at: new Date().toISOString(),
      }
      try {
        const jobId = await startJob(runtime.id, agent.id, 'portal_check', {
          items: picked.map(({ ref, company, role, stage, url }) => ({ ref, company, role, stage, url })),
        })
        const check: PortalCheck = { ...base, job_id: jobId, status: 'running' }
        set({ check })
        follow(check)
      } catch (e) {
        set({ check: { ...base, job_id: null, status: 'error', error: e instanceof ApiError ? e.message : String(e) } })
      }
    },
  }
})

usePortalCheck.subscribe((s) => {
  if (!s.userId) return
  try {
    sessionStorage.setItem(key(s.userId), JSON.stringify(s.check))
  } catch {
    // storage blocked — a reload just won't pick the check back up
  }
})
