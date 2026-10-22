# How Landed fits together

Landed is a job-hunt workspace. It keeps applications on one board, updates
them from email and candidate portals, finds new postings, tailors resumes and
fills application forms in the browser. The AI work runs with agents the user
already has (Claude Code, Codex, Gemini CLI, Muse…), on their own computer and
subscription.

Two ideas shape the code:

- **Local-first.** An account's data lives in its own browser database unless the
  account turns on Landed Cloud sync. The server holds accounts, relays agent
  work, and stores data only for sync-on accounts.
- **Agents report, Landed decides.** Agents never edit the pipeline. What they
  find comes in as observations. One pure-function package turns observations
  into leads and suggestions, and it runs in the browser.

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
 │  └──────────────────────────────┘  │               └──────────▲───────────┘ │
 │                                    │          native messaging │ / Safari   │
 │  apps/daemon (Landed for Mac)      │                           │ bridge     │
 │  ┌─────────────────────────────────┼───────────────────────────┴──────────┐ │
 │  │ menu bar app · LaunchAgent daemon · native host · updater              │ │
 │  │ runs tasks with local agent CLIs (Claude Code, Codex, ACP agents)      │ │
 │  │ runs the automation schedule; local model (Ollama) for autofill        │ │
 │  └─────────────────────────────────┬──────────────────────────────────────┘ │
 └────────────────────────────────────┼────────────────────────────────────────┘
                                      │ SSE tasks / POST results
 ┌────────────────────────────────────▼────────────────────────────────────────┐
 │ apps/server (Hono + Postgres, Mac mini behind a tunnel)                     │
 │  accounts · Cloud data (sync-on only) · agent relay · runtime hub (memory)  │
 │  MCP + OAuth for cloud agents · serves the web app and Mac app downloads    │
 └────────────────────────────────────▲────────────────────────────────────────┘
                                      │ MCP / HTTP with per-connection tokens
                         cloud agents (ChatGPT, Claude, Muse, Manus…)
```

| Part | What it is | Start reading at |
|---|---|---|
| `apps/web` | Vite + React app: Applications board, Agent page, Workflow, My Resume, Extension | `src/App.tsx`, `src/lib/store/types.ts` |
| `apps/server` | Hono API on Postgres. Auth, Cloud data, agent relay, runtime hub, MCP/OAuth, downloads | `src/app.ts`, `src/routes/` |
| `apps/daemon` | Node daemon plus the Swift menu bar app, packaged as Landed for Mac | `src/cli.ts`, `src/agents.ts`, `macos/LandedMenuBar.swift` |
| `apps/extension` | MV3 extension for Chrome, Edge, Brave and Safari. Autofill and portal status detection | `manifest.json`, `background.js`, `content.js`, `lib/fill/` |
| `packages/schema` | Shapes and validators used by web, server and daemon | `src/index.ts` |
| `packages/observation-processor` | Matching, dedupe and auto-apply rules (pure functions) | `src/index.ts`, [observation-processor.md](observation-processor.md) |
| `packages/supply` | The supply track: public job source parsers, hard filters, fit score, priority (pure functions) | `src/index.ts`, [leads-model.md](leads-model.md) |
| `packages/ai-roundtrip` | Prompt and parse helpers for the paste-to-ChatGPT fallback | `src/index.ts` |

## Where data lives

| Data | Sync off | Sync on |
|---|---|---|
| Applications, leads, suggestions, resumes, answers, files, chats, searches | IndexedDB `landed-<userId>` | Postgres, through `cloud.ts` |
| Account, preferences, automation schedule | Postgres `users` row | same |
| Agent observations | Server holds them until the browser pulls and acks, then keeps only a hash | stored |
| Runtime tasks and their output | Server memory only, never the database | same |
| Briefing for cloud agents (`{brief, applications: [{company, role, stage}]}`) | Server, only while a cloud-agent connection exists | same |
| Extension: resumes, answers, files, pending portal events | `chrome.storage.local` | same |
| Daemon automation state | `~/.landed/automations.json` | same |

The web app reaches data only through the `DataStore` interface, which has two
implementations: `local.ts` (Dexie) and `cloud.ts` (the API). Details are in
[data-and-sync.md](data-and-sync.md).

## The main flows

### 1. Tracking: email and portals → the board

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

### 2. Supply: finding jobs → Leads

```
Agent chat → landed-brief block → user confirms → active job_searches row
   ├─► job_search task on every online computer's agents (daemon)
   ├─► cloud agents: get_tasks → submit_jobs
   └─► external agents: job_discovered observations
              ▼
