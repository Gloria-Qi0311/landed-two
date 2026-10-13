// My Resume's AI work, on the user's own agent (apps/daemon):
//   - upload: each resume file → the canonical shape (`resume_parse`; PDFs
//     and images are read by the agent itself, Word files are turned into
//     text here first). When a batch is done, the master is updated.
//   - merge: every uploaded resume (+ the current master, so edits carry
//     over) → one master resume, every phrasing of every bullet kept;
//   - tailor: master + a target role → a version aimed at it, with notes
//     on what it picked and why.
// One task at a time. Lives in a store so it keeps going while the user
// browses; followed again after a reload (the server replays output).
import { create } from 'zustand'
import { safeNormalize } from '@landed/schema'
import {
  masterToResume, MAX_UPLOAD_BYTES, PARSE_FILE_TYPES, parseLooseResume, parseMasterResume, parseTailorNotes,
  type MasterResume, type ResumeTarget,
} from '@landed/schema/master-resume'
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

/** One file being read by the agent. */
export type UploadItem = {
  id: string
  name: string
  status: 'preparing' | 'reading' | 'saved' | 'error'
  job_id: string | null
  /** uploads started together; the master is updated when a batch is done */
  batch: string
  result_id?: string
  error?: string
}

type Target = { runtime: Runtime; agent: RuntimeAgent }
type Binding = { store: DataStore; onData: () => void }

type State = {
  userId: string | null
  task: ResumeTask | null
  uploads: UploadItem[]
  /** Read these files with the agent, save them as uploads, then update the master. */
  upload: (target: Target, files: File[]) => Promise<void>
  clearUploads: () => void
  bind: (userId: string, binding: Binding) => void
  merge: (target: Target, sources: DbResume[], master: DbResume | null) => Promise<void>
  tailor: (target: Target, master: MasterResume, role: ResumeTarget) => Promise<void>
}

const key = (userId: string) => `landed:resume-task:${userId}`
let binding: Binding | null = null
let following: { jobId: string; stop: () => void } | null = null
const followingUploads = new Map<string, () => void>()
/** batch → the agent to merge with when it's done */
const batchTargets = new Map<string, Target>()

function restore(userId: string): { task: ResumeTask | null; uploads: UploadItem[] } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null')
    return { task: saved?.task ?? null, uploads: Array.isArray(saved?.uploads) ? saved.uploads : [] }
  } catch {
    return { task: null, uploads: [] }
  }
}

const baseName = (file: File) => file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 100) || 'Resume'

/** A file → what the agent gets: the file itself (PDF, image) or its text. */
async function prepare(file: File): Promise<{ file: { type: string; data_base64: string } | null; text: string | null }> {
  const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '')
  if (PARSE_FILE_TYPES[type]) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('That file is over 8 MB.')
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error("Couldn't read the file."))
      r.readAsDataURL(file)
    })
    return { file: { type, data_base64: url.slice(url.indexOf(',') + 1) }, text: null }
  }
  if (/\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    if (!value.trim()) throw new Error('That Word file has no text in it.')
    return { file: null, text: value }
  }
  if (/\.(txt|md|markdown)$/i.test(file.name) || file.type.startsWith('text/')) return { file: null, text: await file.text() }
  throw new Error(/\.doc$/i.test(file.name) ? 'Old .doc files aren\'t supported — save it as .docx or PDF.' : 'Use a PDF, Word (.docx), image or text file.')
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
  const updateUpload = (id: string, patch: Partial<UploadItem>) =>
    set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) }))

  /** A batch is done: fold the new uploads into the master. */
  async function finishBatch(batch: string) {
    const items = get().uploads.filter((u) => u.batch === batch)
    if (items.some((u) => u.status === 'preparing' || u.status === 'reading') || !items.some((u) => u.status === 'saved')) return
    const target = batchTargets.get(batch)
    batchTargets.delete(batch)
    if (!target || !binding || get().task?.status === 'running') return
    const all = await binding.store.listResumes()
    await get().merge(target, all.filter((r) => r.kind === 'source'), all.find((r) => r.kind === 'master') ?? null)
  }

  function followUpload(item: UploadItem) {
    if (!item.job_id || item.status !== 'reading' || followingUploads.has(item.job_id)) return
    const jobId = item.job_id
    followingUploads.set(jobId, followJob(jobId, (e) => {
      if (e.type !== 'done' && e.type !== 'error') return
      followingUploads.delete(jobId)
      void (async () => {
        if (e.type === 'error') updateUpload(item.id, { status: 'error', error: e.message })
        else {
          const parsed = safeNormalize(parseLooseResume(e.output))
          if (!parsed.ok || !binding) updateUpload(item.id, { status: 'error', error: "The agent couldn't make sense of that file." })
          else {
            try {
              // The first resume becomes the one auto-fill uses.
              const first = !(await binding.store.listResumes()).some((r) => r.is_current)
              const row = await binding.store.addResume({ name: item.name, kind: 'source', parsed_json: parsed.resume, set_current: first })
              updateUpload(item.id, { status: 'saved', result_id: row.id })
              binding.onData()
            } catch (err) {
              updateUpload(item.id, { status: 'error', error: (err as Error).message })
            }
          }
        }
        await finishBatch(item.batch)
      })()
    }))
  }

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

    uploads: [],

    bind(userId, next) {
      binding = next
      if (get().userId !== userId) {
        following?.stop()
        following = null
        followingUploads.forEach((stop) => stop())
        followingUploads.clear()
        set({ userId, ...restore(userId) })
      }
      const task = get().task
      if (task) follow(task)
      get().uploads.forEach(followUpload)
    },

    async upload(target, files) {
      const batch = crypto.randomUUID()
      batchTargets.set(batch, target)
      const items: UploadItem[] = files.map((f) => ({ id: crypto.randomUUID(), name: baseName(f), status: 'preparing', job_id: null, batch }))
      set((s) => ({ uploads: [...s.uploads.filter((u) => u.status === 'preparing' || u.status === 'reading'), ...items] }))
      await Promise.all(files.map(async (file, i) => {
        const item = items[i]
        try {
          const input = await prepare(file)
          const jobId = await startJob(target.runtime.id, target.agent.id, 'resume_parse', { name: item.name, ...input })
          updateUpload(item.id, { status: 'reading', job_id: jobId })
          followUpload({ ...item, status: 'reading', job_id: jobId })
        } catch (e) {
          updateUpload(item.id, { status: 'error', error: e instanceof ApiError ? e.message : (e as Error).message })
          await finishBatch(batch)
        }
      }))
    },

    clearUploads() {
      set((s) => ({ uploads: s.uploads.filter((u) => u.status === 'preparing' || u.status === 'reading') }))
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
    sessionStorage.setItem(key(s.userId), JSON.stringify({ task: s.task, uploads: s.uploads }))
  } catch {
    // storage blocked — a reload just won't pick the task back up
  }
})
