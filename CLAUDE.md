# CLAUDE.md

Project-specific instructions for Claude Code in this repository. Read this on session start; respect these conventions in all subsequent work.

## Commit attribution

Commit messages **MUST NOT** include any `Co-Authored-By: Claude …` trailer. All commits in this repository are authored solely by the project owner (AntaresYuan / chenjy4@uw.edu).

The git config on this machine is already set to that identity — no overrides needed. Just omit the trailer.

This applies to:
- Direct commits made by Claude Code in this repo
- Commits made via PR branches
- Squash-merge commit messages (use the PR title + a clean body; no trailer)

## Local-first: everyone signs in, data stays in the browser unless the account turns on Cloud sync

Every user signs in (email + password, `apps/server`), but an account's data lives in **its own** IndexedDB database in the browser (`landed-<userId>`, `apps/web/src/lib/store/local.ts`, Dexie) unless the account turns on **Landed Cloud sync** (`users.cloud_sync`). With sync on, the app uses `apps/web/src/lib/store/cloud.ts` → `apps/server`. Turning sync on uploads the device data and clears it (`POST /api/cloud/enable`); turning it off copies Cloud data to the device, then deletes it server-side but keeps the account (`POST /api/cloud/disable`). Flows: `apps/web/src/lib/cloud.ts`.

- **The server enforces it**: every data route sits behind `requireCloud` and answers `409 { code: 'cloud_off' }` for accounts with sync off. Only account-level routes (`/auth/*`, `/me`, `/cloud/*`) work for everyone. Never add a data route outside the `requireCloud` group, and never store user data server-side for a sync-off account.
- The signed-in account (`{id, email, cloud_sync}`, no secrets) is cached in `localStorage['landed:account']` so a sync-off account keeps working offline when the server is unreachable; it's cleared on sign-out.
- **Hooks and components only use `useStore()` for data** — never call `api` directly for it. A new data operation goes on the `DataStore` interface (`lib/store/types.ts`) and must be implemented in **both** `local.ts` and `cloud.ts` (+ the server route), with the same defaults and validation, so local data always uploads cleanly.
- **Snapshot format** (`landed-backup` v1) is shared by backup files, `GET /api/export` and `POST /api/sync/upload`. Adding a table or column means updating `SNAPSHOT_TABLES` / types on the web side and `COLUMNS` in `apps/server/src/routes/sync.ts`; bump `BACKUP_VERSION` if old files can't be read as-is. Rows carry client-generated UUIDs, which is what makes upload idempotent.
- Local schema changes go in a new Dexie `this.version(n)` block in `local.ts`; never edit an existing version.
- **Extension ↔ page bridge**: in local mode the extension can't reach a server, so the open Landed tab pulls queued portal events and pushes resumes over `window.postMessage` (`apps/web/src/hooks/extension-bridge.ts` ↔ `apps/extension/lib/web-bridge.js` + `lib/bridge-handler.js`). Every read-modify-write of the extension's pending queue goes through `withQueueLock` in `background.js`. Landed web origins are listed in both `lib/config.js` (`WEB_ORIGINS`) and `manifest.json` — keep them in sync when adding a production origin.

## External agents report observations; Landed decides

Agents (Meta Muse, Claude, Codex…) submit **observations** to `POST /api/agent/observations` with a narrow per-connection token (`apps/server/src/routes/agent.ts`, protocol in `apps/server/AGENT_PROTOCOL.md`). Rules:

- **Agents never mutate the pipeline.** Observations are stored raw; the observation processor turns them into job leads and review-queue suggestions. Rules and thresholds: `packages/observation-processor` (pure functions, the only place matching/auto-apply rules live) and `docs/observation-processor.md`. It runs in the browser for both modes (`apps/web/src/lib/inbox.ts` → `processPending`, driven by `useObservationProcessor`).
- **Email updates apply automatically by default** (product decision after acceptance review; `users.auto_apply_updates`): confident (≥ 0.8 + email evidence) forward stage changes, new applications and recruiter notes apply without asking, and every automatic change is undoable from the Applications page. Ambiguous matches, low confidence and re-opening a closed application always ask ("Needs your input" on Applications). There is no separate Review page, and agent-found jobs are the Kanban's **Leads** column, not a separate page — keep both on the Applications page.
- **Agent data follows local-first too.** For sync-off accounts the server is only a relay: hold until the browser pulls + acks (`hooks/agents.ts` → `useAgentRelay`), then purge the payload and keep a hash-only receipt for idempotency; unclaimed payloads expire after 7 days. Don't add server-side processing that reads a sync-off account's observations.
- **Schema changes** (new `observation_type`, new fields) go in three places together: the validators in `agent.ts`, `AGENT_PROTOCOL.md`, and the setup prompt in `apps/web/src/lib/agent-prompt.ts`. Bump `schema_version` for breaking changes.
- Every agent write is idempotent on `(connection_id, Idempotency-Key)`; same key + different body is a 409. Agents retry and reuse stale bodies — never rely on "called once".

