// Email checks: the user's own agent reads their mailbox (read-only, through
// the mail connector they gave it, e.g. Claude Code + Gmail) and reports
// what job-application emails mean; the browser turns that into status
// updates (ingestEmailFindings → the observation processor). The mail never
// reaches Landed's server — only the findings, relayed in memory.
//
// A store, not a component: checks run in the background (hooks/email.ts
// schedules them) and survive the panel closing; after a reload a running
// check is followed again (the server replays a task's output for an hour).
import { create } from 'zustand'
import type { Settings } from '@landed/observation-processor'
import { ApiError } from './api'
import { ingestEmailFindings, type EmailIngestResult } from './inbox'
import type { DataStore } from './store/types'
import { followJob, startJob, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

export type EmailCheck = {
  job_id: string | null
  runtime_id: string
  agent: string
  /** "Gmail" */
  mail: string
  /** "Claude Code on MacBook Pro" */
  label: string
  status: 'running' | 'done' | 'error'
  /** mailbox tool calls so far (searches + emails opened) */
  reads: number
  started_at: string
  summary?: string
  result?: EmailIngestResult
  error?: string
}

export type EmailTarget = { runtime: Runtime; agent: RuntimeAgent }

type Binding = {
  store: DataStore
  settings: () => Settings
  /** A check finished: remember when it started (the next reads from there). */
  onChecked: (startedAt: string) => Promise<void>
  onData: () => void
}

type State = {
  userId: string | null
  check: EmailCheck | null
  bind: (userId: string, binding: Binding) => void
  start: (target: EmailTarget, input: { since: string; applications: { company: string; role: string; stage: string }[] }) => Promise<void>
}

const key = (userId: string) => `landed:email-check:${userId}`
let binding: Binding | null = null
let following: { jobId: string; stop: () => void } | null = null

function restore(userId: string): EmailCheck | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    return saved && typeof saved === 'object' ? saved : null
  } catch {
    return null
  }
}

export const useEmailCheck = create<State>((set, get) => {
  const update = (fn: (c: EmailCheck) => EmailCheck) => set((s) => ({ check: s.check ? fn(s.check) : s.check }))

  function follow(check: EmailCheck) {
    if (!check.job_id || check.status !== 'running' || following?.jobId === check.job_id) return
    const jobId = check.job_id
    following?.stop()
    following = {
      jobId,
      stop: followJob(jobId, (e) => {
        if (e.type === 'tool') return update((c) => ({ ...c, reads: c.reads + 1 }))
        if (e.type !== 'done' && e.type !== 'error') return
        following = null
        void (async () => {
          if (e.type === 'error') return update((c) => ({ ...c, status: 'error', error: e.message }))
          if (!e.findings) return update((c) => ({ ...c, status: 'error', error: 'The agent finished without reporting what it read.' }))
          try {
            if (!binding) throw new Error('not signed in')
            const result = await ingestEmailFindings(binding.store, e.findings, {
              run_id: jobId, runtime_id: check.runtime_id, agent: check.agent, mail: check.mail,
            }, binding.settings())
            update((c) => ({ ...c, status: 'done', result, summary: e.text || undefined }))
            await binding.onChecked(check.started_at)
            binding.onData()
          } catch (err) {
            update((c) => ({ ...c, status: 'error', error: `Couldn't apply the updates: ${(err as Error).message}` }))
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

    async start({ runtime, agent }, input) {
      if (get().check?.status === 'running') return
      const base = {
        runtime_id: runtime.id, agent: agent.id, mail: agent.mail ?? 'email', label: `${agent.label} on ${runtime.name}`,
        reads: 0, started_at: new Date().toISOString(),
      }
      try {
        const jobId = await startJob(runtime.id, agent.id, 'email_check', input)
        const check: EmailCheck = { ...base, job_id: jobId, status: 'running' }
        set({ check })
        follow(check)
      } catch (e) {
        set({ check: { ...base, job_id: null, status: 'error', error: e instanceof ApiError ? e.message : String(e) } })
      }
    },
  }
})

useEmailCheck.subscribe((s) => {
  if (!s.userId) return
  try {
    sessionStorage.setItem(key(s.userId), JSON.stringify(s.check))
  } catch {
    // storage blocked — a reload just won't pick the check back up
  }
})
