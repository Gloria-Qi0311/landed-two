// Codex CLI (OpenAI) as a Landed agent: `codex exec --json`, one process
// per task, on the user's own ChatGPT plan.
//
// Safety, by flags: an empty workspace, the read-only sandbox, no shell tool
// at all, approvals off (a request is refused, not asked), and the user's
// own config.toml (MCP servers, hooks, profiles) and rules ignored. Web
// search is on only for tasks that need the web. The result is bound to a
// JSON Schema (--output-schema). Codex validates it strictly, so the schema
// is made strict-compatible first (every field required, optional ones
// nullable) and the nulls are dropped again before the result goes on.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { workspace } from './config.ts'
import { doneFromOutput, jsonFromText, type Spec, type TaskEvent } from './types.ts'

/** Find the CLI whether Codex was installed in PATH or bundled with the
 * desktop app. The desktop bundle path is not normally in launchd's PATH. */
export function findCodex(path = process.env.PATH ?? ''): string | null {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, 'codex')),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate))]
    .find((candidate) => existsSync(candidate)) ?? null
}

export const CODEX_KINDS = ['job_search', 'resume_parse', 'resume_merge', 'resume_tailor']

/** Installed and signed in → its version; otherwise why not (for the log). */
/** The Codex CLI: on the PATH, or the one inside ChatGPT.app / Codex.app,
 *  which isn't on the PATH (findCodex). */
const codexBin = () => findCodex() ?? 'codex'

export function detectCodex(): { version: string } | { missing: string } | null {
  const v = spawnSync(codexBin(), ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (v.status !== 0) return null
  const login = spawnSync(codexBin(), ['login', 'status'], { encoding: 'utf8', timeout: 15_000 })
  if (login.status !== 0) return { missing: 'Codex is installed but not signed in — run `codex login` once.' }
  return { version: v.stdout.trim().split('\n')[0].replace(/^codex-cli\s+/, '') }
}

// ── strict schemas ────────────────────────────────────────────────────────

type Schema = Record<string, unknown>

function nullable(s: Schema): Schema {
  if (Array.isArray(s.enum)) return { ...s, type: [s.type, 'null'], enum: [...s.enum, null] }
  if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'] }
  return { anyOf: [s, { type: 'null' }] }
}

/** OpenAI strict mode: every object lists all its properties as required
 *  and allows no others; optional ones become nullable. */
export function strictSchema(schema: Schema): Schema {
  const { maxItems: _max, minItems: _min, ...s } = schema
  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, Schema>
    const required = new Set((s.required ?? []) as string[])
    const properties = Object.fromEntries(Object.entries(props).map(([k, v]) => {
      const strict = strictSchema(v)
      return [k, required.has(k) ? strict : nullable(strict)]
    }))
    return { ...s, properties, required: Object.keys(props), additionalProperties: false }
  }
  if (s.type === 'array' && s.items) return { ...s, items: strictSchema(s.items as Schema) }
  return s
}

/** Strict results carry null for "not given": drop those keys again. */
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]))
  }
  return v
}

// ── running ───────────────────────────────────────────────────────────────

/** The developer instructions, as a TOML string for `-c` (JSON's string
 *  escapes are valid TOML basic-string escapes). */
const toml = (s: string) => JSON.stringify(s)

export function codexArgs(spec: Spec, schemaFile: string): string[] {
  return [
    'exec', '--json',
    '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', // no MCP servers, hooks or profiles of the user's
    '--sandbox', 'read-only',
    '--disable', 'shell_tool', '--disable', 'unified_exec', // no commands at all
    '-c', 'approval_policy="never"',
    '-c', `web_search="${spec.web === 'none' ? 'disabled' : 'live'}"`,
    '-c', `developer_instructions=${toml(spec.system)}`,
    '-C', workspace(),
    '--output-schema', schemaFile,
    // The prompt comes on stdin (no PROMPT argument), so images can go last.
    ...(spec.images ?? []).flatMap((file) => ['-i', file]),
  ]
}

/** What one line of `codex exec --json` means for the task. `message`: the
 *  agent's (latest) answer; `failed`: the turn is over and it failed. */
export function parseCodexLine(line: string): { event?: TaskEvent; message?: string; failed?: string; web?: boolean; completed?: boolean; thread?: string } {
  let e: Record<string, any>
  try {
    e = JSON.parse(line)
  } catch {
    return {}
  }
  if (e.type === 'thread.started' && typeof e.thread_id === 'string') return { thread: e.thread_id }
  if (e.type === 'turn.completed') return { completed: true }
  if (e.type === 'turn.failed') return { failed: String(e.error?.message ?? 'Codex reported an error') }
  if ((e.type === 'item.started' || e.type === 'item.completed') && e.item && typeof e.item === 'object') {
    const item = e.item
    if (item.type === 'agent_message' && e.type === 'item.completed') return { message: String(item.text ?? '') }
    if (item.type === 'web_search' && e.type === 'item.started') return { event: { type: 'tool', name: 'Web search' }, web: true }
    if (item.type === 'mcp_tool_call' && e.type === 'item.started') return { event: { type: 'tool', name: `${item.server}:${item.tool}` } }
  }
  return {}
}

export function runCodex(spec: Spec, emit: (e: TaskEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (e: TaskEvent) => {
      if (finished) return
      finished = true
      emit(e)
    }
    emit({ type: 'started', agent: 'codex' })
    // The schema goes in a file of its own, removed afterwards.
    const dir = join(workspace(), '.codex-task', String(process.pid) + '-' + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const schemaFile = join(dir, 'schema.json')
    writeFileSync(schemaFile, JSON.stringify(strictSchema(spec.schema)), { mode: 0o600 })
    const child = spawn(codexBin(), codexArgs(spec, schemaFile), { cwd: workspace(), stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ type: 'error', message: `The agent took too long (${Math.round(spec.timeoutMs / 60_000)} min) and was stopped.` })
    }, spec.timeoutMs)

    let message = ''
    let failed = ''
    let usedWeb = false
    let completed = false
    let lastError = ''
    let pending = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const r = parseCodexLine(line)
        if (r.event && !finished) emit(r.event)
        if (r.message !== undefined) message = r.message
        if (r.web) usedWeb = true
        if (r.failed) failed = r.failed
        if (r.completed) completed = true
        try {
          const e = JSON.parse(line)
          if (e.type === 'error' && typeof e.message === 'string') lastError = e.message
        } catch {
          // not JSON
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (err) => finish({ type: 'error', message: `Couldn't start Codex: ${err.message}` }))
    child.on('close', (code) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      try {
        spec.cleanup?.()
      } catch {
        // best effort
      }
      if (!completed || failed) {
        const why = failed || lastError || stderr.trim().split('\n').pop() || `exited (${code ?? 'killed'})`
        finish({ type: 'error', message: /401|unauthori[sz]ed|not logged in/i.test(why) ? 'Codex on this computer is signed out — run `codex login` once.' : `Codex: ${why}` })
      } else if (spec.requireWeb && !usedWeb) {
        finish({ type: 'error', message: "Codex didn't search the web this time, so its results would be made up. Nothing was saved." })
      } else {
        const out = jsonFromText(message)
        finish(out && typeof out === 'object'
          ? doneFromOutput(dropNulls(out), '')
          : { type: 'error', message: "Codex's answer wasn't in the expected format. Try again." })
      }
      resolve()
    })
    child.stdin.end(spec.prompt)
  })
}
