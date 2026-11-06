# Agents: external, cloud and local

Landed uses agents the user already has. They work in three places:

| Where | Who | How they talk to Landed |
|---|---|---|
| The user's computer | Claude Code, Codex, ACP agents (Gemini CLI, Copilot, Cursor, Goose…) | `apps/daemon` runs them for Landed's tasks |
| The cloud, as a connector | ChatGPT, Claude… | MCP at `/mcp` with OAuth |
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
it's **pull**: `get_tasks` (approved applications assigned to that connection,
job search for the confirmed brief, and email checks), then `submit_application_result`,
`submit_jobs` or `submit_email_updates`. Search/email results become ordinary
observations through `insertObservation`; application results return to the
browser's local-first application/answer stores. Tool names and the scheduled-task prompt live in
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
`POST /api/agent/email-updates`, `POST /api/agent/application-result`) and for
`/api/agent/observations`. Connections
from before tasks (scope `observations:write` only) may submit but not read
tasks. Public origin: `PUBLIC_URL`, else the request's Host / X-Forwarded-*
(Vite proxies `/mcp`, `/oauth`, `/.well-known` in dev).

For Codex and Gemini CLI on macOS, Agent settings offers a one-click install
through Landed for Mac: `landed://connect-agent?agent=codex|gemini&url=…/mcp`.
The native app validates the HTTPS endpoint and asks in a native dialog. It then
uses the agent's own `mcp add` command. Codex supplies `mcp login`; Gemini CLI is
opened in Terminal with OAuth enabled for this server, so its startup opens the
browser consent automatically. Each agent remains the owner of its shared config
and OAuth credentials. Gemini's website has no custom MCP connector. Never remove
the native confirmation: any page can open a custom URL.

### The briefing

The briefing is **one deliberate exception** to "no user data on the server
for sync-off accounts". Cloud agents run in the cloud, so while the account has a
connection with `tasks:read` (connector or key), the browser shares
`{brief, applications: [{company, role, stage}]}` (`useCloudBriefing`,
`PUT /api/agent-briefing`, only when it changed; 409 without such a connection).
The server deletes it when the last such connection is revoked
(`dropBriefingIfUnused`). The consent page says so. Don't widen it (no notes,
contacts, resumes, emails). The other exception is a user-approved
personal-agent application task: it is scoped to one connection and one job,
and its copied context/file are erased on ack (details below).

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
- **Codex** (`codex.ts`, `codex exec --json`): found on the PATH or inside
  ChatGPT.app / Codex.app (`findCodex`, the same lookup as the connector; the app's
  CLI isn't on the PATH, and missing it left Codex only as a connected agent).
  Sandboxed by flags (read-only
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

The daemon detects capabilities by starting Claude Code just far enough to read
its init event (no model call, ~1.5 s), which lists the connected MCP servers and
their tools: the mailbox (`mailFromInit`, the same flags as an email check) and
Chrome (a `--chrome` probe). In `claude -p`, MCP servers connect in the
background by default, so a claude.ai connector often missed the init event
(about two runs in three). Detection, and every task that needs a connector,
sets `MCP_CONNECTION_NONBLOCKING=false` (`WAIT_FOR_CONNECTORS`) so Claude Code
connects them first. The last good mailbox lookup is cached
(`~/.landed/capabilities.json`) for an older Claude Code. Capabilities are
re-sent in `hello`.

**When**: at start, every 30 minutes, and **right away when a page is waiting
for a connector**. A user connects Gmail or Chrome somewhere else and comes back
to Landed, so the Workflow page asks every online computer to look again
(`recheck` in the automation sync) when it opens, when the user comes back to
it (focus / visibility), and every minute while it's open and still waiting.
The computer answers with what it reaches (`abilities`: mailbox `ready`,
`confirming` (connected but not usable yet; it looks again in 2 minutes) or
`missing`, plus Chrome), and the card says "Checking…", then "✓ Gmail
connected · read-only", or what to do. No button: coming back is the trigger.

An email or portal task whose MCP server is missing from the init event is
killed before the model runs and retried (`requireServer`, up to 5 times). A
task that still never called its mailbox or Chrome tool must end in an error,
not an empty success; otherwise a check that read nothing would advance
`email_checked_at` and skip mail.

The connector cache is only evidence of which read tools were safe the last
time Gmail loaded; it is not evidence that Claude Code is still signed in. Each
capability pass and every Claude task checks `claude auth status`. An explicit
sign-out removes Claude's task capabilities (while leaving `automation_sync` so
the computer stays connected), publishes `auth: signed_out` to the UI, and gives
the user the concrete recovery command, `claude auth login`. The 30-minute
capability pass restores the cached Gmail capability after login. CI keeps a
signed-out-with-cached-Gmail regression and runs it on every change and weekly.

## Agent page and chat

The Agent UI is its own page (`/agent`, sidebar: Applications → Agent → My
Resume; `components/agent-page.tsx`; product decision after acceptance review,
replacing the earlier side panel): chat when a computer is online, setup when
not, settings via `?view=settings`. Old `/applications?agent=…` and `/agents`
links redirect there. Agent work that belongs to a page stays there: the board
keeps only its own updates, and My Resume runs its own tasks.

Chat needs one agent (product decision, 2026-10-19): the header names it, and
Settings has "Chat with" when the computer has several (remembered on this
device). Which agents search for jobs is not chosen here; it's Find new jobs →
Search with (below).

- **What the agent knows about the user** (fix, 2026-10-19: asked to set up a
  search, the agent asked the user to paste their resume). Each chat message
  carries `context`, plain text built in the browser (`lib/chat-context.ts`):
  the master resume's gist (else the current resume's): where they live,
  education, jobs and internships with their first two bullets, projects,
  skills, languages; the saved answers that shape a search (work authorization,
  sponsorship, preferred places, other places, relocation, onsite, start date);
  and the active search. Never contact details, address, date of birth or EEO
  answers. The server bounds it (`parseChatContext`, 8,000 characters); the
  daemon puts it ahead of the message when a session starts, and again only
  when it changed (`contextToSend`), and the chat prompt says to propose from
  it and ask only what it leaves open. It goes to the user's own agent, like
  resume parsing and tailoring.
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

