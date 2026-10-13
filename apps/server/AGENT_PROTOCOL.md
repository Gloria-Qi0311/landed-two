# Landed agent protocol: Observation Schema v0.1

External agents (Meta Muse, Claude, Codex, …) find jobs and read status emails. They report each fact to Landed as an **observation**, and Landed decides what it means: deduplication, matching to applications, status changes. An agent never edits the pipeline directly.

Users connect an agent on the **Agents** page. Landed creates a token there and shows it once, together with copy-paste setup instructions. The web app generates those instructions in `apps/web/src/lib/agent-prompt.ts`; keep that file in step with this document and with `src/routes/agent.ts`.

## Request

```http
POST /api/agent/observations
Authorization: Bearer landed_agent_…
Content-Type: application/json
Idempotency-Key: <stable key, e.g. "<run_id>:<job_url or email message id>">
```

```json
{
  "schema_version": "0.1",
  "run_id": "muse-run-123",
  "observation_type": "job_discovered",
  "observed_at": "2026-10-09T12:00:00Z",
  "payload": { "title": "Software Engineer", "company": "Example", "job_url": "https://example.com/jobs/123" }
}
```

- `observed_at` must be ISO 8601 and include a time zone.
- Send one observation per request. The body may be at most 64 KB.
- Each connection may send at most 1000 observations per hour; above that the server returns 429.

### Payload by `observation_type`

| Type | Required | Optional |
|---|---|---|
| `job_discovered` | `title`, `company` | `job_url` (http/https), `location`, `source`, `description` (≤ 20k chars), `deadline` (the application deadline, e.g. `2026-10-21`) |
| `application_status` | `status` (one of `applied` · `recruiter_response` · `assessment` · `interview` · `rejected` · `offer` · `other`), `company` | `role`, `job_url`, `confidence` (0–1), `evidence` (below), `interview_at` (ISO time of a scheduled interview), `interview_format` (`onsite` · `remote`) |
| `sync_error` | `message` | `source` |

`assessment` means an invitation to an online assessment, coding test or take-home; it moves an application to the OA stage. It was added in v0.1 without a version bump, since older agents simply never send it.

`deadline` puts an apply-by date on the lead. `interview_at` adds the interview as a new round, with its time, when Landed applies the update. Both fields are optional and were added without a version bump.

`evidence` fields: `source` (required, e.g. `gmail`), plus optional `message_id`, `thread_id`, `sender_domain`, `subject`, `received_at` (ISO), `summary`.

Extra fields are stored but not interpreted. That keeps v0.1 forward compatible.

## Responses

| Status | Meaning |
|---|---|
| `201` `{ accepted, duplicate: false, observation_id }` | Stored |
| `200` `{ duplicate: true, observation_id }` | Retry of an earlier request: same key and the same body (compared by hash) |
| `400` | Body doesn't match the schema. Fix it rather than resending it unchanged. |
| `401` | Missing, invalid or revoked token |
| `409` `{ code: "idempotency_conflict" }` | The key was already used with a different body. Use a new key for new observations. |
| `413` / `429` | Body too large / rate limit (`Retry-After`) |

Agents do retry and do reuse stale request bodies, so writes are always idempotent. Never assume an agent calls exactly once.

## Where observations are kept (local-first)

Agents run in the cloud, so every observation passes through this server. What the server keeps afterwards depends on the account:

- **Cloud sync on**: the observation is stored with the rest of the account's Cloud data.
- **Cloud sync off**: the observation is **held** only until the user's browser pulls it (`GET /agent-inbox`), stores it in its local database and acks it (`POST /agent-inbox/ack`). After the ack the server purges the payload. It keeps a **receipt** (ids, the idempotency key and `payload_sha256`) so that agent retries are still recognised.
  - Unclaimed payloads are purged after 7 days.
  - Receipts are deleted after 30 days.
- Turning sync on promotes held observations to Cloud data. Turning it off moves them to the device with the rest of the export and leaves only receipts on the server.

## Account routes (Landed session)

| Route | Purpose |
|---|---|
| `GET /agent-connections`, `POST /agent-connections` `{ provider, display_name }` | List connections / create one (the response includes the token, shown once) |
| `POST /agent-connections/:id/revoke` | Revoke a token |
| `GET /agent-observations` | Review list. Receipts come back with `payload_json: null`. |
| `GET /agent-inbox`, `POST /agent-inbox/ack` `{ ids }` | Relay pull and ack for sync-off accounts. The web app does this automatically. |

## What Landed does with observations

The observation processor (`packages/observation-processor`, rules in [docs/observation-processor.md](../../docs/observation-processor.md)) runs in the user's browser:

- `job_discovered` observations are deduplicated into **job leads**, the "to apply" list.
- `application_status` observations are matched to applications.
  - By default (`auto_apply_updates`, on), a confident update applies automatically. Confident means `confidence` ≥ 0.8 plus email evidence (`message_id` or `sender_domain`). The update can be a stage change, a new application, or a recruiter note in the activity log. Every automatic change can be undone.
  - An update waits for the user when Landed can't tell which application it is about, when confidence is low, or when it would re-open a closed application. With the setting off, only "application received" emails apply on their own.
