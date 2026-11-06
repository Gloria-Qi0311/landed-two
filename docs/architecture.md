# Landed: how it works

This page covers the whole of Landed: what the product is, the pipeline every
job goes through, the principles behind each decision, what each agent call
sees, and how the code fits together. Each area doc has the details, and this
page links to them. CLAUDE.md holds the rules.

## What Landed is

**Landed applies to jobs for the user.** It is built for people in a hiring
season (students, new grads, interns) who apply to many jobs, often of several
kinds (product, data, engineering), with a resume for each kind. They hand
applying over to Landed:

1. Landed finds jobs that fit what they're looking for and shows them as
   **Leads**, best first.
2. The user **approves** the ones they want. That is their one decision.
3. Landed fills and submits each approved application with the right resume,
   and writes the open-ended answers.
4. It records what it did, and keeps every application up to date from email
   and the companies' portals.

It stops only for what only a person can do: signing in, solving a CAPTCHA, or
answering a sensitive or legal question it has no answer for.

Two things set it apart:

- **It applies accurately, not just in volume.** Green means the value is
  there. It never guesses and never invents a fact. When it isn't sure, it
  stops that one application and says why.
- **The AI work runs on the user's own agents.** These are Claude Code, Codex,
  Gemini CLI or local Ollama on the user's own computer, or a cloud agent they
  already use (ChatGPT, Claude, Gemini…), on their own subscription. The data
  stays in their browser unless they turn on Cloud sync.

## Who does what

| The user | Landed |
|---|---|
| Sets up once: uploads resumes and says what each is for; answers the questions forms ask (work authorization, sponsorship, start date…); installs the extension and Landed for Mac; connects their mailbox | Reads the resumes into one master and its versions. Fills in the answers it already knows from the resume and the search. Remembers a fact the user corrects on a form |
| Says what they're looking for, in chat or on Workflow's What to look for | Finds jobs on a schedule, drops duplicates and jobs the user plainly can't apply to, and ranks the rest |
| Approves Leads, one or many at a time (undoable) | Applies to each approved job: picks the resume, fills every field, writes the open-ended answers, has the user's agent review the form, and submits |
| Clears a blocker when one comes up (signing in, a CAPTCHA, a question only they can answer) | Stops only that application and says why. The others go on |
| Reads updates and answers "Needs your input" | Moves applications forward from email and portals on its own when sure (undoable), and asks when not |

The user should never have to make a choice Landed can work out. When Landed
decides, it shows what it chose and why (which resume, why this score, what it
answered), and the user can change it.

## Principles

1. **Fully automatic; Approve is the one decision.** Don't hand back to the
   user a choice Landed can make. When Landed decides, show what it chose and
   why, with a way to change it.
2. **Landed's rules first, the agent as an optional layer.** Structured data is
   read by code, which costs no tokens and invents nothing. The agent is used
   only where judgment is needed. When it isn't sure, the safe default wins:
   keep the rules' pick, don't merge, don't fill.
3. **Agents report; Landed decides.** Agents never write to the pipeline. They
   send observations, and one package turns them into leads and suggestions in
   the browser. Agents propose; the user acts on what changes the record:
   reported applications, answers read from a form, merging duplicates.
4. **Never guess, never invent.** A field with no saved answer stays for the
   user. If Landed isn't sure a filter applies, it doesn't filter. Tailored
   resumes and open-ended answers use only the resume's facts.
5. **Everything automatic is recorded, and what can be undone can be undone.**
   That covers approvals (until the application starts), email updates,
   imports, answers filled in or remembered, and merges. A submitted
   application can't be taken back, so only an approved lead is ever
   submitted, and only after every check passes.
6. **Local-first.** Data lives in the browser unless the user turns on Cloud
   sync. The server relays and never stores a sync-off account's data.
   Scheduling runs in Landed for Mac; processing runs in the browser.