## Resume upload

My Resume reads each uploaded file with the user's agent (`resume_parse`), then
updates the master (`resume_merge`; `apps/web/src/lib/resume-tasks.ts`).

**No computer connected is not a dead end** (product decision 2026-10-19). The
upload area stays open and says what happens:

1. **Upload now.** One PDF or Word (.docx) file, up to 3 MB (`uploadWaiting`).
   The file is kept as the extension's resume file (Extension page), and the
   browser reads its text (pdf.js, mammoth) for what a resume says plainly:
   name (only a first line that plainly is one: two to four words, not a heading
   or a job title), email, phone (not a date range), LinkedIn, GitHub
   (`lib/resume-basics.ts`). It's saved as an uploaded resume with only those,
   the current one if it's the first, so the extension and the Extension page
   have them at once. Nothing leaves the browser.
2. **It waits.** `resumes.file_path` holds the kept file's name
   (`parseWaitingFile`: text up to 255 characters or null; the column existed
   and was never used). My Resume says "Waiting for your computer" in the list
   and on the resume, with "Connect your computer" (→ Agent page), and a
   "what happens next" card after the upload. A resume still waiting isn't
   merged into the master.
3. **Read in full on its own.** Once an agent that can run `resume_parse` is
   online, `readWaiting` (from `useResumeTaskRunner`, wherever the user is)
   sends the kept file, replaces the resume's contents with the full read,
   clears `file_path` and updates the master. Once per resume per session, so a
   failed read isn't retried in a loop. If the kept file was replaced on the
   Extension page in the meantime, it says so and reads nothing.

Photos, text files and files over 3 MB still need the computer: they can't be
kept as the extension's resume file to read later. Pasting from ChatGPT, Claude
or Gemini stays as the other way.

## Job search

