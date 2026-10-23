// Setup instructions a user pastes into a personal agent that connects with
// a key rather than OAuth (Meta Muse, Manus, OpenClaw…): the tasks loop
// (apps/server/src/routes/mcp.ts — as MCP or plain HTTP) and Observation
// Schema v0.1 (routes/agent.ts) for anything outside a task; keep them in step.

export const AGENT_PROVIDERS = [
  { id: 'meta_muse', label: 'Meta Muse' },
  { id: 'today', label: 'Today' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other agent' },
] as const

export function agentEndpoint(origin = window.location.origin) {
  return `${origin}/api/agent/observations`
}

/** True when an agent running in the cloud can't possibly reach this origin. */
export function isPrivateOrigin(origin = window.location.origin) {
  const host = new URL(origin).hostname
  return host === 'localhost' || host.endsWith('.localhost') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '[::1]'
}

export function agentSetupPrompt(token: string, origin = window.location.origin) {
  const endpoint = agentEndpoint(origin)
  const host = new URL(origin).host
  return `You are connected to Landed, my job-search tracker. You work on my job hunt for me: Landed gives you tasks, you do them, and you hand the results back. Landed checks, deduplicates and stores what you send, and decides what it means for my applications.

Your key for Landed (keep it secret; send it on every request):
  Authorization: Bearer ${token}

== How to connect (pick one) ==
A. As a connector: if you can add an MCP server or a custom connector, add "Landed" with URL ${origin}/mcp (Streamable HTTP) and the Authorization header above. It has four tools: get_tasks, submit_jobs, submit_email_updates, submit_application_result.
B. Plain HTTPS (Content-Type: application/json):
  1. GET ${origin}/api/agent/tasks → {"tasks": [...]}. Each task has "instructions" and "submit_with".
  2. Do each task exactly as its instructions say.
  3. Submit the results:
     - job_search → POST ${origin}/api/agent/jobs
       {"summary": "...", "jobs": [{"company", "title", "job_url", "location"?, "posted"?, "deadline"? (YYYY-MM-DD), "salary"?, "sponsorship"?, "why"?}]}
     - email_check → POST ${origin}/api/agent/email-updates
       {"checked_until": "<ISO time you read up to>", "updates": [{"company", "role"?, "status": "applied" | "recruiter_response" | "assessment" | "interview" | "rejected" | "offer" | "other", "confidence" (0 to 1), "job_url"?, "interview_at"? (ISO time with offset), "interview_format"? ("onsite" | "remote"), "evidence": {"message_id"?, "thread_id"?, "sender_domain"?, "subject", "received_at"?, "summary"?}}]}
       Only after you actually read my email (then an empty list is fine). If you can't read my email, skip this task.
     - auto_apply:* → use the job, shared Landed context and resume link in the task, then POST ${origin}/api/agent/application-result
       {"task_id": "<task_id>", "status": "submitted" | "blocked" | "error", "blocker"?: "login" | "account" | "captcha" | "answers" | "files" | "review" | "submit", "message"?: "...", "unanswered"?: [{"question", "key"?: string | null, "options"?: string[]}]}
       Never guess a missing answer. Return every required unanswered question; Landed asks me once, saves my answer into shared context, and every agent can use it next time.
     Sending the same results again is safe: Landed recognizes them.

== Every day ==
Please set up a recurring task for every morning: "Do my Landed tasks: get the tasks, do each one as its instructions say, and submit the results." If you ask before using a site, allow ${host} for this task so it can run while I'm away. If there are no tasks, just stop.

== Something you notice outside a task ==
Report it as one observation: POST ${endpoint}
Headers: the Authorization header above, Content-Type: application/json, and Idempotency-Key: <a stable key, e.g. "<run_id>:<job_url or email message id>">
Body (schema_version "0.1"):
{
  "schema_version": "0.1",
  "run_id": "<id of this run; the same for every observation in it>",
  "observation_type": "job_discovered" | "application_status" | "sync_error",
  "observed_at": "<ISO 8601 time with a time zone, e.g. 2026-10-09T12:00:00Z>",
  "payload": { ... }
}
payload by observation_type:
- job_discovered: { "title", "company", "job_url"?, "location"?, "source"?, "description"?, "deadline"? (YYYY-MM-DD) }
- application_status: { "status" (as above), "company", "role"?, "job_url"?, "confidence"?, "interview_at"?, "interview_format"?, "evidence"?: { "source" (e.g. "gmail"), "message_id"?, "thread_id"?, "sender_domain"?, "subject"?, "received_at"?, "summary"? } }
- sync_error: { "message", "source"? }
Retry with the SAME Idempotency-Key and the EXACT same body; use a NEW key for anything new (reusing one with a different body returns 409).

== Rules ==
- Report facts you actually saw; never invent companies, links or statuses. Landed decides whether an application's status changes.
- For email updates, always include "confidence" and the "evidence". Confident updates (0.8 or higher, with evidence) apply automatically; anything less waits for me to confirm.
- 400 means the body doesn't match: fix it instead of resending it unchanged. 401 means this key was revoked. 429 means slow down.`
}

/** One-line human summary of an observation for lists. */
export function summarizeObservation(o: { observation_type: string; payload_json: { payload?: Record<string, unknown> } | null }) {
  const p = (o.payload_json?.payload ?? {}) as Record<string, string | undefined>
  switch (o.observation_type) {
    case 'job_discovered':
      return [p.title, p.company].filter(Boolean).join(' · ') || 'Job'
    case 'application_status':
      return [p.company, p.role].filter(Boolean).join(' · ') + (p.status ? ` → ${p.status.replace('_', ' ')}` : '')
    case 'sync_error':
      return p.message ?? 'Sync error'
    default:
      return o.observation_type
  }
}
