# Agents: external, cloud and local

Landed uses agents the user already has. They work in three places:

| Where | Who | How they talk to Landed |
|---|---|---|
| The user's computer | Claude Code, Codex, ACP agents (Gemini CLI, Copilot, Cursor, Goose…) | `apps/daemon` runs them for Landed's tasks |
| The cloud, as a connector | ChatGPT, Claude, Gemini… | MCP at `/mcp` with OAuth |
| The cloud, with a key | Muse, Manus, OpenClaw… | The same tools over HTTP, or raw observations |

## External agents report observations; Landed decides

Agents submit **observations** to `POST /api/agent/observations` with a narrow
per-connection token (`apps/server/src/routes/agent.ts`, protocol in
[apps/server/AGENT_PROTOCOL.md](../apps/server/AGENT_PROTOCOL.md)).

- **Agents never mutate the pipeline.** Observations are stored raw. The
  observation processor turns them into job leads and review-queue suggestions.
  Rules and thresholds live in `packages/observation-processor` (pure functions,
  the only place matching and auto-apply rules live) and
  [observation-processor.md](observation-processor.md). It runs in the browser for
  both modes (`apps/web/src/lib/inbox/process.ts` → `processPending`, driven by
  `useObservationProcessor`).
- **Email updates apply automatically by default** (product decision after
  acceptance review; `users.auto_apply_updates`). Confident (≥ 0.8 + email
  evidence) forward stage changes, new applications and recruiter notes apply
  without asking, and every automatic change is undoable from the Applications
  page. Ambiguous matches, low confidence and re-opening a closed application
  always ask ("Needs your input" on Applications). There is no separate Review
  page, and agent-found jobs are the Kanban's **Leads** column, not a separate
  page. Keep both on the Applications page.
- **Names in any script**: `companyKey` / `titleWords`
  (`packages/observation-processor/src/normalize.ts`) keep letters and digits of
  every script. CJK runs are one word for companies (common suffixes such as
  集团/有限公司 dropped) and character pairs for titles. An earlier version kept
  only a–z/0–9, so every Chinese company became "" and matched every other.
  Bracketed text is noise when matching an email to an application, but it tells
  rows of one list apart (产品管培生（上海） vs （广东省）), so screenshot matching
  uses `keepBrackets` and a 0.8 bar. Dexie v8 recomputes stored lead keys.
- **Agent data follows local-first too.** For sync-off accounts the server is
  only a relay: hold until the browser pulls and acks (`hooks/agents.ts` →
  `useAgentRelay`), then purge the payload and keep a hash-only receipt for
  idempotency. Unclaimed payloads expire after 7 days. Don't add server-side
  processing that reads a sync-off account's observations.
- **Schema changes** (a new `observation_type`, new fields) go in three places
  together: the validators in `agent.ts`, `AGENT_PROTOCOL.md`, and the setup prompt
  in `apps/web/src/lib/agent-prompt.ts`. Bump `schema_version` for breaking
  changes.
- Every agent write is idempotent on `(connection_id, Idempotency-Key)`. The same
  key with a different body is a 409. Agents retry and reuse stale bodies, so
  never rely on "called once".

## Cloud agents: MCP connector

Cloud agents connect as an MCP connector (`/mcp`, `apps/server/src/routes/mcp.ts`;
stateless Streamable HTTP, JSON responses). Landed can't start a cloud agent, so
it's **pull**: `get_tasks` (job search for the confirmed brief; email check when
`users.email_watch`), then `submit_jobs` / `submit_email_updates`, which become
ordinary observations through `insertObservation` (same validators, same relay,
same processor). Tool names and the scheduled-task prompt live in
`packages/schema/src/cloud-agent.ts`.

**Auth is OAuth 2.1** (`routes/oauth.ts`):

- RFC 9728 / 8414 metadata, dynamic client registration (public PKCE clients;
  confidential ones get a hashed secret);
- redirect URIs https or loopback http only;
- consent at the web app's `/authorize-agent` (outside the shell; sign-in first
  keeps the URL);
- one-time 10-minute codes, S256 only, 7-day access tokens with rotating refresh
  tokens.

