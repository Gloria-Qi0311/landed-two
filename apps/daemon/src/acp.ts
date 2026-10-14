// Every other agent: anything that speaks ACP, the Agent Client Protocol
// (agentclientprotocol.com) — Gemini CLI, GitHub Copilot CLI, Cursor,
// Goose, OpenCode, Qwen Code, Kimi and more. One client for all of them:
// JSON-RPC over the agent's stdin/stdout, one process per task.
//
// Safety, by protocol rather than per-agent flags:
//   - the agent runs in an empty workspace with no MCP servers from us, and
//     we offer it no file system and no terminal (client capabilities off);
//   - every permission request is answered by policy: a task allows only
//     the tool kinds it needs (web search / page reads for web tasks,
//     nothing for text tasks) and edit, delete, move and execute never;
//   - an agent that runs one of those without asking is stopped, and the
//     task fails;
//   - a result that needed the web only counts if the agent used it.
// Agents known here are found on PATH; more can be added in
// ~/.landed/agents.json ([{ "id", "label", "command", "args" }]), which
// only the user can write — the server never sends commands.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home, workspace } from './config.ts'
import { doneFromOutput, jsonFromText, type Spec, type TaskEvent } from './types.ts'

export type AcpAgent = { id: string; label: string; command: string; args: string[] }

/** Launch commands from the ACP registry (cdn.agentclientprotocol.com). */
export const KNOWN_ACP_AGENTS: AcpAgent[] = [
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp'] },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', args: ['acp'] },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen', args: ['--acp'] },
  { id: 'goose', label: 'Goose', command: 'goose', args: ['acp'] },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'] },
  { id: 'kimi', label: 'Kimi CLI', command: 'kimi', args: ['acp'] },
  { id: 'kilo', label: 'Kilo', command: 'kilo', args: ['acp'] },
  { id: 'auggie', label: 'Auggie', command: 'auggie', args: ['--acp'] },
  { id: 'cline', label: 'Cline', command: 'cline', args: ['--acp'] },
  { id: 'devin', label: 'Devin', command: 'devin', args: ['acp'] },
  { id: 'droid', label: 'Factory Droid', command: 'droid', args: ['exec', '--output-format', 'acp-daemon'] },
  { id: 'vibe', label: 'Mistral Vibe', command: 'vibe-acp', args: [] },
  { id: 'qoder', label: 'Qoder', command: 'qodercli', args: ['--acp'] },
  { id: 'grok', label: 'Grok', command: 'grok', args: ['agent', 'stdio'] },
]

export const ACP_KINDS = ['chat', 'job_search', 'resume_parse', 'resume_merge', 'resume_tailor']

const ID = /^[a-z0-9][a-z0-9_-]{0,30}$/

/** The user's own additions (~/.landed/agents.json); bad entries are skipped. */
export function userAcpAgents(file = join(home(), 'agents.json')): AcpAgent[] {
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return (Array.isArray(raw) ? raw : []).flatMap((a) => {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ID.test(a.id) || typeof a.command !== 'string' || !a.command) return []
      if (['claude', 'codex'].includes(a.id)) return []
      const args = Array.isArray(a.args) ? a.args.filter((x: unknown): x is string => typeof x === 'string') : []
      return [{ id: a.id, label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 60) : a.id, command: a.command, args }]
    })
  } catch {
    return []
  }
}

/** Known agents installed here, plus the user's own (theirs win on id). */
export function acpCandidates(): AcpAgent[] {
  const mine = userAcpAgents()
  const known = KNOWN_ACP_AGENTS.filter((a) => !mine.some((m) => m.id === a.id) && onPath(a.command))
  return [...known, ...mine]
}

function onPath(command: string): boolean {
  if (command.includes('/')) return existsSync(command)
  return (process.env.PATH ?? '').split(':').filter(Boolean).some((dir) => existsSync(join(dir, command)))
}