lib/inbox/leads.ts → ingestFoundJobs → processor dedupes → job_leads → Leads column
```

Turning Leads into an apply queue (filters, scores, approval, and where public
postings are fetched: the browser) is in [leads-model.md](leads-model.md).

### 3. Execution: filling a form

```
Manual card / drawer "Open & autofill"  or  approved Leads queue (≤5)
  or  extension popup "Fill"  or  menu bar app
   ▼
extension background.js → fillTab: the page plus every frame that reported a form
   ▼
content scripts (lib/fill/*): rules → saved answers → files → dropdowns/radios
   ├─ unknown labels  → native host → Ollama, else Claude Code (labels and key names only)
   ├─ unanswered choices → native host → Ollama only (prompts carry the user's answers)
   └─ review → native host → the user's own agent checks the filled form
      (sensitive questions left out; picks a fact or an option, never writes text)
   ▼
manual fill: fields outlined green/yellow → the user submits
approved queue: all checks pass → one unambiguous final submit is clicked
   ├─ still empty → Extension page asks once → every form after answers by rule
   ▼
"thanks for applying" page → portal event → lib/inbox/confirmations.ts → Applied
```

Details are in [apply-assist.md](apply-assist.md).

### 4. Resumes

```
uploads (source) ─resume_parse─► master (merged, every phrasing kept) ─resume_tailor─► versions
                                                       │
                       the extension fills with the version picked for the job
```

Details are in [pipeline.md](pipeline.md).

## Trust boundaries

| Part | Never does |
|---|---|
| Server | Store data for a sync-off account (except the briefing); write runtime tasks to the database; forward free-form commands to a daemon |
| Agents | Edit the pipeline directly; use write tools on the mailbox; click, type or run scripts in Chrome during portal checks |
| Daemon | Pair without the native confirm dialog; run an agent with the user's own settings, hooks or MCP servers (except the mail or Chrome tools a task needs); install an update not signed with its release key |
| Extension | Click Submit; bypass a CAPTCHA; tick a consent box unless the user turned that on; send answer values anywhere but the user's own agent; send sensitive answers to any model |

## Common changes, and every place they touch

| Change | Touch |
|---|---|
| New data table or column | Dexie `this.version(n)` in `local.ts`, a migration `apps/server/migrations/NNNN_*.sql`, the server route (behind `requireCloud`), `DataStore` in `types.ts` + `local.ts` + `cloud.ts`, `SNAPSHOT_TABLES` (web) and `COLUMNS` in `routes/sync.ts`, deletion in `/api/cloud/disable` |
| New agent task kind | Input validation in `routes/runtime.ts`, a runner in `apps/daemon/src/agents.ts` (and `specFor` for Codex/ACP), the agent's `kinds` |
| New observation type or field | Validators in `routes/agent.ts`, `AGENT_PROTOCOL.md`, the prompt in `apps/web/src/lib/agent-prompt.ts` |
| New autofill rule | The `lib/fill/*.js` module for that kind of field, or `lib/choice-answers.js` for a question; an integration test in `apps/extension/tests/` |
| New extension fill module | A file in `lib/fill/` that registers on `window.LandedFill`, listed in `manifest.json` `content_scripts` before `content.js` |
| New page | A route in `App.tsx`, a nav item in `components/shell.tsx` |

## Tests and CI

`pnpm typecheck && pnpm lint && pnpm test` runs everything, the same as CI
(`.github/workflows/ci.yml`: Ubuntu, Node 24, Postgres 17).

| Where | Runner | Notes |
|---|---|---|
| `apps/web` | Vitest | Store, inbox flows, matching helpers |
| `apps/server` | node:test | Needs `TEST_DATABASE_URL`; the suite wipes and re-creates that database |
| `apps/daemon` | node:test | Some tests are macOS-only and skip on Linux |
| `apps/extension` | Jest + jsdom | Whole-page fill tests load the content scripts in manifest order (`tests/helpers/content-scripts.js`) |
| `packages/observation-processor`, `packages/ai-roundtrip`, `packages/supply` | Vitest | `packages/supply` also tests `@landed/schema/lead-queue` |

## Releases

`deploy/mac-mini/deploy.sh` runs from a clean checkout. It pushes the server
and web app to the Mac mini and restarts them, then builds, signs and uploads
Landed for Mac. Installed copies update themselves (see
[apply-assist.md](apply-assist.md#landed-for-mac-updates-itself)).