7. **The user's own agents, within fixed limits.** Each agent call has a fixed
   request type validated at both ends, a fixed tool allowlist, and a fixed
   scope of what it sees (see "What each agent call sees" below). Widening any
   of them is a product and security decision for the owner.
8. **Never past a human gate.** Landed never bypasses a CAPTCHA or a sign-in,
   never stores a site password, and never ticks a consent box the user didn't
   switch on.

## The parts

```
 ┌─────────────────────────── the user's computer ────────────────────────────┐
 │                                                                             │
 │  Browser                                                                    │
 │  ┌──────────────────────────────┐   page bridge    ┌──────────────────────┐ │
 │  │ apps/web (React)             │◄── postMessage ─►│ apps/extension (MV3) │ │
 │  │  DataStore                   │                  │  content scripts in  │ │
 │  │   ├ local.ts → IndexedDB     │                  │  every frame: fill,  │ │
 │  │   └ cloud.ts → server ───────┼──┐               │  portal detection    │ │
 │  │  observation processor       │  │               │  background worker   │ │
 │  │  supply: sources, filters,   │  │               └──────────▲───────────┘ │
 │  │  scores (packages/supply)    │  │          native messaging │ / Safari   │
 │  └──────────────────────────────┘  │                           │ bridge     │
 │  apps/daemon (Landed for Mac)      │                           │            │
 │  ┌─────────────────────────────────┼───────────────────────────┴──────────┐ │
 │  │ menu bar app · LaunchAgent daemon · native host · updater              │ │
 │  │ runs tasks with local agent CLIs (Claude Code, Codex, ACP agents)      │ │
 │  │ runs the schedule; native host answers the extension's agent requests  │ │
 │  └─────────────────────────────────┬──────────────────────────────────────┘ │
 └────────────────────────────────────┼────────────────────────────────────────┘
                                      │ SSE tasks / POST results
 ┌────────────────────────────────────▼────────────────────────────────────────┐
 │ apps/server (Hono + Postgres, Mac mini behind a tunnel)                     │
 │  accounts · Cloud data (sync-on only) · agent relay · runtime hub (memory)  │
 │  MCP + OAuth for cloud agents · serves the web app and Mac app downloads    │
 └────────────────────────────────────▲────────────────────────────────────────┘
                                      │ MCP / HTTP with per-connection tokens
                     cloud agents (ChatGPT, Claude, Gemini, Muse, Manus…)
```

| Part | What it is | Start reading at |
|---|---|---|
| `apps/web` | Vite + React app: Applications board, Agent page, Workflow, My Resume, Extension | `src/App.tsx`, `src/lib/store/types.ts` |
| `apps/server` | Hono API on Postgres: auth, Cloud data, agent relay, runtime hub, MCP/OAuth, downloads | `src/app.ts`, `src/routes/` |
| `apps/daemon` | Node daemon plus the Swift menu bar app, packaged as Landed for Mac. Runs agent tasks and the schedule, and answers the extension's native requests | `src/cli.ts`, `src/agents.ts`, `src/native-host.ts`, `macos/LandedMenuBar.swift` |
| `apps/extension` | MV3 extension for Chrome, Edge, Brave and Safari: fills and submits applications, detects portal status | `manifest.json`, `background.js`, `content.js`, `lib/fill/` |
| `packages/schema` | Shapes and validators shared by web, server and daemon | `src/index.ts` |
| `packages/observation-processor` | Matching, dedupe and auto-apply rules (pure functions) | `src/index.ts`, [observation-processor.md](observation-processor.md) |
| `packages/supply` | Job source parsers, hard filters, fit score, priority (pure functions) | `src/index.ts`, [leads-model.md](leads-model.md) |
| `packages/ai-roundtrip` | Prompt and parse helpers for the paste-to-ChatGPT fallback | `src/index.ts` |

## Where data lives