Each approval is an `agent_connections` row (provider `mcp`, scopes
`observations:write` + `tasks:read`), revoked like the others. Personal agents
that connect with a key instead of OAuth get a token from Agent settings with the
same scopes. It works for `/mcp`, for the same tools as plain HTTP
(`agentTaskRoutes`: `GET /api/agent/tasks`, `POST /api/agent/jobs`,
`POST /api/agent/email-updates`) and for `/api/agent/observations`. Connections
from before tasks (scope `observations:write` only) may submit but not read
tasks. Public origin: `PUBLIC_URL`, else the request's Host / X-Forwarded-*
(Vite proxies `/mcp`, `/oauth`, `/.well-known` in dev).

### The briefing

The briefing is **the one deliberate exception** to "no user data on the server
for sync-off accounts". Cloud agents run in the cloud, so while the account has a
connection with `tasks:read` (connector or key), the browser shares
`{brief, applications: [{company, role, stage}]}` (`useCloudBriefing`,
`PUT /api/agent-briefing`, only when it changed; 409 without such a connection).
The server deletes it when the last such connection is revoked
(`dropBriefingIfUnused`). The consent page says so. Don't widen it (no notes,
contacts, resumes, emails), and don't add other server-side copies.

## Local agents: `apps/daemon`

The user pairs a computer from the sidebar **Agent** page (setup, or Settings →
Your computer). On a Mac that's one click: **Landed for Mac**
(`apps/daemon/scripts/build-mac.mjs`) owns `landed://` and carries the bundled
daemon. It runs the daemon as a LaunchAgent, and
`landed://connect?server=…&token=…` pairs it after a native confirm dialog
(`apps/daemon/src/mac.ts`). **Never pair without that dialog**: any page can open
the URL. Elsewhere the user runs `pnpm landed connect …`. The daemon then runs
Landed's tasks with locally installed agent CLIs on the user's own subscription,
so there is no API cost for anyone.

### The server only relays

`apps/server/src/runtime-hub.ts` holds tasks and their output in memory and never
writes them to the database. Keep it that way: this is the local-first story for
AI work too. Runtime tokens (`landed_rt_…`) only reach `/api/runtime/*`; they are
not sessions.

### Task kinds

Tasks are a fixed set of kinds (`chat`, `job_search`, `email_check`,
`portal_check`, `resume_parse`, `resume_merge`, `resume_tailor`,
`automation_sync`), validated on both ends. The server forwards only the
validated fields. **Never forward arbitrary commands, prompts-as-shell, or file
paths to the daemon.** A new kind gets explicit input validation in
`routes/runtime.ts`, a runner in `apps/daemon/src/agents.ts`, and an entry in that
agent's `kinds`. Daemons report what they can run; older ones get
`409 runtime_outdated`.

### Any agent, three runners

- **Claude Code** (`agents.ts`): the only one with email and portal checks
  (connectors + Claude in Chrome).
- **Codex** (`codex.ts`, `codex exec --json`): sandboxed by flags (read-only
  sandbox, `--disable shell_tool`, `--ignore-user-config`, approvals never, web
  search only when the task needs it). It validates `--output-schema` **strictly**,
  so schemas go through `strictSchema` (all fields required, optional ones
  nullable; `dropNulls` after). Every object in a result schema needs explicit
  `properties`.
- **ACP** (`acp.ts`): Gemini CLI, Copilot, Cursor, Goose, OpenCode, Qwen, Kimi…,
  found on PATH from a built-in table of registry launch commands plus the user's
  own `~/.landed/agents.json`. Sandboxed by protocol: empty workspace, no MCP
  servers, no fs/terminal client capabilities, every `session/request_permission`
  answered by `allowedKinds` (search/fetch only for web tasks, nothing else, never
  edit/delete/move/execute). A forbidden tool that runs without asking stops the
  task.

Non-Claude runners work from one agent-neutral `Spec` (`specFor`: instructions,
message, JSON Schema, `web: none|fetch|search`, images). Results that need the
web (`requireWeb`) only count if the agent searched. JSON comes from a fenced
block (`jsonFromText`) with one retry turn. PDFs become text in the daemon (macOS
PDFKit, `pdf.ts`) so non-Claude agents need no file access. Agents that are
installed but signed out are skipped and logged (`detectionNotes`). Scheduled
work picks the first agent that can run the kind (`agentForKind`, Claude Code
first).