How an agent searches (where to look, what to check before reporting a posting,
one entry per posting, its budget) is the shared playbook in
[agent-sourcing.md](agent-sourcing.md): the daemon's `job_search` and cloud
agents' `get_tasks` send the same lines (`packages/schema/src/agent-sourcing.ts`).

The chat agent ends a reply with a ```` ```landed-brief ```` JSON block once the
direction is clear; when the user said which agents should search or how often,
the same JSON may carry `search_with` (agent ids) and `schedule` ("daily 09:00",
"every 4 hours"), parsed by `parseSearchSetup`. The card (`components/search-brief.tsx`)
shows Search with, ticked from the current setting or the agent's suggestion, and
one button, **Save to Find new jobs & search now** (product decision,
2026-10-19: search is configured in one place). It stores the brief as the active
`job_searches` row (data store, one active per account), turns Find new jobs on
with that schedule and sources, and runs `job_search` now with the chosen agents
on the computer that runs the schedule (`chosenSearchTargets` in
`hooks/search.ts`, `lib/job-search.ts`), so a search now and the scheduled one
use the same agents. Nothing is set until the user clicks. The daemon returns schema-bound results
(`claude --json-schema`). The browser feeds each job through the observation
processor (`ingestFoundJobs` in `lib/inbox/leads.ts`) so they dedupe into the
**Leads** column like external agents' finds. The brief and result shapes and
validators live in one place, `packages/schema/src/search-brief.ts`; web, server,
and the chat prompt's block format in `apps/daemon/src/agents.ts` must agree.

## Workflow

`/workflow` (sidebar between Agent and My Resume; `/automation` redirects there)
shows Landed's work as steps, laid out like My Resume (product decision
2026-10-22, #140, overview #148): the middle column lists the steps grouped by
stage, each with a status line and a dot (green on, grey off, red needs the
user); the right side is the selected step: what it does, its controls (Run now
and the switch), who does it, when, what it needs, how it decides and its recent
runs. A stage's switch sits on its heading in the list (Find jobs, Apply); a step
with its own sits on its page (Check email, Check candidate portals). The
selected step is the URL's hash, so other pages link straight to one
(`/workflow#email`; the older `#find` and `#track` still land on a step). With
nothing picked it opens on What to look for until there is a search, else on the
first step that needs the user.

