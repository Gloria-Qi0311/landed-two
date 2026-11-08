// What every agent runner shares: the task the server sent, the events a
// run streams back, and the agent-neutral description of a task (`Spec`)
// that runners for agents other than Claude Code work from.

export type TaskEvent =
  | { type: 'started'; agent: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; session_id?: string; jobs?: unknown[]; findings?: unknown[]; output?: unknown }
  | { type: 'error'; message: string }

export type Task = { id: string; agent: string; kind: string; input: Record<string, unknown> }

/** A task as any agent can run it: instructions, the message, the shape of
 *  the result, and what the agent may use — nothing else. */
export type Spec = {
  kind: string
  /** instructions (a system or developer prompt) */
  system: string
  /** the user's message */
  prompt: string
  /** JSON Schema of the result; null for chat (free text) */
  schema: Record<string, unknown> | null
  /** none: no tools at all; fetch: read one page; search: search the web and read pages */
  web: 'none' | 'fetch' | 'search'
  /** images to look at (absolute paths), e.g. a resume photo */
  images?: string[]
  /** results only count if the agent actually used the web (else they're made up) */
  requireWeb?: boolean
  timeoutMs: number
  /** runs when the agent exits, whatever happened */
  cleanup?: () => void
}

/** A structured result → the `done` event the browser expects (jobs,
 *  findings, or the whole object as `output`). */
export function doneFromOutput(out: unknown, text: string, sessionId?: string): Extract<TaskEvent, { type: 'done' }> {
  const o = out as Record<string, unknown> | null
  const summary = typeof o?.summary === 'string' ? o.summary : text
  const base = { type: 'done' as const, text: summary, ...(sessionId ? { session_id: sessionId } : {}) }
  if (o && typeof o === 'object' && Array.isArray(o.jobs)) return { ...base, jobs: o.jobs }
  if (o && typeof o === 'object' && Array.isArray(o.findings)) return { ...base, findings: o.findings }
  if (o && typeof o === 'object') return { ...base, output: o }
  return { type: 'done', text, ...(sessionId ? { session_id: sessionId } : {}) }
}

/** The JSON an agent ended its answer with: a ```json block (the last one),
 *  or the whole answer when it is JSON. Null when there is none. */
export function jsonFromText(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (const candidate of [...blocks.reverse(), text]) {
    const t = candidate.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) continue
    try {
      return JSON.parse(t)
    } catch {
      // try the next one
    }
  }
  // An answer with words around a bare object: from the first { to the last }.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // not JSON
    }
  }
  return null
}
