// In-memory relay between the web app and users' daemons (apps/daemon).
//
//   web  ──POST /runtime-jobs──▶ hub.dispatch ──SSE `job`──▶ daemon
//   web  ◀──SSE job events──── hub.push ◀──POST events──── daemon
//
// Nothing here is persisted: job input and output live in memory only until
// the job finishes and its listeners have had a chance to read it (GC after
// an hour). Single server process, so a Map is enough.

export type JobEvent =
  | { type: 'started'; agent: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; session_id?: string }
  | { type: 'error'; message: string }

export type Job = {
  id: string
  user_id: string
  runtime_id: string
  agent: string
  kind: string
  input: Record<string, unknown>
  created_at: number
}

type JobState = Job & { events: JobEvent[]; finished: boolean; listeners: Set<(e: JobEvent) => void> }
type Daemon = { send: (job: Job) => void; close: () => void }

const JOB_TTL_MS = 60 * 60_000

export class RuntimeHub {
  private daemons = new Map<string, Set<Daemon>>()
  private jobs = new Map<string, JobState>()

  connect(runtimeId: string, daemon: Daemon): () => void {
    let set = this.daemons.get(runtimeId)
    if (!set) this.daemons.set(runtimeId, (set = new Set()))
    set.add(daemon)
    return () => {
      set.delete(daemon)
      if (set.size === 0) this.daemons.delete(runtimeId)
      // Fail jobs this daemon was running so the web stops waiting.
      if (!this.daemons.has(runtimeId)) {
        for (const job of this.jobs.values()) {
          if (job.runtime_id === runtimeId && !job.finished) this.push(job.id, runtimeId, [{ type: 'error', message: 'Your computer disconnected.' }])
        }
      }
    }
  }

  isOnline(runtimeId: string) {
    return this.daemons.has(runtimeId)
  }

  /** Revoked: drop every live connection for this runtime. */
  disconnect(runtimeId: string) {
    for (const d of this.daemons.get(runtimeId) ?? []) d.close()
    this.daemons.delete(runtimeId)
  }

  /** Returns false when the runtime isn't connected. */
  dispatch(job: Job): boolean {
    this.gc()
    const daemons = this.daemons.get(job.runtime_id)
    const daemon = daemons && [...daemons][daemons.size - 1] // newest connection
    if (!daemon) return false
    this.jobs.set(job.id, { ...job, events: [], finished: false, listeners: new Set() })
    daemon.send(job)
    return true
  }

  /** Events from a daemon; ignored unless the job was dispatched to it. */
  push(jobId: string, runtimeId: string, events: JobEvent[]): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.runtime_id !== runtimeId || job.finished) return false
    for (const e of events) {
      job.events.push(e)
      job.listeners.forEach((l) => l(e))
      if (e.type === 'done' || e.type === 'error') {
        job.finished = true
        break
      }
    }
    return true
  }

  /** Replays what happened so far, then streams the rest. Null if the job
   *  doesn't exist or isn't this user's. */
  subscribe(jobId: string, userId: string, listener: (e: JobEvent) => void): { replay: JobEvent[]; finished: boolean; unsubscribe: () => void } | null {
    const job = this.jobs.get(jobId)
    if (!job || job.user_id !== userId) return null
    job.listeners.add(listener)
    return { replay: [...job.events], finished: job.finished, unsubscribe: () => job.listeners.delete(listener) }
  }

  private gc() {
    const cutoff = Date.now() - JOB_TTL_MS
    for (const [id, job] of this.jobs) if (job.created_at < cutoff) this.jobs.delete(id)
  }
}
