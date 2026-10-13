// Cloud agents (ChatGPT, Claude.ai, Gemini, Manus…) use Landed as a remote
// MCP server: they ask it for work (`get_tasks`) and hand results back
// (`submit_jobs`, `submit_email_updates`), on their own schedule. The work
// needs a little context — the search brief and the applications — which
// the browser shares while a cloud agent is connected (the "briefing").
// Shared by the server (stores it, builds tasks) and the web app (sends it,
// shows the prompt to schedule). Plain TS, no dependencies.
import { parseBrief, type SearchBrief } from './search-brief.ts'

export type Briefing = {
  /** the confirmed search brief, if any */
  brief: SearchBrief | null
  /** the applications Landed knows — enough to recognize them in email */
  applications: { company: string; role: string; stage: string }[]
}

export const MAX_BRIEFING_APPLICATIONS = 300
const STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function parseBriefing(raw: unknown): Briefing {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const applications: Briefing['applications'] = []
  for (const a of Array.isArray(r.applications) ? r.applications : []) {
    if (!a || typeof a !== 'object') continue
    const x = a as Record<string, unknown>
    const company = text(x.company, 120)
    const role = text(x.role, 200)
    if (!company || !role || typeof x.stage !== 'string' || !STAGES.includes(x.stage)) continue
    applications.push({ company, role, stage: x.stage })
    if (applications.length >= MAX_BRIEFING_APPLICATIONS) break
  }
  return { brief: r.brief ? parseBrief(r.brief) : null, applications }
}

/** MCP tool names (the server defines them; the web app's prompts name them). */
export const CLOUD_TOOLS = { tasks: 'get_tasks', jobs: 'submit_jobs', email: 'submit_email_updates' } as const

/** What the user pastes into their cloud agent's scheduled task. */
export function scheduledPrompt(): string {
  return `Use the Landed connector: call ${CLOUD_TOOLS.tasks}, do every task it returns exactly as its instructions say, and submit each result with the tool the task names. If there are no tasks, stop.`
}