### The agent is sandboxed by flags, not trust

Empty workspace dir, `--setting-sources ""` (ignore the user's own settings and
hooks), and an explicit tool allowlist (`--tools` / `--allowedTools`). Chat and
search also pass `--strict-mcp-config` so none of the user's MCP connectors load.
Email checks get `ToolSearch` (connector tools are deferred behind it) and the
mailbox's read tools, never write tools. Portal checks get Chrome's navigate and
read tools, never click/type/form/script tools. **Widening the allowlist is a
product and security decision, not a convenience.**

### Capabilities

The daemon re-detects capabilities every 30 minutes: the mail connector via
`claude mcp list` + ToolSearch (with a cache, because claude.ai connectors load
unreliably in `claude -p`), and Chrome via a `--chrome` init probe. They are
re-sent in `hello`. An email or portal task whose MCP server is missing from the
init event is killed before the model runs and retried (`requireServer`, up to 5
times). A task that still never called its mailbox or Chrome tool must end in an
error, not an empty success; otherwise a check that read nothing would advance
`email_checked_at` and skip mail.

## Agent page and chat

The Agent UI is its own page (`/agent`, sidebar: Applications → Agent → My
Resume; `components/agent-page.tsx`; product decision after acceptance review,
replacing the earlier side panel): chat when a computer is online, setup when
not, settings via `?view=settings`. Old `/applications?agent=…` and `/agents`
links redirect there. Agent work that belongs to a page stays there: the board
keeps only its own updates, and My Resume runs its own tasks.

- **Chat history**: conversations live in the data store (`agent_conversations`;
  Dexie v7, migration 0014), and the Agent page lists them on its left. A
  conversation's id doubles as its Claude Code session id, so continuing a chat
  resumes that session on the same computer. Every chat task also carries the
  recent turns (`history`, bounded by `parseChatHistory`); a daemon that doesn't
  have the session prepends them to the message. `lib/agent-chat.ts` saves the
  whole conversation after each turn, and keeps a streaming reply alive across
  chat or page switches.
- **Blocks the agent can end a reply with**, each shown as a card that only acts
  when the user clicks:

  | Block | Card | Shape |
  |---|---|---|
  | `landed-brief` | Confirm a job search direction (`components/search-brief.tsx`) | `packages/schema/src/search-brief.ts` |
  | `landed-applications` | Add applications read from screenshots (`components/reported-applications.tsx`) | `packages/schema/src/reported-application.ts` |
  | `landed-answers` | Save application answers read from a filled form (`components/reported-answers.tsx`) | `packages/schema/src/application-answers.ts` |
  | `landed-dedupe` | Review duplicate applications (`components/duplicates.tsx`) | empty |

- **Screenshots → applications** (sites that send no confirmation email): the
  chat takes up to 4 images (paperclip, paste, drop; `lib/chat-images.ts` scales
  big ones down). They go to the agent once with the message (task input
  `images`, `parseChatImages`). Claude Code gets them inline through
  `--input-format stream-json` (no file access), Codex/ACP as files in the task
  folder, removed afterwards. Conversations keep only small previews
  (`ChatTurn.images[].thumb`). **The user adds them; the agent never does.**
  Matching (`matchReported` in `lib/inbox/reported.ts`) is stricter than email
  matching: same employer plus the same link or a close role (another role at the
  same company is a new application). An existing one is only moved forward, and
  a matching lead goes into the pipeline instead of a duplicate.
