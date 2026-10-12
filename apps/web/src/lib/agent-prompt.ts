// Setup instructions a user pastes into an external agent (Meta Muse,
// Claude, Codex…). Mirrors Observation Schema v0.1 as enforced by
// apps/server/src/routes/agent.ts; keep the two in step.

export const AGENT_PROVIDERS = [
  { id: 'meta_muse', label: 'Meta Muse' },
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
  return `You are connected to Landed, my job-search tracker. Report what you find by sending HTTP requests to Landed — it checks, deduplicates and stores them, and decides what they mean for my applications.

Endpoint: POST ${endpoint}
Headers:
  Authorization: Bearer ${token}
  Content-Type: application/json
  Idempotency-Key: <a stable key for this observation, e.g. "<run_id>:<job_url or email message id>">

Body (one observation per request, schema_version "0.1"):
{
  "schema_version": "0.1",
  "run_id": "<id of this run; the same for every observation in it>",
  "observation_type": "job_discovered" | "application_status" | "sync_error",
  "observed_at": "<ISO 8601 time with a time zone, e.g. 2026-10-09T12:00:00Z>",
  "payload": { ... }
}

payload by observation_type:
- job_discovered: { "title", "company", "job_url"?, "location"?, "source"?, "description"? }
- application_status: { "status": "applied" | "recruiter_response" | "assessment" (online assessment / coding test / take-home invite) | "interview" | "rejected" | "offer" | "other", "company", "role"?, "job_url"?, "confidence"? (0 to 1), "evidence"?: { "source" (e.g. "gmail"), "message_id"?, "thread_id"?, "sender_domain"?, "subject"?, "received_at"?, "summary"? } }
- sync_error: { "message", "source"? }

Rules:
- If a request fails or you are unsure it arrived, retry with the SAME Idempotency-Key and the EXACT same body. Landed answers 200 with "duplicate": true.
- Use a NEW Idempotency-Key for anything new. Reusing a key with a different body returns 409.
- Report facts with evidence; don't guess. Landed decides whether an application's status changes.
- For application_status, always include "confidence" and the email "evidence" (message_id, sender_domain, subject, received_at). Landed applies confident updates (confidence 0.8 or higher, with evidence) automatically; anything less waits for me to confirm.
- 400 means the body doesn't match the schema: fix it instead of resending it unchanged. 401 means this token was revoked. 429 means slow down (max 1000 per hour).

Example:
curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: run-123:https://example.com/jobs/1" \\
  -d '{"schema_version":"0.1","run_id":"run-123","observation_type":"job_discovered","observed_at":"2026-10-09T12:00:00Z","payload":{"title":"Software Engineer","company":"Example","job_url":"https://example.com/jobs/1","source":"muse"}}'`
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
