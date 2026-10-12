// Agent CLIs the daemon can drive, and how to run a Landed task with one.
//
// Safety: tasks are a fixed set of kinds (`chat`, `job_search`). Input goes
// to the agent on stdin (never through a shell), the agent runs in an empty
// workspace directory, ignores the user's own Claude Code settings/hooks,
// and only gets read-only web tools — no files, no shell.
import { spawn, spawnSync } from 'node:child_process'
import { knownSessions, rememberSession, workspace } from './config.ts'

export type AgentInfo = { id: string; label: string; version: string | null; kinds: string[] }

export type TaskEvent =
  | { type: 'started'; agent: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; text: string; session_id?: string; jobs?: unknown[] }
  | { type: 'error'; message: string }

export type Task = { id: string; agent: string; kind: string; input: Record<string, unknown> }

// Codex / Gemini CLI get runners next; only agents we can run are reported,
// with the task kinds they can run (the server only sends those).
const SUPPORTED = [{ id: 'claude', label: 'Claude Code', bin: 'claude', kinds: ['chat', 'job_search'] }]

export function detectAgents(): AgentInfo[] {
  const found: AgentInfo[] = []
  for (const a of SUPPORTED) {
    const r = spawnSync(a.bin, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    if (r.status === 0) found.push({ id: a.id, label: a.label, version: r.stdout.trim().split('\n')[0] || null, kinds: a.kinds })
  }
  return found
}

const WEB_TOOLS = ['WebSearch', 'WebFetch']

// ── chat ──────────────────────────────────────────────────────────────────

// The brief block format is parsed by the web app
// (packages/schema/src/search-brief.ts → extractBrief); keep them in sync.
const CHAT_SYSTEM_PROMPT = [
  "You are Landed's job-search assistant, running on the user's own computer through the Landed app.",
  'Help the user work out what job they want next: roles, seniority, locations or remote, salary floor,',
  'industries, companies they like or want to avoid, visa needs, and timing. Ask one or two focused',
  'questions at a time, keep replies short, and use web search when it helps (company or market facts).',
  "Reply in the user's language.",
  '',
  'Once you know enough to search (at least the kind of role, and where), summarize the direction in a',
  'sentence or two, ask the user to confirm, and end that reply with a search brief: a fenced code block',
  'tagged landed-brief containing only JSON, like this:',
  '```landed-brief',
  '{"summary": "…", "roles": ["…"], "seniority": "…", "locations": ["…"], "remote": "any", "needs_sponsorship": null,',
  ' "salary_min": null, "industries": [], "include_companies": [], "exclude_companies": [], "notes": null}',
  '```',
  'Landed shows the brief as a card with a button that starts the search on all of the user\'s agents, so do',
  'not search for job postings yourself in this chat. Write roles and locations the way job postings do',
  '(English for US roles) and the summary in the user\'s language. remote is one of remote, hybrid, onsite, any;',
  'needs_sponsorship is true, false, or null when unknown. When the user changes the direction, send an',
  'updated brief. Never put anything else in the block.',
].join('\n')

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

// ── job search ────────────────────────────────────────────────────────────

/** The brief as the server validated it (packages/schema SearchBrief). */
export type Brief = {
  summary?: string
  roles: string[]
  seniority?: string | null
  locations?: string[]
  remote?: string
  needs_sponsorship?: boolean | null
  salary_min?: string | null
  industries?: string[]
  include_companies?: string[]
  exclude_companies?: string[]
  notes?: string | null
}

const SEARCH_SYSTEM_PROMPT = [
  "You are Landed's job-search agent, running on the user's own computer. Find job postings that are open",
  "now and match the user's search brief, using web search and by opening pages.",
  '- Only report postings you actually found. Never invent companies, titles or links.',
  "- Link the company's own careers or ATS page (Greenhouse, Lever, Ashby, Workday, the company site) when",
  '  you can; an aggregator link (LinkedIn, Indeed, …) is fine when that is all there is.',
  '- Skip postings that are closed, or clearly older than about two months.',
  '- Respect the brief: never include excluded companies; look at the companies it names first.',
  "- sponsorship: what the posting says about visa sponsorship, or what is publicly known about the company's",
  '  sponsoring for this kind of role. Leave it empty rather than guess.',
  '- Aim for 15–30 good matches. Fewer good ones beat many weak ones.',
  'When you are done, return the results with the structured output tool.',
].join('\n')

export const SEARCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences on what you searched and found, in the language of the brief summary.' },
    jobs: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          title: { type: 'string' },
          job_url: { type: 'string', description: 'Direct link to the posting' },
          location: { type: 'string' },
          posted: { type: 'string', description: 'When it was posted, if shown' },
          salary: { type: 'string', description: 'Salary range, if shown' },
          sponsorship: { type: 'string' },
          why: { type: 'string', description: 'One short sentence: why it fits the brief' },
        },
        required: ['company', 'title', 'job_url'],
      },
    },
  },
  required: ['summary', 'jobs'],
}