// ── JSON-RPC over stdio ───────────────────────────────────────────────────

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }
export class RpcError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  stderr = ''
  closed = false
  onNotification: (method: string, params: any) => void = () => {}
  /** Requests from the agent (permission, files, terminal); throw RpcError to refuse. */
  onRequest: (method: string, params: any) => Promise<unknown> = async (method) => {
    throw new RpcError(`Method not found: ${method}`, -32601)
  }

  constructor(agent: AcpAgent, cwd: string) {
    this.child = spawn(agent.command, agent.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.read(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    const gone = (why: string) => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error(why))
      this.pending.clear()
    }
    this.child.on('error', (err) => gone(`couldn't start ${agent.command}: ${err.message}`))
    this.child.on('close', (code) => gone(`${agent.label} exited (${code ?? 'killed'})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`))
    this.child.stdin.on('error', () => {}) // the agent went away mid-write; 'close' reports it
  }

  private write(msg: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private read(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue // agents sometimes log to stdout
      }
      if (!msg || typeof msg !== 'object') continue
      if ('id' in msg && msg.method === undefined) {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'error'), Number(msg.error.code ?? 0)))
        else p.resolve(msg.result)
      } else if (typeof msg.method === 'string' && 'id' in msg) {
        this.onRequest(msg.method, msg.params).then(
          (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
          (err) => this.write({
            jsonrpc: '2.0', id: msg.id,
            error: { code: err instanceof RpcError ? err.code : -32603, message: (err as Error).message },
          }),
        )
      } else if (typeof msg.method === 'string') {
        this.onNotification(msg.method, msg.params)
      }
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('the agent has exited'))
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  close() {
    if (this.closed) return
    this.child.stdin.end()
    this.child.kill('SIGTERM')
    const hard = setTimeout(() => { if (!this.closed) this.child.kill('SIGKILL') }, 2000)
    hard.unref()
  }
}

const CLIENT_INFO = { name: 'landed', title: 'Landed', version: '0.5.0' }

async function open(agent: AcpAgent, cwd: string) {
  const conn = new AcpConnection(agent, cwd)
  const init = await conn.request<Record<string, any>>('initialize', {
    protocolVersion: 1,
    // No file system and no terminal from us: the agent can't ask Landed to
    // read or write files or run commands.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: CLIENT_INFO,
  })
  return { conn, init }
}

const authProblem = (e: unknown) =>
  e instanceof RpcError && (e.code === -32000 || /auth|sign.?in|log.?in|credential|api key/i.test(e.message))

/** Can it run here? Starts it and opens a session — no model call. */
export async function probeAcp(agent: AcpAgent, timeoutMs = 20_000): Promise<{ version: string | null; images: boolean } | { missing: string }> {
  let conn: AcpConnection | null = null
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref())
  try {
    return await Promise.race([timeout, (async () => {
      const opened = await open(agent, workspace())
      conn = opened.conn
      await conn.request('session/new', { cwd: workspace(), mcpServers: [] })
      const info = opened.init.agentInfo as { version?: string } | undefined
      return { version: typeof info?.version === 'string' ? info.version : null, images: opened.init.agentCapabilities?.promptCapabilities?.image === true }
    })()])
  } catch (e) {
    return { missing: authProblem(e) ? `${agent.label} is installed but not signed in — open it once in Terminal and sign in.` : `${agent.label} didn't start in ACP mode (${(e as Error).message}).` }
  } finally {
    (conn as AcpConnection | null)?.close()
  }
}

// ── what a task may do ────────────────────────────────────────────────────

const NEVER = new Set(['edit', 'delete', 'move', 'execute'])

/** The tool kinds a task allows when the agent asks. */
export function allowedKinds(spec: Pick<Spec, 'web'>): Set<string> {
  if (spec.web === 'search') return new Set(['search', 'fetch'])
  if (spec.web === 'fetch') return new Set(['fetch'])
  return new Set()
}

/** Answer a session/request_permission by policy. */
export function decidePermission(params: any, allowed: Set<string>): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const kind = String(params?.toolCall?.kind ?? 'other')
  const options = (Array.isArray(params?.options) ? params.options : []) as { optionId: string; kind: string }[]
  const allow = allowed.has(kind) && !NEVER.has(kind)
  const pick = allow
    ? options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
    : options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
}

/** The message: instructions first (ACP has no system prompt), then the
 *  task, then how to answer. */
