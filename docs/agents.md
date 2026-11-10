# Agents on the user's computer

Landed uses agents the user already has, on their own computer: Claude Code,
Codex and ACP agents (Gemini CLI, Copilot, Cursor, Goose…). `apps/daemon` (the
connector) runs them for Landed's tasks. External agents with a key, cloud
agents through MCP and personal agents applying for the user were removed in
Landed two (#3).

## Agents report; Landed decides

What an agent finds (jobs, email updates) never edits the pipeline directly.
The browser turns each result into an observation and runs it through
`packages/observation-processor` (pure functions, the only place matching and
auto-apply rules live; [observation-processor.md](observation-processor.md)),
which produces job leads and review-queue suggestions
(`apps/web/src/lib/inbox`: `ingestFoundJobs`, `ingestEmailFindings`).

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
  rows of one list apart (产品管培生（上海） vs （广东省）), so confirmation-page matching
  uses `keepBrackets` and a 0.8 bar. Dexie v8 recomputes stored lead keys.
- Ingesting is idempotent: one stable observation id per run and item, so a
  result stored twice changes nothing.

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

Tasks are a fixed set of kinds (`job_search`, `email_check`, `resume_parse`, `resume_merge`, `resume_tailor`, `automation_sync`), validated on both ends. The server forwards only the
validated fields. **Never forward arbitrary commands, prompts-as-shell, or file
paths to the daemon.** A new kind gets explicit input validation in
`routes/runtime.ts`, a runner in `apps/daemon/src/agents.ts`, and an entry in that
agent's `kinds`. Daemons report what they can run; older ones get
`409 runtime_outdated`. The Agent chat and its `chat` kind were removed in
Landed two (#2).

### Any agent, three runners

- **Claude Code** (`agents.ts`): the only one with email checks (its mail
  connector).
- **Codex** (`codex.ts`, `codex exec --json`): found on the PATH or inside
  ChatGPT.app / Codex.app (`findCodex`; the app's CLI isn't on the PATH).
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
hooks), and an explicit tool allowlist (`--tools` / `--allowedTools`). Search
also passes `--strict-mcp-config` so none of the user's MCP connectors load.
Email checks get `ToolSearch` (connector tools are deferred behind it) and the
mailbox's read tools, never write tools. **Widening the allowlist is a
product and security decision, not a convenience.**

### Capabilities

The daemon detects capabilities by starting Claude Code just far enough to read
its init event (no model call, ~1.5 s), which lists the connected MCP servers and
their tools: the mailbox (`mailFromInit`, the same flags as an email check). In
`claude -p`, MCP servers connect in the
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

An email task whose MCP server is missing from the init event is killed
before the model runs and retried (`requireServer`, up to 5 times). A task
that still never called its mailbox tool must end in an error,
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

## Connector page and Landed's questions

There is no Agent chat in Landed two (#2; [product.md](product.md) section 6).
Pairing a computer is the **Connector** page (`/connector`, last in the sidebar;
`components/connector-page.tsx` → `RuntimePanel`): connect this computer, see
which agents each computer found, disconnect one. Old `/agent` and `/agents`
links redirect there. Agent work that belongs to a page stays there: the board
keeps its own updates, My Resume runs its own tasks, and the search criteria are
set on Workflow's What to look for.

- **What the agent knows about the user**: when the user's agent ranks new leads
  (`rank_leads`), it gets plain text built in the browser
  (`lib/agent-context.ts`, at most 8,000 characters): the master resume's gist
  (else the current resume's): where they live, education, jobs and internships
  with their first two bullets, projects, skills, languages; the saved answers
  that shape a search (work authorization, sponsorship, preferred places, other
  places, relocation, onsite, start date); and the active search. Never contact
  details, address, date of birth or EEO answers.
- **Landed's questions** are ordinary pending suggestions with Landed-made dedupe
  keys, asked under "Needs your input" on Applications as their own cards
  (`components/panel-questions.tsx`, counted in the sidebar's Applications
  badge), and closed automatically when something else answers them
  (`settleQuestions` in `lib/inbox/questions.ts`):
  - `click:lead:<id>` / `click:app:<id>`: "did you apply?" after opening a posting
    from Landed (`recordApplyClick`);
  - `quiet:<app id>`: no signal for 21 days on an in-progress application
    (`flagQuietApplications`). Answers: ghosted (undoable) or wait (asks again
    in 21 days);
  - duplicate applications, one card per group (`components/duplicates.tsx`).
- **Confirmation pages → applications**: a "thanks for applying" page the
  extension saw is matched by `matchReported` (`lib/inbox/reported.ts`), stricter
  than email matching: same employer plus the same link or a close role (another
  role at the same company is a new application). An existing one is only moved
  forward, and a matching lead goes into the pipeline instead of a duplicate.

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
   and on the resume, with "Connect your computer" (→ Connector page), and a
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
[agent-sourcing.md](agent-sourcing.md): the daemon's `job_search` sends it to
whichever agent searches (`packages/schema/src/agent-sourcing.ts`).

The search criteria (the brief) are set in one place, Workflow's What to look
for, and stored as the active `job_searches` row (data store, one active per
account). Run now and the schedule run `job_search` with the agents ticked under
Find new jobs, on the computer that runs the schedule (`chosenSearchTargets` in
`hooks/search.ts`, `lib/job-search.ts`). The daemon returns schema-bound results
(`claude --json-schema`). The browser feeds each job through the observation
processor (`ingestFoundJobs` in `lib/inbox/leads.ts`) so they dedupe into the
**Leads** column. The brief and result shapes and validators live in one place,
`packages/schema/src/search-brief.ts`; web, server and daemon must agree.

## Workflow

`/workflow` (sidebar between Applications and My Resume; `/automation` redirects there)
shows Landed's work as steps, laid out like My Resume (product decision
2026-10-22, #140, overview #148): the middle column lists the steps grouped by
stage, each with a status line and a dot (green on, grey off, red needs the
user); the right side is the selected step: what it does, its controls (Run now
and the switch), who does it, when, what it needs, how it decides and its recent
runs. A stage's switch sits on its heading in the list (Find jobs, Apply); a step
with its own sits on its page (Check email). The
selected step is the URL's hash, so other pages link straight to one
(`/workflow#email`; the older `#find` and `#track` still land on a step). With
nothing picked it opens on What to look for until there is a search, else on the
first step that needs the user.

| Group | Steps (done by) | Settings |
|---|---|---|
| What to look for | Search criteria | The active brief, editable in place (an edit makes a new active search via `addJobSearch`) |
| 1 Find jobs | Agent search (the ticked agents, on the schedule) · Job lists and Company boards (Landed, each on its own schedule while Landed is open, with its last check's result) · Remove duplicates (Landed rules, or the rules then the user's agent for close calls, #146) and Rank (Landed rules, or the rules and the user's agent, #147), each new batch | Stage switch and Run now; agents, schedule, a switch per public source, the followed companies |
| 2 Apply | Auto apply (the extension; the user's agent checks the form) · Mark as applied (Landed, when the portal confirms) | Stage switch and Run now; at most N at a time |
| 3 Keep up to date | Check email (the ticked readers: the computer's agent that can read email, today Claude Code with its mail connector; `email_check.readers`) | A switch, schedule and Run now each; email: who reads it, the auto-apply choice (`users.auto_apply_updates`), re-read 30 days |

The settings stay in `users.automations` (`packages/schema/src/automation.ts`),
which installed Landed for Mac versions and the server already validate; a
step gains its executor choice or schedule as its own field when it gets one
(#141–#147), and older daemons ignore fields they don't know. Remove duplicates
and Rank have `job_search.dedupe_by` and `job_search.rank_by` (`landed` or
`agent`; the browser asks, through the extension and Landed for Mac, not the
daemon). Mark as applied has nothing to set: its row says who does it.

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
  nothing and the schedule moves on; the lists and boards still search. The page
  says "Not used" under When. The daemon's scheduled run and Run now both use
  it, and the results are merged by the processor. Default: Claude Code.
- **SimplifyJobs lists** and **company job boards**, fetched by the browser while
  Landed is open (`lib/supply.ts`, `refreshSupply`'s `sources`); they cost no
  tokens. Run now refreshes them too.

**Check email → Done by** (`users.automations.email_check.readers`, `AgentSources`;
default Claude Code): the computer reads email with the first ticked agent that
can (`pickAgents`; today Claude Code once its mail connector is found, listed
before that so it can be ticked). None ticked: the daemon logs nothing and the
schedule moves on, and nobody reads email. Other computer agents (Codex, ACP agents) get no email
check until each has its own read-only allowlist (#144, a security decision).

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
  a run-now. A run-now that arrives while the same kind is running is never
  dropped: the daemon runs it right after, once, with the context the browser
  sent since and the furthest re-read asked for (`runNow` in
  `apps/daemon/src/automations.ts`); the browser clears its request once a sync
  delivered it.
- **The browser side**: the `automation_sync` task (`lib/automation-sync.ts`,
  `useAutomationRunner`) sends the schedule plus the context the tasks need
  (`{applications, email_since, brief, search_id}`) and acks the
  results it has stored. The daemon answers with finished results and its run log.
  Results go through the processor, and nothing is stored on the server.
- **One designated computer** runs the schedule (the online one that can do the
  most of what's turned on: read mail), and every online computer gets
  the settings so a previous one stops.
- **Email checks** need a mail connector the user already gave their agent, and
  the daemon allows **only its read tools**: the first word must be a read verb
  and no word a write verb, since "thread" contains "read". Discovered write tools
  are passed as `--disallowedTools`. The browser only sends
  `{since, applications: [{company, role, stage}]}`; mail content never reaches
  the server.