## Local agents run on the user's computer (`apps/daemon`)

Like Multica: the user pairs a computer (Applications → **Ask Agent** panel → setup, or its gear → Your computer), runs `pnpm landed connect …` there, and the daemon executes Landed's tasks with locally installed agent CLIs (Claude Code today) on the user's own subscription — no API cost for anyone.

- **The server only relays** (`apps/server/src/runtime-hub.ts`): tasks and their output live in memory and are never written to the database. Keep it that way — this is the local-first story for AI work too.
- **Tasks are a fixed set of kinds** (`chat`, `job_search`, `email_check`, `portal_check`, `resume_merge`, `resume_tailor`), validated on both ends; the server forwards only the validated fields. Never forward arbitrary commands, prompts-as-shell, or file paths to the daemon. New kinds get explicit input validation in `routes/runtime.ts`, a runner in `apps/daemon/src/agents.ts`, and an entry in that agent's `kinds` (daemons report what they can run; older ones get `409 runtime_outdated`).
- **Job search flow**: the chat agent ends a reply with a ```` ```landed-brief ```` JSON block once the direction is clear; the panel shows it as a card (`components/search-brief.tsx`). Confirming stores it as the active `job_searches` row (data store — local-first like everything else; one active per account) and runs `job_search` on every agent of every online computer (`lib/job-search.ts`). The daemon returns schema-bound results (`claude --json-schema`); the browser feeds each job through the observation processor (`ingestFoundJobs` in `lib/inbox.ts`) so they dedupe into the **Leads** column like external agents' finds. The brief/result shapes and validators live in one place, `packages/schema/src/search-brief.ts` (web, server, and the chat prompt's block format in `apps/daemon/src/agents.ts` must agree).
- **Email watching** (`email_check`): off until the user turns it on (`users.email_watch`). The daemon looks for a mail connector the user already gave their agent (e.g. claude.ai's Gmail connector, found at start via `claude mcp list` + one ToolSearch lookup) and allows **only its read tools**; an agent without one doesn't advertise the kind. The browser sends just `{since, applications: [{company, role, stage}]}`, and findings go through the processor (`ingestEmailFindings`) — same matching, auto-apply and undo as external agents. Mail content never reaches the server.
- **Panel questions** are ordinary pending suggestions with Landed-made dedupe keys, asked in the Ask Agent panel (badge on the button) instead of "Needs your input", and closed automatically when something else answers them (`settleQuestions`): `click:lead:<id>` / `click:app:<id>` — "did you apply?" after opening a posting from Landed (`recordApplyClick`); `quiet:<app id>` — no signal for 21 days on an in-progress application (`flagQuietApplications`): ghosted (undoable), wait (asks again in 21 days), or look at its portal.
- **Portal checks** (`portal_check`, the fallback when email is silent) run only when the user clicks, on ≤ 5 applications, through Claude in Chrome (`claude --chrome --strict-mcp-config`). They are **read-only by construction**: the allowlist is Chrome's tab/navigate/read tools; `computer`, `form_input`, `javascript_tool`, uploads and network reads are denied. The browser sends refs ("1"…"5"), not ids. Results go through the processor in ask-first mode (`ingestPortalResults`); only "submitted" confirmations apply on their own.
- **Capabilities are re-detected every 30 minutes** by the daemon (mail connector via `claude mcp list` + ToolSearch, with a cache because claude.ai connectors load unreliably in `claude -p`; Chrome via a `--chrome` init probe), re-sent in `hello`. An email/portal task that never actually called its mailbox/Chrome tool must end in an error, not an empty success — otherwise a check that read nothing would advance `email_checked_at` and skip mail.
- **The agent is sandboxed by flags, not trust**: empty workspace dir, `--setting-sources ""` (ignore the user's own settings/hooks), and an explicit tool allowlist (`--tools`/`--allowedTools`). Chat and search also pass `--strict-mcp-config` so none of the user's MCP connectors load. Email checks get `ToolSearch` (connector tools are deferred behind it) and the mailbox's read tools — never write tools. Portal checks get Chrome's navigate/read tools — never click/type/form/script tools. Widening the allowlist is a product + security decision, not a convenience.
- Runtime tokens (`landed_rt_…`) only reach `/api/runtime/*`; they are not sessions.
- **Agent UI lives on the Applications page**, Feishu-Bitable style: the **Ask Agent** button opens a side panel (`components/agent-panel.tsx`) — chat when a computer is online, setup when not, settings behind the gear (`?agent=chat|settings`). Don't add separate pages/tabs for agent features; `/agents` only redirects into the panel.

## Pipeline: Leads → Applied → OA / Test → Interview → Offer → Rejected

Stages and interview rounds live in `packages/schema/src/pipeline.ts` (shared by web, server and the processor's callers).

- **`saved` is shown as a lead**: the Leads column holds both agent-found jobs (`job_leads`) and applications not applied to yet (stage `saved`). There is no Saved column.
- **`ghosted` is a kind of closed**: it shows in the Rejected column with a tag.
- **One `interview` stage** replaced phone + onsite. Each application carries `interviews: [{round, format: onsite|remote, interviewers: [peer|teammate|leader|hr], at, note}]`, edited in the detail drawer, and the latest round shows on the card.
- `phone` / `onsite` are legacy. Postgres can't drop enum values, so they stay in the type, but every write path normalizes them to `interview` plus the round they stood for: server routes, snapshot upload, local store, and Dexie v5 for data already in the browser. Never write them again. Board columns and filters go through `columnOf()` in `apps/web/src/data.js`.

## My Resume: uploads → master → versions

`resumes.kind` is one of `source`, `master` or `version` (see `packages/schema/src/master-resume.ts`).

- **Uploads** (`source`) are the user's own resumes, parsed into the canonical `Resume` shape.
- **The master** (one per account) is merged from every upload by the user's agent (`resume_merge`). It is the most complete record: each experience is split into bullets, and each bullet keeps **every phrasing** (`variants`, with the uploads they came from). The user picks the preferred phrasing; a re-merge passes the current master back in, so those choices carry over.
- **Versions** are tailored from the master for a role (`resume_tailor`). The agent picks the most relevant experience and the best-fitting phrasing, and never invents facts. Each version stores its target and "why these" notes in `target_json`.
- `parsed_json` is always a canonical `Resume`, and for the master it's the flattened form. That's what extension auto-fill reads from whichever resume is current.
- Both tasks are text-only: no MCP, no tools, except that tailoring may WebFetch the job posting when it has only a link. The server validates their output per kind (`hub.kindOf` → `parseMasterResume` / `parseLooseResume`).

## Landed Cloud backend: `apps/server` + Postgres (no Supabase)

Supabase was removed. The API server (`apps/server`, Hono + postgres.js) owns Cloud auth, every table, realtime, and portal-ingest; it also serves the built web app. See `apps/server/README.md` for setup and deployment.

- **Every query is scoped by the session's user id** (`c.get('user').id`) — there is no RLS behind you. A route that forgets `where user_id = …` leaks data across accounts.
- **Cross-user references are blocked in the schema**: parent tables expose `unique (id, user_id)` and children use composite FKs `(parent_id, user_id) references parent (id, user_id)`. New child tables must follow the same pattern.
- **Migrations are append-only**: add `apps/server/migrations/NNNN_name.sql`; never edit one that has been applied. The server applies pending migrations on start (`pnpm migrate` to run them alone).
- In Cloud mode the web app talks to the API only through `apps/web/src/lib/api.ts` (same-origin, httpOnly session cookie). The extension uses `lib/auth.js` (Bearer token in `chrome.storage.local`).

## Per-user state lives in the data store, not localStorage

Account-level state (onboarding completion, preferences — things that should follow the person to any device regardless of Cloud sync) goes in the `users` row via `GET/PATCH /api/me`, read/written through `apps/web/src/hooks/profile.ts` (`useOnboardedAt` / `useMarkOnboarded` / `useResetOnboarded` pattern). Job-hunt data never goes there — it belongs in the data store.

`localStorage` is reserved for genuinely client-local UI state: `landed:theme`, `landed:last-email`, `landed:account` (the offline session cache above), URL filter preferences. **Never** use it for user-attached state — the localStorage `landed:onboarded_at` flag was removed because it broke on sign-out and leaked across accounts (commit `3d5a489`).

## portal_connections uses a real upsert

`portal_connections` has a `unique (user_id, company_id, provider)` constraint. Both server write paths (`PUT /api/portal-connections` and `POST /api/portal-ingest`) go through `upsertConnection()` in `apps/server/src/routes/portal.ts`, a single atomic statement (the local store does the same inside one Dexie transaction on its `[company_id+provider]` index):

```sql
insert into portal_connections (...) values (...)
on conflict (user_id, company_id, provider) do update set ...
```

**Do not re-introduce SELECT-then-UPDATE-or-INSERT** — that was the racey pattern the constraint was added to prevent.

## (more conventions land here as they're established)
