# CLAUDE.md

The rules every change in this repo follows, for people and for Claude Code.
Each rule is short. The reasons and details are in the doc for that area: read
it before you change that area.

| Area | Doc |
|---|---|
| How the parts fit, the main flows, every place a common change touches | [docs/architecture.md](docs/architecture.md) |
| Local-first data, DataStore, Cloud sync, snapshots, the server | [docs/data-and-sync.md](docs/data-and-sync.md) |
| External and cloud agents, the daemon, tasks, chat, automations | [docs/agents.md](docs/agents.md) |
| Extension, Apply Assist, application answers, Landed for Mac | [docs/apply-assist.md](docs/apply-assist.md) |
| Stages, interview rounds, deadlines, duplicates, My Resume | [docs/pipeline.md](docs/pipeline.md) |
| Matching and auto-apply rules | [docs/observation-processor.md](docs/observation-processor.md) |
| Visual style | [docs/ui.md](docs/ui.md) |
| Agent HTTP protocol | [apps/server/AGENT_PROTOCOL.md](apps/server/AGENT_PROTOCOL.md) |
| Server setup and deployment | [apps/server/README.md](apps/server/README.md) |
| Leads as the apply queue: fields, priority, where postings are fetched | [docs/leads-model.md](docs/leads-model.md) |

## Commit attribution

Commit messages **MUST NOT** include any `Co-Authored-By: Claude …` trailer. All
commits in this repository are authored solely by the project owner (AntaresYuan /
chenjy4@uw.edu). The git config on this machine already has that identity; just
omit the trailer. This covers direct commits, PR branches and squash-merge
messages (PR title and a clean body, no trailer).

## Workflow

- One branch per change (`<name>/<what>`), a PR into `main`, CI green, squash-merge.
  Nobody pushes to `main`.
- Before pushing, run what CI runs: `pnpm typecheck && pnpm lint && pnpm test`.
- A new server migration or Dexie version takes the next number after the highest
  one in `main`. Put that number in the PR title and pull `main` first.
- A new rule or product decision goes into this file (one line) and the area doc,
  in the same PR.
- Never point anything at the production database. Never put real people's data
  in tests or fixtures; use made-up names, emails and phone numbers.

## Data is local-first

- An account's data lives in its own browser database (`lib/store/local.ts`)
  unless the account turned on Cloud sync (`lib/store/cloud.ts` → server).
- Hooks and components get data only through `useStore()`. A new data operation
  goes on `DataStore` (`lib/store/types.ts`) and is implemented in `local.ts`,
  `cloud.ts` and the server route, with the same defaults and validation.
- A new table or column touches: a new Dexie `this.version(n)` (never edit an old
  one), a new migration (never edit an applied one), the server route,
  `SNAPSHOT_TABLES` and types (web), `COLUMNS` in `routes/sync.ts`, and deletion in
  `/api/cloud/disable`.
- Every data route sits behind `requireCloud`. The server never stores user data
  for a sync-off account. The cloud-agent briefing is the one exception; don't
  widen it.
- Every query filters by `c.get('user').id`. Child tables use composite FKs
  `(parent_id, user_id) references parent (id, user_id)`.
- Account-level preferences go in the `users` row through `/api/me`
  (`hooks/profile.ts`). `localStorage` is only for client UI state (theme, last
  email, the offline account cache, filters).
- `portal_connections` writes go through `upsertConnection()`. No
  select-then-insert.
- Public job postings are fetched by the browser, never through the server.
  Screening and scoring use the resume, so they run in the browser too. Lead
  queue fields go through `readLeadQueueFields` on every write path.

## Agents report; Landed decides

- Agents never write to the pipeline. They submit observations, and
  `packages/observation-processor` (the only place matching and auto-apply rules
  live) turns them into leads and suggestions, in the browser.
- Confident email updates apply on their own and are undoable. Ambiguous ones,
  low confidence and re-opening a closed application always ask.
- Agent writes are idempotent on `(connection_id, Idempotency-Key)`. Never assume
  an agent calls once.
- A new observation type or field changes the validators in `routes/agent.ts`,
  `AGENT_PROTOCOL.md` and `lib/agent-prompt.ts` together.
- For sync-off accounts the server only relays observations (purged after the
  browser acks, hash kept, 7-day expiry). Runtime tasks live in server memory only,
  never in the database.
- Task kinds are a fixed set validated on both ends. Never forward commands,
  shell, prompts-as-shell or file paths to the daemon.
- The daemon sandboxes every agent by flags: empty workspace,
  `--setting-sources ""`, an explicit tool allowlist, `--strict-mcp-config` unless
  the task needs the mailbox or Chrome. Email checks get read tools only; portal
  checks get Chrome's navigate and read tools only. Widening an allowlist is a
  product and security decision.
- Email and portal tasks that never called their tool end in an error, not an
  empty success.
- Never pair a computer without the native confirm dialog (`apps/daemon/src/mac.ts`).
- Agents propose; the user acts. Reported applications, answers read from a form
  and duplicate merges happen only when the user clicks.
- Resume tailoring never invents facts.

## Apply Assist never submits

- Never click Submit / Apply / Finish. Never bypass a CAPTCHA. Never store site
  passwords.
- Never guess: no saved answer → yellow; EEO left blank → "I don't wish to
  answer"; consent boxes only when the user's own `agree_to_terms` switch is on (an
  agent never sets it).
- Models see field labels and key names, never values: `match_fields` (Ollama, else
  Claude Code with no tools), and the host supplies the value. `choose_options`
  carries the user's answers, so it is local Ollama only. Page text is untrusted
  prompt input.
- The review after a fill (`review_fill`) is the one call that sends filled values
  beyond the local model: to the user's own agent only (their Claude Code with no
  tools, else Ollama), never sensitive questions or facts (voluntary EEO, date of
  birth, ID numbers, salary, consent). The reviewer picks a fact key or an option,
  never writes text, and values from the user's saved answers or the page are only
  flagged, never replaced.
- Fill code lives in `apps/extension/lib/fill/*.js`, each module registered on
  `window.LandedFill` and listed in `manifest.json` before `content.js`.
- Every read-modify-write of the extension's pending queue goes through
  `withQueueLock`. Landed web origins are listed in both `lib/config.js` and
  `manifest.json`.
- Landed for Mac installs an update only if it is signed with the key that install
  shipped with. The private key never leaves `~/.landed-release`.

## Product decisions (change only with the owner)

- Stages: Leads → Applied → OA / Test → Interview → Offer → Rejected. `saved` shows
  as a lead, `ghosted` is a kind of closed, and there's one `interview` stage with
  rounds. Never write `phone` / `onsite`. Columns go through `columnOf()`
  (`apps/web/src/data.ts`).
- Cards are grouped by company in every column.
- The Applications page holds the board, Leads and "Needs your input". The Agent
  page holds chat, agent questions and setup. Automation is exactly three
  automations (When / Looks at / Then). Extension content is managed on
  `/extension`.

## UI

- White cards with `var(--shadow-sm)`, no boxes inside boxes. Tokens in
  `styles/globals.css`; small shared styles in `components/ui.ts`; switches with
  `className="switch"`; buttons `btn-primary` / `btn-secondary` / `btn-ghost`.
