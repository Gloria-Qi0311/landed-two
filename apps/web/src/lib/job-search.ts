// Job search runs: a confirmed brief → a `job_search` task for every agent
// on the user's online computers → the jobs they find become leads
// (ingestFoundJobs, same dedupe rules as external agents). Lives in a store,
// not a component, so a search keeps going while the user is elsewhere in
// the app. The runs of the current batch are kept per account in
// sessionStorage; after a reload, running ones are followed again (the
// server replays a task's output for an hour).
import { create } from 'zustand'
import { ApiError } from './api'
import { ingestFoundJobs, type IngestResult } from './inbox'
import type { DataStore, DbJobSearch } from './store/types'
import { followJob, startJob, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

export type SearchRun = {
  id: string
  /** null when the task couldn't be started */
  job_id: string | null
  search_id: string
  runtime_id: string
  agent: string
  /** "Claude Code on MacBook Pro" */
  label: string
  status: 'running' | 'done' | 'error'
  searches: number
  pages: number
  result?: IngestResult
  summary?: string
  error?: string
  started_at: string
}

export type SearchTarget = { runtime: Runtime; agent: RuntimeAgent }

type Binding = { store: DataStore; onData: () => void }

type State = {
  userId: string | null
  runs: SearchRun[]
  /** Attach this account's store (and re-follow running searches). */
  bind: (userId: string, binding: Binding) => void
  start: (search: DbJobSearch, targets: SearchTarget[]) => Promise<void>
}

const key = (userId: string) => `landed:search-runs:${userId}`
let binding: Binding | null = null
const following = new Map<string, () => void>()

function restore(userId: string): SearchRun[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

export const useJobSearch = create<State>((set, get) => {
  const update = (id: string, fn: (r: SearchRun) => SearchRun) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? fn(r) : r)) }))

  /** Once every run of a batch has finished, record the batch on the search. */
  async function finishBatch(searchId: string) {
    const runs = get().runs.filter((r) => r.search_id === searchId)
    if (!binding || runs.length === 0 || runs.some((r) => r.status === 'running')) return
    const done = runs.filter((r) => r.status === 'done')
    const sum = (k: keyof IngestResult) => done.reduce((n, r) => n + (r.result?.[k] ?? 0), 0)
    try {
      await binding.store.updateJobSearch(searchId, {
        last_run_at: new Date().toISOString(),
        last_run_result: {
          found: sum('found'), added: sum('added'), merged: sum('merged'), already_applied: sum('already_applied'),
          agents: done.map((r) => r.label),
          ...(runs.length > done.length ? { failed: runs.filter((r) => r.status === 'error').map((r) => r.label) } : {}),
        },
      })
    } catch (e) {
      console.warn('[landed] recording the search run failed', e)
    }
    binding.onData()
  }

  function follow(run: SearchRun) {
    if (!run.job_id || run.status !== 'running' || following.has(run.job_id)) return
    const jobId = run.job_id
    following.set(jobId, followJob(jobId, (e) => {
      if (e.type === 'tool') {
        update(run.id, (r) => (e.name === 'WebFetch' ? { ...r, pages: r.pages + 1 } : { ...r, searches: r.searches + 1 }))
        return
      }
      if (e.type !== 'done' && e.type !== 'error') return
      following.delete(jobId)
      void (async () => {
        if (e.type === 'error') {
          update(run.id, (r) => ({ ...r, status: 'error', error: e.message }))
        } else if (!e.jobs) {
          update(run.id, (r) => ({ ...r, status: 'error', error: "The agent finished without returning any jobs." }))
        } else {
          try {
            if (!binding) throw new Error('not signed in')
            const result = await ingestFoundJobs(binding.store, e.jobs, { run_id: jobId, runtime_id: run.runtime_id, agent: run.agent })
            update(run.id, (r) => ({ ...r, status: 'done', result, summary: e.text || undefined }))
            binding.onData()
          } catch (err) {
            update(run.id, (r) => ({ ...r, status: 'error', error: `Couldn't save the results: ${(err as Error).message}` }))
          }
        }
        await finishBatch(run.search_id)
      })()
    }))
  }

  return {
    userId: null,
    runs: [],

    bind(userId, next) {
      binding = next
      if (get().userId !== userId) {
        for (const stop of following.values()) stop()
        following.clear()
        set({ userId, runs: restore(userId) })
      }
      get().runs.forEach(follow)
    },

    async start(search, targets) {
      const startedAt = new Date().toISOString()
      const runs: SearchRun[] = await Promise.all(targets.map(async ({ runtime, agent }) => {
        const base = {
          id: crypto.randomUUID(), search_id: search.id, runtime_id: runtime.id, agent: agent.id,
          label: `${agent.label} on ${runtime.name}`, searches: 0, pages: 0, started_at: startedAt,
        }
        try {
          const jobId = await startJob(runtime.id, agent.id, 'job_search', { brief: search.brief, search_id: search.id })
          return { ...base, job_id: jobId, status: 'running' as const }
        } catch (e) {
          return { ...base, job_id: null, status: 'error' as const, error: e instanceof ApiError ? e.message : String(e) }
        }
      }))
      // Only the latest batch is shown; earlier ones live on as last_run_result.
      set({ runs })
      runs.forEach(follow)
      await finishBatch(search.id) // records it right away if nothing could start
    },
  }
})

useJobSearch.subscribe((s) => {
  if (!s.userId) return
  try {
    sessionStorage.setItem(key(s.userId), JSON.stringify(s.runs))
  } catch {
    // storage full or blocked — a reload just won't pick the search back up
  }
})