export function claudeSearchArgs(): string[] {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    '--tools', ...WEB_TOOLS,
    '--allowedTools', ...WEB_TOOLS,
    '--setting-sources', '',
    '--json-schema', JSON.stringify(SEARCH_RESULT_SCHEMA),
    '--append-system-prompt', SEARCH_SYSTEM_PROMPT,
  ]
}

const listOr = (v: string[] | undefined, none: string) => (v?.length ? v.join('; ') : none)

/** The search request the agent reads on stdin. */
export function searchPrompt(brief: Brief, today: Date): string {
  const sponsorship = brief.needs_sponsorship === true
    ? 'yes — prefer employers known to sponsor, and fill in `sponsorship`'
    : brief.needs_sponsorship === false ? 'no' : 'not specified'
  return [
    'Search brief:',
    `- Summary: ${brief.summary ?? brief.roles.join(', ')}`,
    `- Roles: ${brief.roles.join('; ')}`,
    `- Seniority: ${brief.seniority ?? 'not specified'}`,
    `- Locations: ${listOr(brief.locations, 'anywhere')}`,
    `- Remote: ${brief.remote ?? 'any'}`,
    `- Needs visa sponsorship: ${sponsorship}`,
    `- Minimum salary: ${brief.salary_min ?? 'not specified'}`,
    `- Industries: ${listOr(brief.industries, 'any')}`,
    `- Companies to look at first: ${listOr(brief.include_companies, 'none named')}`,
    `- Companies to exclude: ${listOr(brief.exclude_companies, 'none')}`,
    ...(brief.notes ? [`- Notes: ${brief.notes}`] : []),
    '',
    `Today is ${today.toISOString().slice(0, 10)}. Find open postings that match, then return them.`,
  ].join('\n')
}

// ── Claude Code output ────────────────────────────────────────────────────

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
      // StructuredOutput is how --json-schema returns the result, not a step to show
      .filter((c: any) => (c?.type === 'tool_use' || c?.type === 'server_tool_use') && c.name !== 'StructuredOutput')
      .map((c: any) => ({ type: 'tool', name: String(c.name ?? 'tool') }))
  }
  if (e.type === 'result') {
    if (e.is_error || e.subtype !== 'success') {
      return [{ type: 'error', message: String(e.result ?? e.subtype ?? 'Claude Code reported an error') }]
    }
    const out = e.structured_output
    if (out && typeof out === 'object' && Array.isArray(out.jobs)) {
      return [{ type: 'done', text: typeof out.summary === 'string' ? out.summary : '', session_id: e.session_id, jobs: out.jobs }]
    }
    return [{ type: 'done', text: String(e.result ?? ''), session_id: e.session_id }]
  }
  return []
}

// ── running a task ────────────────────────────────────────────────────────

const CHAT_TIMEOUT_MS = 5 * 60_000
const SEARCH_TIMEOUT_MS = 20 * 60_000

function runClaude(
  opts: { args: string[]; stdin: string; timeoutMs: number; onDone?: () => void },
  emit: (e: TaskEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('claude', opts.args, { cwd: workspace(), stdio: ['pipe', 'pipe', 'pipe'] })
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
      finish({ type: 'error', message: `The agent took too long (${Math.round(opts.timeoutMs / 60_000)} min) and was stopped.` })
    }, opts.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        for (const e of parseClaudeLine(line)) {
          if (e.type === 'done') opts.onDone?.()
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
    child.stdin.end(opts.stdin)
  })
}

const fail = (emit: (e: TaskEvent) => void, message: string) => Promise.resolve(emit({ type: 'error', message }))

export function runTask(task: Task, emit: (e: TaskEvent) => void): Promise<void> {
  if (task.agent !== 'claude') return fail(emit, `${task.agent} isn't supported yet.`)

  if (task.kind === 'chat') {
    const conversationId = String(task.input.conversation_id ?? '')
    const message = String(task.input.message ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !message.trim()) return fail(emit, 'Bad chat task.')
    const resume = knownSessions().has(conversationId)
    return runClaude({
      args: claudeChatArgs(conversationId, resume), stdin: message, timeoutMs: CHAT_TIMEOUT_MS,
      onDone: () => rememberSession(conversationId),
    }, emit)
  }

  if (task.kind === 'job_search') {
    const brief = task.input.brief as Brief | undefined
    if (!brief || !Array.isArray(brief.roles) || brief.roles.length === 0) return fail(emit, 'Bad search task.')
    return runClaude({ args: claudeSearchArgs(), stdin: searchPrompt(brief, new Date()), timeoutMs: SEARCH_TIMEOUT_MS }, emit)
  }

  return fail(emit, `Unsupported task: ${task.kind}`)
}
