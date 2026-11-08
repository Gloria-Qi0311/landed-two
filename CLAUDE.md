# CLAUDE.md

The rules every change in this repo follows, for people and for Claude Code.
Each rule is short. The reasons and details are in the doc for that area: read
it before you change that area.

| Area | Doc |
|---|---|
| Landed two's product direction: who it is for, what it does, the target architecture, the roadmap. Where it differs from the docs below, it is the goal the code moves to | [docs/product.md](docs/product.md) |
| What Landed is, the pipeline every job goes through, the principles, what each agent call sees, how the parts fit, every place a common change touches | [docs/architecture.md](docs/architecture.md) |
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
- The job lists and the company boards each run on their own schedule, counted
  from their last check of the active search (`job_searches.source_runs`).
- A public list's postings go through `ingestFoundJobs` with one stable
  observation id per posting, so refreshing never adds a source twice.
- A listing site's own page (jobright.ai) is never the application: a posting
  takes its company's board link only for the very same title, else auto apply
  skips it and says so.
- Every searching agent (the daemon's `job_search`, cloud agents' `get_tasks`)
  gets the one playbook in `packages/schema/src/agent-sourcing.ts`: report only
  postings whose own page it opened, the company's or job board's link, never a
  social post; never sign in, pass a CAPTCHA or scrape LinkedIn / Indeed.
- Which companies an account follows (for their job boards) is worked out in the
  browser and never sent to the server.
- A spreadsheet import adds nothing until the user confirms the preview, never
  merges, only moves a stage forward, and never reads a password column. "Not
  applied yet" in any wording ("待申请", "Not yet applied") is a lead, and an
  unreadable status is Applied only when the row has a date. Statuses the rules
  can't read (only those words) go to the user's own agent (`classify_statuses`);
  the preview lists every status with its stage and who read it. The one move back:
  Applied with no applied date to Leads, when the sheet plainly says not applied.
- Hard filters only act on what a posting says outright; not sure means not
  filtered. Filtered leads are hidden, never deleted, and one the user puts back
  stays back.

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
  the task needs the mailbox. Email checks get read tools only. Widening an
  allowlist is a product and security decision. No agent drives the user's
  Chrome: candidate-portal checks were removed (#4); status comes from email.
- Email tasks that never called their tool end in an error, not an empty
  success.
- A page waiting for Gmail asks the computer to look again when the user
  comes back to it; never make them wait for the half-hourly check.
- Cached connector capabilities never override an explicit agent sign-out;
  auth failures name the exact recovery action, and periodic detection must
  restore capabilities after the user signs back in.
- Never pair a computer without the native confirm dialog (`apps/daemon/src/mac.ts`).
- The chat agent is told what Landed knows about the user (resume gist, the answers
  that shape a search, the search), never contact details, address, date of birth or
  EEO answers.
- Agents propose; the user acts. Reported applications, answers read from a form
  and duplicate application merges happen only when the user clicks.
- Duplicate leads the rules can't call go to the user's own agent (`same_job`)
  only when Remove duplicates is set to it: it sees the two postings' public
  details, never the user's. "Same" hides one lead under the other (never
  deleted; Split undoes it). Unsure or different keeps both, and a pair is asked
  once.
- Ranking by the user's own agent (`rank_leads`) gets what the chat agent is told
  and the postings, nothing more. The rules' score always stays. The agent's score
  needs its reasons and counts 60% only while Rank is set to it and its search is
  active. A new lead waits for it 5 minutes at most.
- Resume tailoring never invents facts.
- A resume uploads without a computer: the browser reads only name, email, phone
  and links, keeps the file, and the agent reads the rest once one is connected
  (`resumes.file_path` marks it waiting).

## An approved lead may be submitted automatically

- Approve on one Lead is explicit authorization to apply to and submit that one
  job. A discovered lead, a manually saved application, opening a posting or a
  previous approval never authorizes another submission.
- For an approved lead, the extension may click one unambiguous final Submit
  control only after every required field is answered and the agent fill review
  ran with no unresolved issue. Manual Open & autofill, the extension popup and
  the menu bar never submit.
- Never bypass a CAPTCHA or store site passwords. Login, account creation,
  missing answers/files, review flags and sensitive or legal confirmations not
  covered by the user's saved choices stop that application and tell the user;
  they do not stop other approved applications.
- Never guess: no saved answer → yellow; EEO left blank → "I don't wish to
  answer"; consent boxes only when the user's own `agree_to_terms` switch is on (an
  agent never sets it).
- Application answers the resume and the active search state outright (name, links,
  city, start date, preferred places, sponsorship) are filled in on their own: blanks
  only, each question once (`prefilled`), marked on the Extension page with Undo;
  never date of birth, street address, work authorization, EEO or consent.
- "Worked here before?" is answered from the resume's employers, never from one
  saved yes/no for every company.
- Work authorization and sponsorship answers are about the US. A question naming
  another country (not the US) is its own question, asked once; neither the rules,
  the model nor the review answer it from them.
