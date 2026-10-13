// My Resume's AI work, on the user's own agent (apps/daemon):
//   - merge: every uploaded resume (+ the current master, so edits carry
//     over) → one master resume, every phrasing of every bullet kept;
//   - tailor: master + a target role → a version aimed at it, with notes
//     on what it picked and why.
// One task at a time. Lives in a store so it keeps going while the user
// browses; followed again after a reload (the server replays output).
import { create } from 'zustand'
import { safeNormalize } from '@landed/schema'
import { masterToResume, parseLooseResume, parseMasterResume, parseTailorNotes, type MasterResume, type ResumeTarget } from '@landed/schema/master-resume'
import { ApiError } from './api'
import type { DataStore, DbResume } from './store/types'
import { followJob, startJob, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

export type ResumeTask = {
  kind: 'resume_merge' | 'resume_tailor'
  job_id: string | null
  runtime_id: string
  /** "Claude Code on MacBook Pro" */
  label: string
  status: 'running' | 'done' | 'error'
  started_at: string
  /** merge: the uploads it read, so the master can say what it's built from */
  sources?: { id: string; name: string }[]
  target?: ResumeTarget
  /** the resume it created or updated */
  result_id?: string
  error?: string
}

type Target = { runtime: Runtime; agent: RuntimeAgent }
type Binding = { store: DataStore; onData: () => void }

type State = {
  userId: string | null
  task: ResumeTask | null
  bind: (userId: string, binding: Binding) => void
  merge: (target: Target, sources: DbResume[], master: DbResume | null) => Promise<void>
  tailor: (target: Target, master: MasterResume, role: ResumeTarget) => Promise<void>
}

const key = (userId: string) => `landed:resume-task:${userId}`
let binding: Binding | null = null
let following: { jobId: string; stop: () => void } | null = null

function restore(userId: string): ResumeTask | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    return saved && typeof saved === 'object' ? saved : null
  } catch {
    return null
  }
}

/** The flattened master as a canonical resume (auto-fill uses parsed_json). */
export function flattenMaster(m: MasterResume) {
  const n = safeNormalize(masterToResume(m))
  return n.ok ? n.resume : null
}

async function saveMaster(store: DataStore, m: MasterResume): Promise<string> {
  const existing = (await store.listResumes()).find((r) => r.kind === 'master')
  const parsed = flattenMaster(m)
  if (existing) return (await store.updateResume(existing.id, { master_json: m, parsed_json: parsed })).id
  return (await store.addResume({ name: 'Master resume', kind: 'master', master_json: m, parsed_json: parsed, set_current: false })).id
}

const versionName = (t: ResumeTarget) => `${t.role}${t.company ? ` · ${t.company}` : ''}`.slice(0, 120)

export const useResumeTask = create<State>((set, get) => {
  const update = (fn: (t: ResumeTask) => ResumeTask) => set((s) => ({ task: s.task ? fn(s.task) : s.task }))
  const fail = (error: string) => update((t) => ({ ...t, status: 'error', error }))

  function follow(task: ResumeTask) {
    if (!task.job_id || task.status !== 'running' || following?.jobId === task.job_id) return
    const jobId = task.job_id
    following?.stop()
    following = {
      jobId,
      stop: followJob(jobId, (e) => {
        if (e.type !== 'done' && e.type !== 'error') return
        following = null
        void (async () => {
          if (e.type === 'error') return fail(e.message)
          try {
            if (!binding) throw new Error('not signed in')
            let resultId: string
            if (task.kind === 'resume_merge') {
              const m = parseMasterResume(e.output)
              if (!m) return fail("The agent didn't return a usable master resume. Try again.")
              resultId = await saveMaster(binding.store, { ...m, sources: task.sources ?? [], built_at: new Date().toISOString() })
            } else {
              const out = (e.output ?? {}) as { resume?: unknown }
              const resume = safeNormalize(parseLooseResume(out.resume))
              if (!resume.ok || !task.target) return fail("The agent didn't return a usable resume. Try again.")
              resultId = (await binding.store.addResume({
                name: versionName(task.target), kind: 'version', parsed_json: resume.resume, set_current: false,
                target_json: { ...task.target, notes: parseTailorNotes(e.output) },
              })).id
            }
            update((t) => ({ ...t, status: 'done', result_id: resultId }))
            binding.onData()
          } catch (err) {
            fail(`Couldn't save it: ${(err as Error).message}`)
          }
        })()
      }),
    }
  }

  async function start(kind: ResumeTask['kind'], { runtime, agent }: Target, input: Record<string, unknown>, extra: Partial<ResumeTask>) {
    if (get().task?.status === 'running') return
    const base = { kind, runtime_id: runtime.id, label: `${agent.label} on ${runtime.name}`, started_at: new Date().toISOString(), ...extra }
    try {
      const jobId = await startJob(runtime.id, agent.id, kind, input)
      const task: ResumeTask = { ...base, job_id: jobId, status: 'running' }
      set({ task })
      follow(task)
    } catch (e) {
      set({ task: { ...base, job_id: null, status: 'error', error: e instanceof ApiError ? e.message : String(e) } })
    }
  }

  return {
    userId: null,
    task: null,

    bind(userId, next) {
      binding = next
      if (get().userId !== userId) {
        following?.stop()
        following = null
        set({ userId, task: restore(userId) })
      }
      const task = get().task
      if (task) follow(task)
    },

    merge(target, sources, master) {
      const picked = sources.filter((s) => s.parsed_json).slice(0, 10)
      return start('resume_merge', target, {
        sources: picked.map((s) => ({ id: s.id, name: s.name, resume: s.parsed_json })),
        master: master?.master_json ?? null,
      }, { sources: picked.map((s) => ({ id: s.id, name: s.name })) })
    },

    tailor(target, master, role) {
      return start('resume_tailor', target, { master, target: role }, { target: role })
    },
  }
})

useResumeTask.subscribe((s) => {
  if (!s.userId) return
  try {
    sessionStorage.setItem(key(s.userId), JSON.stringify(s.task))
  } catch {
    // storage blocked — a reload just won't pick the task back up
  }
})