| Data | Sync off | Sync on |
|---|---|---|
| Applications, leads, suggestions, resumes and their files, answers, files, chats, searches | IndexedDB `landed-<userId>` | Postgres, through `cloud.ts` |
| Account, preferences, Workflow settings (`users.automations`) | Postgres `users` row | same |
| Agent observations | Server holds them until the browser pulls and acks, then keeps only a hash | stored |
| Runtime tasks and their output | Server memory only, never the database | same |
| Briefing for cloud agents (`{brief, applications: [{company, role, stage}]}`) | Server, only while a cloud-agent connection exists | same |
| Fill traces | The extension keeps the last 20 | also on the server for 30 days |
| Extension: resumes, their files, answers, pending portal events | `chrome.storage.local` | same |
| Daemon automation state | `~/.landed/automations.json` | same |

The web app reaches data only through the `DataStore` interface, which has two
implementations: `local.ts` (Dexie) and `cloud.ts` (the API). Details are in
[data-and-sync.md](data-and-sync.md).

## The pipeline

Every job goes through one pipeline. Each stage has a default **executor**,
Landed's own rules ("Landed AI" on the page), and some stages can add the
user's agent as an optional layer. Each stage also has a schedule or trigger.

The **Workflow** page (`/workflow`; #140, shipped in #149; overview #148) shows
the pipeline as steps:

- What to look for;
- 1 Find jobs: agent search, job lists, company boards, remove duplicates,
  rank;
- 2 Apply: auto apply, mark as applied;
- 3 Keep up to date: check email, check candidate portals.

Each step shows its status, who does it, when, what it needs, its recent runs
and its switch. The settings stay in `users.automations`; a step gains its own
executor or schedule field when it gets one, and older Landed for Mac versions
ignore fields they don't know.

Today the user picks who does **Agent search** (#151) and **Check email**
(#153). For each, every agent on the computer and each cloud agent is ticked
on its own, and all unticked means none. Choosing an executor for the other
steps is planned: apply (#142), portal checks (#144), each source kind (#145),
remove duplicates (#146), rank (#147). Running every step with the page closed
is #141. Details: [agents.md](agents.md#workflow).

```
 ① Find jobs     job lists · platform APIs · wild jobs (agents) · plus manual add, CSV import, screenshots
      ↓
 ② Dedupe        the same job never twice; never two jobs merged into one
      ↓
 ③ Screen, rank  hard filters (only what a posting says outright), fit × urgency
      ↓
    Leads ──► the user approves (authorizes that one job)
      ↓
 ④ Apply         extension: resume, fill, open-ended answers, review, submit
      ↓
 ⑤ Write back    confirmed → Applied, with the resume used and the answers sent
      ↓
 ⑥ Keep current  email checks, portal checks → stage moves, or a question
```

### ① Find jobs

| Source | Executor (default) | Status |
|---|---|---|
| **Job lists**: SimplifyJobs New Grad and Internships | Landed's code reads the list, in the browser while Landed is open: 30 seconds after the search changes, then every 6 hours; no tokens | Shipped (#90). Planned: more lists, especially product / data / business (#138) |
| **Platform APIs**: Greenhouse, Lever, Ashby boards of up to 25 followed companies | Landed's code, in the browser like the lists | Shipped (#91). Planned: more platforms (#138) |
| **Wild jobs**: postings on no list (company sites, posts, referrals) | Agent search (`job_search`, web tools only): each agent on the computer and each cloud agent ticked on its own (#151), every 3, 6 or 12 hours, daily, on weekdays or weekly (#152) | Shipped. Planned: the playbook and measurement (#138) |
| **The user**: Add, a spreadsheet import, screenshots in chat | The user, and Landed reads them | Shipped (#120; chat blocks) |

```
Agent chat → landed-brief block → user confirms → active job_searches row
   ├─► job_search task on every online computer's agents (daemon)
   ├─► cloud agents: get_tasks → submit_jobs
   └─► external agents: job_discovered observations
SimplifyJobs lists, Greenhouse / Lever / Ashby boards (fetched by the browser)
   └─► the same path
              ▼
lib/inbox/leads.ts → ingestFoundJobs → ② → ③ → Leads column
```

What to look for comes from the active search: a brief the user confirms in
chat, or edits on Workflow's What to look for (roles, places, level, companies
to look at first, sponsorship). Public postings are fetched by the browser,
never through the server, and which companies the user follows never leaves the
browser.

Every posting has one stable observation id, so refreshing never adds it twice,
and a posting gone from its source is marked closed.

Planned:
- fetching the lists and boards from Landed for Mac while the page is closed
  (#141; it needs the owner's OK on that rule);
- each source kind with its own executor and schedule (#145).

Details: [leads-model.md](leads-model.md), [agents.md](agents.md#job-search).

### ② Dedupe

`packages/observation-processor` is the one place matching rules live
(`sameJob` and `applicationForPosting` in `src/process.ts`). A job already in Leads or already applied
to doesn't come back, and a lead for a job the user applied to leaves Leads
(`already_applied`). On the board, near-identical applications are flagged
"Possible duplicate" and merged only when the user clicks. Remove duplicates is
Landed AI, built in, on each new batch.

Planned (#146; Workflow lists the user's agents for this step as coming soon):
the pairs the rules can't decide go to the user's agent, which sees only the two
postings. "Not sure" counts as different: one extra lead is
better than a real job hidden. Details:
[observation-processor.md](observation-processor.md).

### ③ Screen and rank

- **Hard filters** (#92) act only on what a posting says outright: a graduation
  window, no sponsorship when the user needs it, citizenship or clearance. When
  Landed isn't sure, the job isn't filtered. Filtered leads are hidden, never
  deleted, and one the user puts back stays back.
- **Rank** (#93): fit (title, skills, level, place, years) × urgency (deadline,
  posting age), with two or three reasons on each card. Landed AI, built in.
  Planned (#147; listed as coming soon on Workflow): the user's agent scores
  each new batch with reasons. The rule score stays as the
  floor, and an agent that times out never holds a lead back.

Both run in the browser, since they read the resume. Details:
[leads-model.md](leads-model.md).

### Leads and Approve

The Leads column holds two kinds of record, best first and grouped by company:

- candidates (`job_leads`, status `new`);
- approved jobs (`applications`, stage `saved`).

**Approving a lead authorizes applying to and submitting that one job**, and
nothing else: not a discovered lead, not a manually saved application, not a
later job. Approving many at once runs `addLeadToPipeline(lead, 'saved')` for
each, so it is still one job at a time, and it can be undone.

Planned (#142): a five-minute countdown after Approve, with Undo, before the
application starts.

### ④ Apply

The extension applies, in the user's own browser. Workflow's Auto apply step is
the one place to manage it: on by default, 1–5 applications at a time in
priority order, Run now, and the queue and blockers. It skips a company already
at OA, interview, offer or recruiter contact.

```
approved Leads queue (≤5)  ·  "Open & autofill"  ·  popup "Fill"  ·  menu bar app
   ▼
extension background.js → fillTab: the page plus every frame that reported a form
   ▼
1 resume: the version tailored for this job (or for a close role at the same
  company), else the resume whose direction is this job's; close calls →
  native host pick_resume. Its own file is uploaded
2 fill (lib/fill/*, content.js, in this order): files → each job and school
  entry → saved answers → resume rules → selects → dropdowns → dates → radios
  and checkboxes → fields the user saved
   ├─ unknown labels → native host match_fields (labels and key names only)
   └─ unanswered choices → native host choose_options (local Ollama only)
3 open-ended questions → native host draft_answers: written, then checked
  against the resume
4 settle: every green field read again after the page's scripts ran
5 review → native host review_fill: the user's agent checks the filled form
   ▼
manual fill: green / yellow fields, the user submits
approved lead: every required field answered, the review clean, no sign-in or
  CAPTCHA → one unambiguous final Submit is clicked; anything else stops that
  one application, with the reason
```

Questions nothing answered are asked once on the Extension page, and the answer
fills every later form. A fact the user corrects on a form (city, start date, a
general yes/no) becomes the saved answer, with Undo (#134). Manual Open &
autofill, the popup and the menu bar fill but never submit. Every fill keeps a
trace under a short ref.

Planned (#142): other executors, such as an agent driving Chrome, once the
owner agrees on their safety rules. Details: [apply-assist.md](apply-assist.md).

### ⑤ Write back

Workflow's Mark as applied step. The "thanks for applying" page sends a portal
event, and `lib/inbox/confirmations.ts` moves the application to Applied. The application
keeps:

- the resume used and why (`resume_choice`);
- the open-ended answers sent (`open_answers`), which the user can edit, and
  edited ones teach the agent;
- the fill trace.

Planned (#143): Applied the moment a submit is confirmed, and a CAPTCHA that
appears after Submit is recorded as a blocker.

### ⑥ Keep current

| Check | Executor | Reach | Then |
|---|---|---|---|
| Email | The ticked readers (#153): the computer's agent that can read email (today Claude Code with its mail connector) and each cloud agent on its own, with the mailbox's **read** tools only; on the schedule set on Workflow | New mail since the last check (or back to an import, up to 90 days) | Status observations |
| Portals | Claude Code with Claude in Chrome, the only agent wired for it, with Chrome's **navigate and read** tools only | Portals of applications quiet for N days, at most 5 a run | Status observations |
| Pages the user visits | The extension | Confirmation and status pages | Portal events |

```
email check (daemon, scheduled)  ─┐
cloud agent submit_email_updates ─┼─► application_status observation ─► server (relay or store)
portal check (Claude in Chrome)  ─┘                                          │
extension portal events (pages)  ──────────── page bridge ───────────┐       │
                                                                     ▼       ▼
                                         browser: lib/inbox/process.ts → processPending
                                         packages/observation-processor decides:
                                           confident forward move → apply (undoable)
                                           otherwise → "Needs your input"
```

A confident forward move applies on its own unless the user turned that off on
Check email (`users.auto_apply_updates`; then every update asks). These always
ask the user: an ambiguous update, a low-confidence one, and one that would
reopen a closed application. Check email also has "Re-read the last 30 days". After 21 days with no news, Landed asks
whether to call an application ghosted. Planned (#144): another agent for
portal checks, and other computer agents (Codex, ACP agents) for email. Each
needs its own read-only allowlist, which is a security decision. Details: [agents.md](agents.md), [pipeline.md](pipeline.md).

## Around the pipeline

- **Resumes** (My Resume). The user's agent reads uploads (`resume_parse`) into
  one **master** that keeps every phrasing (`resume_merge`). **Versions** are
  tailored to a job (`resume_tailor`) and never invent a fact; each version's
  one-page PDF is made in the browser. Each upload says what it's for (its
  directions) and keeps its own file.
  Details: [pipeline.md](pipeline.md#my-resume-uploads--master--versions).
- **Application answers** (Extension page): what forms ask that a resume
  doesn't. Landed fills in what it already knows from the resume and the
  search, each answer once and marked with Undo. It ticks consent only when the
  user's own switch is on.
  Details: [apply-assist.md](apply-assist.md#application-answers-and-the-extension-page).
- **The chat agent** (Agent page): one agent. It knows the resume gist, the
  answers that shape a search, and the search, but never contact details. It
  proposes through cards the user clicks: a search brief, applications read
  from screenshots, answers read from a filled form, duplicates to merge.
  Details: [agents.md](agents.md#agent-page-and-chat).
- **Cloud agents** (ChatGPT, Claude, Gemini, Muse, Manus…): connect over MCP,
  read a briefing, and report jobs and email updates as observations. Each can
  be ticked on its own for Agent search and Check email.
- **Accounts and data**: an account's data lives on this device unless the user
  turns on Cloud sync (and back off). The account menu also exports and
  restores a backup and shows recovery codes. A new account gets a short tour
  (again from the menu). Details: [data-and-sync.md](data-and-sync.md).
- **Bringing history in**: spreadsheet import and CSV export. Import reads
  statuses with rules first, then with the user's agent for the ones the rules
  can't read. Details: [pipeline.md](pipeline.md#importing-a-spreadsheet).

## What each agent call sees

| Call | Runs on | Sees | Never sees | Can only |
|---|---|---|---|---|
| `match_fields` | Local Ollama, else Claude Code with no tools | Field labels, resume key names | Any value | Name a key; Landed supplies the value |
| `choose_options` | Local Ollama only | A question, its options, the saved answers | — | Pick an option |
| `review_fill` | The user's Claude Code with no tools, else Ollama | The filled form and the facts it came from | Sensitive questions: EEO, date of birth, ID numbers, salary, consent | Pick a fact or an option; flag the rest |
| `pick_resume` | Same | The posting; each candidate resume's directions, titles, skills | Name, contact details, address | Name one candidate (confidence ≥ 0.7) |
| `draft_answers` | Same (writing uses `sonnet`) | The posting; the resume's experience, projects, education, skills, summary; the user's edited answers | Name, contact details, address | Write answers that a second call checks against the resume |
| `classify_statuses` | Same | Status words from an imported sheet | Companies, roles, notes | Name a stage, or "unknown" |
| Chat | The user's chosen agent, with web tools | Resume gist, the answers that shape a search, the search | Contact details, address, date of birth, EEO | Answer, and propose cards |
| `job_search` | The user's agents, with WebSearch / WebFetch | The search brief | — | Report found jobs |
| `email_check` | The ticked reader, with the mailbox's read tools | The mailbox | — | Report status updates |
| `portal_check` | Claude Code with Claude in Chrome, navigate and read tools only | The portals of quiet applications | — | Report status updates |
| Resume parse / merge / tailor | The user's agent | The resume | — | Read the resume; tailoring never invents |
| Planned: same job (#146) | The chosen agent | Two postings' public text | Anything about the user | Answer same / different / not sure |
| Planned: rank (#147) | The chosen agent | The posting; the master resume's gist | Name, contact details, address, date of birth, EEO | Give a 0–1 score and reasons |

## Trust boundaries

| Part | Never does |
|---|---|
| Server | Store data for a sync-off account (except the briefing); write runtime tasks to the database; forward free-form commands to a daemon |
| Agents | Edit the pipeline directly; use write tools on the mailbox; click, type or run scripts in Chrome during portal checks |
| Daemon | Pair without the native confirm dialog; run an agent with the user's own settings, hooks or MCP servers (except the mail or Chrome tools a task needs); install an update not signed with its release key |
| Extension | Click Submit, except one unambiguous final Submit for an approved lead once every check passed; bypass a CAPTCHA; tick a consent box unless the user turned that on; send answer values anywhere but the user's own agent; send sensitive answers to any model |

## Where the user sees it

| Surface | Holds |
|---|---|
| **Applications** | The board (Leads → Applied → OA / Test → Interview → Offer → Rejected, cards grouped by company), Leads with Approve, "Needs your input", the agents' updates |
| **Agent** | Chat, the agent's questions, setup (pairing a computer, choosing which agents to use) |
| **Workflow** | The pipeline as steps (What to look for, Find jobs, Apply, Keep up to date): each step's status, who does it, when, its switch, Run now and recent runs |
| **My Resume** | Uploads, the master, versions, what each is for, each one's file |
| **Extension** | Application answers, files, questions waiting for an answer, answers remembered from forms |
| Extension popup / Landed for Mac menu bar | Fill the page in front of the user (never submit), the fields left and why |

## Common changes, and every place they touch

| Change | Touch |
|---|---|
| New data table or column | Dexie `this.version(n)` in `local.ts`, a migration `apps/server/migrations/NNNN_*.sql`, the server route (behind `requireCloud`), `DataStore` in `types.ts` + `local.ts` + `cloud.ts`, `SNAPSHOT_TABLES` (web) and `COLUMNS` in `routes/sync.ts`, deletion in `/api/cloud/disable` |
| New agent task kind | Input validation in `routes/runtime.ts`, a runner in `apps/daemon/src/agents.ts` (and `specFor` for Codex/ACP), the agent's `kinds` |
| New native host request (the extension asking the user's agent) | A handler with its own input check in `apps/daemon/src/native-host.ts`; the allowed `type` in `background.js` (`native-assist`) or a case in `lib/bridge-handler.js`; a row in "What each agent call sees" above, and a CLAUDE.md rule if what it sees is new |
| New observation type or field | Validators in `routes/agent.ts`, `AGENT_PROTOCOL.md`, the prompt in `apps/web/src/lib/agent-prompt.ts` |
| New job source | A pure parser in `packages/supply` with tests, a stable observation id, closed detection, a switch on Workflow's Find jobs step ([leads-model.md](leads-model.md)) |
| New autofill rule | The `lib/fill/*.js` module for that kind of field, or `lib/choice-answers.js` for a question; an integration test in `apps/extension/tests/`; `live-check` before release |
| New extension fill module | A file in `lib/fill/` that registers on `window.LandedFill`, listed in `manifest.json` `content_scripts` before `content.js` |
| New page | A route in `App.tsx`, a nav item in `components/shell.tsx` |

## Tests and CI

`pnpm typecheck && pnpm lint && pnpm test` runs everything, the same as CI
(`.github/workflows/ci.yml`: Ubuntu, Node 24, Postgres 17).

| Where | Runner | Notes |
|---|---|---|
| `apps/web` | Vitest | Store, inbox flows, matching helpers, parity tests against the extension's rules |
| `apps/server` | node:test | Needs `TEST_DATABASE_URL`; the suite wipes and re-creates that database |
| `apps/daemon` | node:test | Some tests are macOS-only and skip on Linux |
| `apps/extension` | Jest + jsdom | Whole-page fill tests load the content scripts in manifest order (`tests/helpers/content-scripts.js`). `pnpm --filter ./apps/extension live-check` fills real pages; it isn't in CI |
| `packages/observation-processor`, `packages/ai-roundtrip`, `packages/supply` | Vitest | `packages/supply` also tests `@landed/schema/lead-queue` |

## Releases

`deploy/mac-mini/deploy.sh` runs from a clean checkout. It pushes the server
and web app to the Mac mini and restarts them, then builds, signs and uploads
Landed for Mac. Installed copies update themselves (see
[apply-assist.md](apply-assist.md#landed-for-mac-updates-itself)).

## Where it's going

| Issue | What | Owner | Status |
|---|---|---|---|
| #140 | Foundation: Automation becomes the Workflow page | Antares | Shipped (#149). Also shipped since: each agent and cloud agent ticked on its own for Agent search (#151) and Check email (#153); searches every 3 or 6 hours (#152) |
| #148 | Workflow overview: every stage configurable | Both | Planned (open) |
| #141 | Landed for Mac runs every stage on its schedule, with the page closed | Antares | Planned |
| #142 | ④ An undo window after Approve, and other executors | Antares | Planned |
| #143 | ⑤ Applied the moment a submit is confirmed | Antares | Planned |
| #144 | ⑥ Another agent for portal checks, other computer agents for email | Antares | Planned (choosing email readers shipped in #153) |
| #138 | More job lists and platforms (beyond engineering), the wild-job playbook, before/after numbers | Gloria | Planned |
| #145 | ① Each source kind with its own executor and schedule | Gloria | Planned |
| #146 | ② The user's agent for pairs the rules can't decide | Gloria | Planned |
| #147 | ③ The user's agent scores with reasons | Gloria | Planned |

Order of what's left: #141 and #145 in parallel, then #146 before #147.
#142, #143 and #144 can go in any order.