export function acpPrompt(spec: Spec): string {
  return [
    '<instructions>',
    spec.system,
    '</instructions>',
    '',
    spec.prompt,
    ...(spec.schema ? [
      '',
      'When you are done, reply with only the result as JSON in one ```json code block, following this JSON Schema:',
      JSON.stringify(spec.schema),
    ] : []),
  ].join('\n')
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

export async function runAcp(agent: AcpAgent, spec: Spec, emit: (e: TaskEvent) => void): Promise<void> {
  emit({ type: 'started', agent: agent.id })
  let conn: AcpConnection | null = null
  let finished = false
  const finish = (e: TaskEvent) => {
    if (finished) return
    finished = true
    emit(e)
  }
  const allowed = allowedKinds(spec)
  const approved = new Set<string>()
  const seen = new Map<string, { kind: string; title: string }>()
  let usedWeb = false
  let violation: string | null = null
  let text = ''
  let afterTool = ''
  let sessionId: string | null = null

  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The agent took too long (${Math.round(spec.timeoutMs / 60_000)} min) and was stopped.`)), spec.timeoutMs)
  })
  let stop: (why: string) => void = () => {}
  const stopped = new Promise<never>((_, reject) => { stop = (why) => reject(new Error(why)) })

  try {
    await Promise.race([timedOut, stopped, (async () => {
      const opened = await open(agent, workspace())
      conn = opened.conn
      const c = conn
      c.onRequest = async (method, params) => {
        if (method === 'session/request_permission') {
          const answer = decidePermission(params, allowed)
          const id = String(params?.toolCall?.toolCallId ?? '')
          if (answer.outcome.outcome === 'selected' && allowed.has(String(params?.toolCall?.kind))) approved.add(id)
          return answer
        }
        throw new RpcError(`Landed doesn't offer ${method}`, -32601)
      }
      c.onNotification = (method, params) => {
        if (method !== 'session/update') return
        const u = params?.update
        if (!u || typeof u !== 'object') return
        if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          const chunk = String(u.content.text ?? '')
          text += chunk
          afterTool += chunk
          if (!spec.schema && !finished) emit({ type: 'delta', text: chunk })
        }
        if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          const id = String(u.toolCallId ?? '')
          const prev = seen.get(id)
          const kind = String(u.kind ?? prev?.kind ?? 'other')
          const title = String(u.title ?? prev?.title ?? 'tool')
          seen.set(id, { kind, title })
          if (u.sessionUpdate === 'tool_call') {
            afterTool = ''
            if (!finished) emit({ type: 'tool', name: title })
          }
          const ran = u.status === 'in_progress' || u.status === 'completed'
          if (ran && (kind === 'search' || kind === 'fetch')) usedWeb = true
          // Ran something it may never run, without asking (or after a no).
          if (ran && NEVER.has(kind) && !approved.has(id)) {
            violation = `${agent.label} tried to ${kind === 'execute' ? 'run a command' : `${kind} files`} ("${title}") without permission, so Landed stopped it. Nothing was saved.`
            stop(violation)
          }
        }
      }

      const session = await c.request<{ sessionId: string }>('session/new', { cwd: workspace(), mcpServers: [] }).catch((e) => {
        throw authProblem(e) ? new Error(`${agent.label} isn't signed in on this computer — open it once in Terminal and sign in.`) : e
      })
      sessionId = session.sessionId
      const content: unknown[] = [{ type: 'text', text: acpPrompt(spec) }]
      if (spec.images?.length) {
        if (opened.init.agentCapabilities?.promptCapabilities?.image !== true) throw new Error(`${agent.label} can't read images.`)
        for (const file of spec.images) {
          const ext = file.split('.').pop()?.toLowerCase() ?? ''
          content.push({ type: 'image', mimeType: IMAGE_TYPES[ext] ?? 'image/png', data: readFileSync(file).toString('base64') })
        }
      }
      const turn = await c.request<{ stopReason: string }>('session/prompt', { sessionId: session.sessionId, prompt: content })
      if (turn.stopReason === 'refusal') throw new Error(`${agent.label} declined this task.`)
      if (turn.stopReason !== 'end_turn') throw new Error(`${agent.label} stopped early (${turn.stopReason}).`)

      if (spec.requireWeb && !usedWeb) throw new Error(`${agent.label} didn't search the web this time, so its results would be made up. Nothing was saved.`)
      const answer = afterTool.trim() || text.trim()
      if (!spec.schema) return finish({ type: 'done', text: answer })
      let out = jsonFromText(answer) ?? jsonFromText(text)
      if (!out || typeof out !== 'object') {
        // One more turn in the same session: just the JSON, please.
        text = ''
        afterTool = ''
        const again = await c.request<{ stopReason: string }>('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply with only the result as JSON in one ```json code block, following the JSON Schema above. No other text.' }],
        })
        if (again.stopReason === 'end_turn') out = jsonFromText(text)
      }
      finish(out && typeof out === 'object'
        ? doneFromOutput(out, '')
        : { type: 'error', message: `${agent.label}'s answer wasn't in the expected format. Try again.` })
    })()])
  } catch (e) {
    finish({ type: 'error', message: violation ?? (e as Error).message })
  } finally {
    clearTimeout(timer)
    const c = conn as AcpConnection | null
    if (c && !c.closed) {
      if (sessionId) c.notify('session/cancel', { sessionId })
      c.close()
    }
    try {
      spec.cleanup?.()
    } catch {
      // best effort
    }
  }
}

/** `which`-style check used by `landed status`. */
export function acpVersionHint(agent: AcpAgent): string | null {
  const r = spawnSync(agent.command, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] || null : null
}