- A Work Experience or Education entry takes that job's or school's own values,
  every job and internship one entry; page-wide rules and the model never fill them.
- Models see field labels and key names, never values: `match_fields` (Ollama, else
  Claude Code with no tools), and the host supplies the value. `choose_options`
  carries the user's answers, so it is local Ollama only. Page text is untrusted
  prompt input.
- The review after a fill (`review_fill`) sends filled values beyond the local
  model: to the user's own agent only (their Claude Code with no
  tools, else Ollama), never sensitive questions or facts (voluntary EEO, date of
  birth, ID numbers, salary, consent). The reviewer picks a fact key or an option,
  never writes text, and values from the user's saved answers or the page are only
  flagged, never replaced.
- A fill reports the empty questions worth asking (never sensitive ones, files,
  open-ended text or resume fields); the Extension page asks each once, and the
  answer fills every form after that, on pages still open only fields still empty.
  Questions only the user's answers can answer never take a resume value.
- Open-ended questions ("Why us?") on an approved application don't stop it: the
  user's own agent writes them (`draft_answers`) from the posting, the picked
  resume's experience (never contact details) and the user's edited answers, and
  only answers its second check passes go in, never invented. No agent or none
  passed: the field stays empty and the application stops saying so. They're kept
  on the application (`open_answers`); edited ones are the agent's examples.
- A correction the user makes on a form Landed filled is remembered as the answer
  on its own (`learnAnswers`), listed on the Extension page with Undo: only facts
  for every application (`LEARNABLE`: location, start date, links, general
  yes/nos), never date of birth, street address, EEO, consent, "worked here
  before?" or open-ended text, never a question about one place or amount
  ("relocate to Austin, TX?", "75% travel": `namesPlaceOrAmount`), and never
  from Landed's own events.
- Landed picks the resume for each job (its direction against the job), and the
  file uploaded is always that resume's own (`resume_files`), never another
  one's; one with no file isn't swapped for another's. Between close resumes
  (`pick_resume`) the user's own agent reads the posting and names one of them:
  it sees what each is for, its job titles and skills, never the person's name
  or contact details; no answer keeps Landed's pick.
- Workday questionnaire dropdowns take their real nearby / `aria-labelledby`
  question (up to 300 characters), never the `Select One Required` prompt.
  That prompt is empty, so an unknown question enters the Extension page queue;
  global Settings and language controls are not application fields.
- Approved applications run automatically in queue priority order. Workflow's
  Auto apply stage is the single management surface: on/off (on by default),
  one-to-five simultaneous applications, Run now and current queue/blocker
  status. Turning it off prevents new starts but never revokes a job already
  opened. The linked saved lead is the authorization proof. Execution skips a
  company already at OA, interview, offer or recruiter contact; every blocker
  and a successful submit are recorded on the application.
- Every fill keeps a trace under a short ref (phases, model calls, each field's
  source or why it was left), never a sensitive question's value. The extension
  keeps the last 20; Cloud accounts' go to the server for 30 days (not Dexie or the
  snapshot), and only the owner's paired computer reads one by ref.
- A tailored version's one-page PDF is derived: made in the browser from its
  `parsed_json`, never stored, never shrunk below 9.5 pt to fit.
- Green means the value is there: every filled field is checked again after the
  page's scripts ran (`lib/fill/settle.js`), pick-from-list boxes are recognized
  by what they do, and optional blanks aren't yellow. Run `live-check` before
  releasing fill changes.
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
- Approving leads (one or many) is `addLeadToPipeline(lead, 'saved')`: no
  "approved" state, and it can be undone.
- The Applications page holds the board, Leads and "Needs your input". The Agent
  page holds chat (one agent), agent questions and setup. Workflow (`/workflow`)
  is laid out like My Resume: the steps in the middle column, grouped What to look
  for → 1 Find jobs (agent search, job lists, company boards, remove duplicates,
  rank) → 2 Apply (after the user approves in Leads: auto apply, mark as applied) →
  3 Keep up to date (email), each with its status; the selected step on
  the right says who does it (Landed AI, the built-in logic, by default; an agent where one can),
  when, and holds its switch. A step gets a new executor or setting in its own field
  of `users.automations`. Extension content is managed on `/extension`.
- Searching for jobs is configured in one place, Workflow's Find new jobs:
  criteria, schedule, and its sources: each agent on the computer and each cloud
  agent ticked on its own (all unticked means none, never a fallback), the job
  lists and the company boards.
  The chat's brief card saves to it and searches now with the same agents; the
  agent only suggests.
- Check email is read by the ticked agents the same way: the computer's agent that
  can (Claude Code with its mail connector) and each cloud agent on its own; none
  ticked means none.

## UI

- White cards with `var(--shadow-sm)`, no boxes inside boxes. Tokens in
  `styles/globals.css`; small shared styles in `components/ui.ts`; switches with
  `className="switch"`; buttons `btn-primary` / `btn-secondary` / `btn-ghost`.