| Group | Steps (done by) | Settings |
|---|---|---|
| What to look for | Search criteria | The active brief, editable in place (an edit makes a new active search via `addJobSearch`) |
| 1 Find jobs | Agent search (the ticked agents and cloud agents, on the schedule) · Job lists and Company boards (Landed, each on its own schedule while Landed is open, with its last check's result) · Remove duplicates and Rank (Landed AI, built in, each new batch; the agents on the computer are listed as coming soon until #146 / #147) | Stage switch and Run now; agents, schedule, a switch per public source, the followed companies |
| 2 Apply | Auto apply (the extension; the user's agent checks the form) · Mark as applied (Landed, when the portal confirms) | Stage switch and Run now; at most N at a time |
| 3 Keep up to date | Check email (the ticked readers: the computer's agent that can read email, today Claude Code with its mail connector, and each cloud agent on its own; `email_check.readers`) · Check candidate portals (the agent that can use Chrome: Claude Code with Claude in Chrome, the only one wired for it) | A switch, schedule and Run now each; email: who reads it, the auto-apply choice (`users.auto_apply_updates`), re-read 30 days; portals: days without news |

The settings stay in `users.automations` (`packages/schema/src/automation.ts`),
which installed Landed for Mac versions and the server already validate; a
step gains its executor choice or schedule as its own field when it gets one
(#141–#147), and older daemons ignore fields they don't know. Remove duplicates,
Rank and Mark as applied have nothing to set yet: their rows say who does them.

**Auto apply** is not a daemon schedule. Its account-level
`users.automations.auto_apply` setting is on by default and carries `enabled`
plus `max_concurrent` (1–5). `useAutoApplyRunner` is mounted below the login gate,
so it runs on every Landed route, not only Applications. Workflow shows the
switch, concurrency, Run now, active/ready/blocked/confirmation counts and the
extension requirement. Turning it off stops new tabs; already-open authorized
tabs continue. Run now is still available while off. Only a linked saved lead
is authorization; the setting never broadens it.

**Find new jobs → Search with** (`users.automations.job_search.sources`,
`SearchSources` in `packages/schema/src/automation.ts`; `components/search-sources.tsx`):

- **Agents** on the computer that runs the schedule (Claude Code, Codex, any ACP
  agent there). Each ticked one searches, one after another, with the user's own
  subscription (`pickSearchAgents`; ticked ones that aren't on this computer →
  the first that can search). Unticking every one means none: the daemon logs
  nothing and the schedule moves on (the schedule is only for the computer's
  agents); the lists, boards and ticked cloud agents still search, cloud agents
  whenever they run. The page says "Not used" under When and shows who searches
  ("Claude.ai, ChatGPT on their own"). The daemon's scheduled run and Run now both use it, and the results
  are merged by the processor. Default: Claude Code.
- **SimplifyJobs lists** and **company job boards**, fetched by the browser while
  Landed is open (`lib/supply.ts`, `refreshSupply`'s `sources`); they cost no
  tokens. Run now refreshes them too.
- **Connected agents** (the UI's name for cloud agents: anything connected to
  Landed's MCP or agent API, including Codex through its connector, which runs
  on the same computer), one chip each, in their own row under the computer's
  agents and with when each was last active (`agent_connections.last_seen_at`).
  They pull the task when they run; Landed can't start them, so the schedule
  doesn't apply to them. An unticked one
  is in `cloud_skip` and `get_tasks` gives it no job search
  (`cloudAgentSearches`, `routes/mcp.ts`). `cloud_agents` stays the switch for all
  of them (older Landed versions read only that): unticking the last one turns it
  off, ticking one again turns it on with the others still skipped.

**Check email → Done by** (`users.automations.email_check.readers`, `AgentSources`;
default Claude Code and every cloud agent): the computer reads email with the
first ticked agent that can (`pickAgents`; today Claude Code once its mail
connector is found, listed before that so it can be ticked). None ticked: the
daemon logs nothing and the schedule moves on. Cloud agents read with their own
connectors; an unticked one is in `cloud_skip` and `get_tasks` gives it no email
check (`cloudAgentOn`). Other computer agents (Codex, ACP agents) get no email or
portal check until each has its own read-only allowlist (#144, a security
decision).

They run on a schedule the user sets (`users.automations` via `/me`, migration
0015; `packages/schema/src/automation.ts`, which also has the schedule math).
One exception: with Find new jobs on, the open web app also checks the public
SimplifyJobs lists and the job boards of companies the user follows itself, each
on its own schedule (`sources.schedules`, default daily) and right after the search
changes (`hooks/supply.ts`, `lib/supply.ts`; the last check of each is kept on the
search, `job_searches.source_runs`; see [leads-model.md](leads-model.md#sources)).
That needs no agent and no computer.

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
- **Personal-agent auto apply** is per connection (`automations.auto_apply.executor`).
  Approve authorizes one job. The browser copies that job, the chosen resume,
  saved application answers and prior edited open answers into
  `agent_apply_tasks`, even for a local-first account. Only the selected
  connection can read it. `submit_application_result` returns submitted,
  blocked or error plus structured `unanswered` questions. Those questions go
  into the existing Application answers queue; after the user answers all of
  them, the task's context is refreshed and the same authorized job is offered
  again. Ack then erases the copied context and resume bytes. The unguessable
  resume download expires after seven days and is invalid immediately on ack.
- **Email checks** need a mail connector the user already gave their agent, and
  the daemon allows **only its read tools**: the first word must be a read verb
  and no word a write verb, since "thread" contains "read". Discovered write tools
  are passed as `--disallowedTools`. The browser only sends
  `{since, applications: [{company, role, stage}]}`; mail content never reaches
  the server.

## Portal checks

`portal_check`, the fallback when email is silent, runs when the user clicks
(Agent page questions, or "Check status now" on an application's Candidate portal
card, `components/portal-card.tsx`) or on the Workflow schedule (opt-in, off by
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
