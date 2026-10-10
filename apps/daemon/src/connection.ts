// Talking to the Landed server: say hello, hold an SSE stream of tasks
// (reconnecting with backoff), and post task output back in small batches.
import type { AgentInfo, Task, TaskEvent } from './agents.ts'

export type SseEvent = { event: string; data: string }

/** Incremental SSE parser: feed text, get complete events back. */
export function createSseParser() {
  let buf = ''
  return (chunk: string): SseEvent[] => {
    buf += chunk.replace(/\r\n/g, '\n')
    const out: SseEvent[] = []
    let i: number
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue // comment / heartbeat
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) out.push({ event, data: data.join('\n') })
    }
    return out
  }
}

export class AuthError extends Error {}

export class LandedClient {
  private server: string
  private token: string

  constructor(server: string, token: string) {
    this.server = server.replace(/\/+$/, '')
    this.token = token
  }

  private async request(path: string, init: RequestInit = {}) {
    const res = await fetch(this.server + path, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    if (res.status === 401) throw new AuthError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'unauthorized')
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}`)
    return res
  }

  async hello(info: { name: string; agents: AgentInfo[]; daemon_version: string }) {
    return (await this.request('/api/runtime/hello', { method: 'POST', body: JSON.stringify(info) })).json()
  }

  async postEvents(taskId: string, events: TaskEvent[]) {
    await this.request(`/api/runtime/jobs/${taskId}/events`, { method: 'POST', body: JSON.stringify({ events }) })
  }

  /** Streams tasks until aborted; resolves when the connection ends. */
  async stream(onTask: (t: Task) => void, onReady: () => void, signal?: AbortSignal) {
    const res = await this.request('/api/runtime/stream', { headers: { Accept: 'text/event-stream' }, signal })
    const parse = createSseParser()
    const decoder = new TextDecoder()
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const e of parse(decoder.decode(chunk, { stream: true }))) {
        if (e.event === 'ready') onReady()
        if (e.event === 'job') onTask(JSON.parse(e.data))
      }
    }
  }
}

/** Buffers a task's events: deltas coalesce for ~150ms, everything else
 *  flushes right away. Errors posting are retried a few times, then dropped. */
export function createEventSink(client: LandedClient, taskId: string) {
  let queue: TaskEvent[] = []
  let timer: NodeJS.Timeout | null = null
  let chain = Promise.resolve()

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (queue.length === 0) return chain
    const batch = coalesce(queue)
    queue = []
    chain = chain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.postEvents(taskId, batch)
          return
        } catch (e) {
          if (e instanceof AuthError) return
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
      }
    })
    return chain
  }

  return {
    emit(e: TaskEvent) {
      queue.push(e)
      if (e.type === 'delta') timer ??= setTimeout(flush, 150)
      else void flush()
    },
    flush,
  }
}

/** Merge consecutive deltas into one. */
export function coalesce(events: TaskEvent[]): TaskEvent[] {
  const out: TaskEvent[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (e.type === 'delta' && last?.type === 'delta') last.text += e.text
    else out.push(e.type === 'delta' ? { ...e } : e)
  }
  return out
}
