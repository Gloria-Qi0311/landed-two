// Agent CLIs the daemon can drive, and how to run a Landed task with one.
//
// Safety: tasks are a fixed set of kinds (just `chat` for now). The user's
// message goes to the agent on stdin (never through a shell), the agent runs
// in an empty workspace directory, ignores the user's own Claude Code
// settings/hooks, and only gets read-only web tools — no files, no shell.
import { spawn, spawnSync } from 'node:child_process'
import { knownSessions, rememberSession, workspace } from './config.ts'

export type AgentInfo = { id: string; label: string; version: string | null }

export type TaskEvent =
  | { type: 'started'; agent: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; session_id?: string }
  | { type: 'error'; message: string }

export type Task = { id: string; agent: string; kind: string; input: Record<string, unknown> }

// Codex / Gemini CLI get runners next; only agents we can run are reported.
const SUPPORTED = [{ id: 'claude', label: 'Claude Code', bin: 'claude' }]

export function detectAgents(): AgentInfo[] {
  const found: AgentInfo[] = []
  for (const a of SUPPORTED) {
    const r = spawnSync(a.bin, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    if (r.status === 0) found.push({ id: a.id, label: a.label, version: r.stdout.trim().split('\n')[0] || null })
  }
  return found
}

const CHAT_SYSTEM_PROMPT = [
  "You are Landed's job-search assistant, running on the user's own computer through the Landed app.",
  'Help the user work out what job they want next: roles, seniority, locations or remote, salary floor,',
  'industries, companies they like or want to avoid, visa needs, and timing. Ask one or two focused',
  'questions at a time, keep replies short, and use web search when it helps (company or market facts).',
  "Reply in the user's language.",
].join(' ')

const WEB_TOOLS = ['WebSearch', 'WebFetch']

/** Arguments for one `claude -p` chat turn. The conversation id doubles as
 *  the Claude Code session id, so later turns resume the same session. */
export function claudeChatArgs(conversationId: string, resume: boolean): string[] {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(resume ? ['--resume', conversationId] : ['--session-id', conversationId]),
    '--tools', ...WEB_TOOLS,
    '--allowedTools', ...WEB_TOOLS,
    '--setting-sources', '',
    '--append-system-prompt', CHAT_SYSTEM_PROMPT,
  ]
}

/** One line of `claude --output-format stream-json` → task events. */
export function parseClaudeLine(line: string): TaskEvent[] {
  let e: Record<string, any>
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
    return e.event.delta.text ? [{ type: 'delta', text: e.event.delta.text }] : []
  }
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    return e.message.content
      .filter((c: any) => c?.type === 'tool_use' || c?.type === 'server_tool_use')
      .map((c: any) => ({ type: 'tool', name: String(c.name ?? 'tool') }))
  }
  if (e.type === 'result') {
    return e.is_error || e.subtype !== 'success'
      ? [{ type: 'error', message: String(e.result ?? e.subtype ?? 'Claude Code reported an error') }]
      : [{ type: 'done', text: String(e.result ?? ''), session_id: e.session_id }]
  }
  return []
}

const TASK_TIMEOUT_MS = 5 * 60_000

export function runTask(task: Task, emit: (e: TaskEvent) => void): Promise<void> {
  if (task.kind !== 'chat') return Promise.resolve(emit({ type: 'error', message: `Unsupported task: ${task.kind}` }))
  if (task.agent !== 'claude') return Promise.resolve(emit({ type: 'error', message: `${task.agent} isn't supported yet.` }))
  const conversationId = String(task.input.conversation_id ?? '')
  const message = String(task.input.message ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !message.trim()) {
    return Promise.resolve(emit({ type: 'error', message: 'Bad chat task.' }))
  }

  return new Promise((resolve) => {
    const resume = knownSessions().has(conversationId)
    const child = spawn('claude', claudeChatArgs(conversationId, resume), { cwd: workspace(), stdio: ['pipe', 'pipe', 'pipe'] })
    emit({ type: 'started', agent: 'claude' })
    let finished = false
    let stderr = ''
    let pending = ''
    const finish = (e?: TaskEvent) => {
      if (finished) return
      if (e) emit(e)
      finished = e?.type === 'done' || e?.type === 'error' || finished
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ type: 'error', message: 'The agent took too long (5 min) and was stopped.' })
    }, TASK_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        for (const e of parseClaudeLine(line)) {
          if (e.type === 'done') rememberSession(conversationId)
          if (e.type === 'done' || e.type === 'error') finish(e)
          else if (!finished) emit(e)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (err) => finish({ type: 'error', message: `Couldn't start Claude Code: ${err.message}` }))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!finished) {
        finish({ type: 'error', message: `Claude Code exited (${code ?? 'killed'})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}` })
      }
      resolve()
    })
    child.stdin.end(message)
  })
}