- **Panel questions** are ordinary pending suggestions with Landed-made dedupe
  keys, asked on the Agent page (badge on the sidebar's Agent item) instead of
  "Needs your input", and closed automatically when something else answers them
  (`settleQuestions` in `lib/inbox/questions.ts`):
  - `click:lead:<id>` / `click:app:<id>`: "did you apply?" after opening a posting
    from Landed (`recordApplyClick`);
  - `quiet:<app id>`: no signal for 21 days on an in-progress application
    (`flagQuietApplications`). Answers: ghosted (undoable), wait (asks again in
    21 days), or look at its portal.

## Job search

The chat agent ends a reply with a ```` ```landed-brief ```` JSON block once the
direction is clear. Confirming stores it as the active `job_searches` row (data
store, one active per account) and runs `job_search` on every agent of every
online computer (`lib/job-search.ts`). The daemon returns schema-bound results
(`claude --json-schema`). The browser feeds each job through the observation
processor (`ingestFoundJobs` in `lib/inbox/leads.ts`) so they dedupe into the
**Leads** column like external agents' finds. The brief and result shapes and
validators live in one place, `packages/schema/src/search-brief.ts`; web, server,
and the chat prompt's block format in `apps/daemon/src/agents.ts` must agree.

## Automation

`/automation` (sidebar between Agent and My Resume) is exactly **three
automations, each laid out as When / Looks at / Then** (product decision after
acceptance review). Don't add page-level settings or extra cards: a new setting
belongs to one of the three.

| Automation | Looks at | Then |
|---|---|---|
| Check email | New emails | Application status; its "Then" holds the auto-apply choice (`users.auto_apply_updates`) |
| Find new jobs | The active brief as criteria, editable in place (an edit makes a new active search via `addJobSearch`) | Leads |
| Check candidate portals | Applications quiet for N days | Ask-first status updates |

They run on a schedule the user sets (`users.automations` via `/me`, migration
0015; `packages/schema/src/automation.ts`, which also has the schedule math).

- **The daemon runs the schedule**, so it works with Landed closed
  (`apps/daemon/src/automations.ts`, state in `~/.landed/automations.json`, mode
  600). That state belongs to one pairing (`owner` = this computer's runtime id):
  pairing again (another account or server) starts it fresh, so a new account
  reads its own 30 days of email instead of continuing the old account's window,
  and never receives the old account's unacked results.
- **Email window**: each check starts an hour before the previous one began, its
  summary names the window read, and the prompt gives the start as local time +
  `after:<Unix seconds>` (a Gmail date means local midnight, and a UTC date can
  already be tomorrow). "Re-read the last 30 days" sends `email_rescan_days` with
  a run-now.
- **The browser side**: the `automation_sync` task (`lib/automation-sync.ts`,
  `useAutomationRunner`) sends the schedule plus the context the tasks need
  (`{applications, email_since, brief, search_id, portal_apps}`) and acks the
  results it has stored. The daemon answers with finished results and its run log.
  Results go through the processor like any other agent report, and nothing is
  stored on the server.
- **One designated computer** runs the schedule (the online one that can do the
  most of what's turned on: read mail, use Chrome), and every online computer gets
  the settings so a previous one stops.
- Cloud agents' `get_tasks` follows the same switches (email check, job search).
  Portal checks need the user's Chrome, so never in the cloud.
- **Email checks** need a mail connector the user already gave their agent, and
  the daemon allows **only its read tools**: the first word must be a read verb
  and no word a write verb, since "thread" contains "read". Discovered write tools
  are passed as `--disallowedTools`. The browser only sends
  `{since, applications: [{company, role, stage}]}`; mail content never reaches
  the server.

## Portal checks

`portal_check`, the fallback when email is silent, runs when the user clicks
(Agent page questions, or "Check status now" on an application's Candidate portal
card, `components/portal-card.tsx`) or on the Automation schedule (opt-in, off by
default), on ≤ 5 applications per run, through Claude in Chrome
(`claude --chrome --strict-mcp-config`). Scheduled runs pick applications with a
portal link and no news for `quiet_days` (`pickQuietPortals`; the daemon also
skips ones it looked at within that window, `portal_checked` in its state),
quietest first.

They are **read-only by construction**: the allowlist is Chrome's
tab/navigate/read tools; `computer`, `form_input`, `javascript_tool`, uploads and
network reads are denied. The browser sends refs ("1"…"5"), not ids. Results go
through the processor in ask-first mode (`ingestPortalResults` in
`lib/inbox/portal.ts`); only "submitted" confirmations apply on their own.
