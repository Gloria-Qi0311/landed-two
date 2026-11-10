# Leads become the apply queue

**Status: decided** (the first supply-track PR, migration 0021 and Dexie v13). It
defines the fields both tracks build on, and nothing else. The open question at
the end is settled under "Where public postings are fetched".

## Today

The Leads column shows two kinds of records:

| Record | Table | How it gets there |
|---|---|---|
| A job found by an agent or a search | `job_leads`, status `new` | `ingestFoundJobs` (`lib/inbox/leads.ts`), deduped by the processor |
| A job the user wants to apply to | `applications`, stage `saved` | Added by hand, or a lead moved into the pipeline (`addLeadToPipeline`, which sets the lead to `saved` and links `application_id`) |

The Leads column sorts both by deadline. Leads carry no source date, no
"still open", no filter result and no score.

## Proposal: keep the two records, give each one job

```
 supply track writes                       the user approves             automatic execution
┌──────────────────────────┐   approve    ┌──────────────────────────┐   approved queue
│ Candidates               │ ───────────► │ Authorized queue         │ ─────────────────────►
│ job_leads, status 'new'  │ (one or many)│ applications, 'saved'    │  open → fill → review
│ + posted_at, closed_at,  │ addLeadTo-   │ linked lead carries the  │  → submit → confirm
│   screen, fit            │ Pipeline     │ per-job authorization    │  → Applied
└──────────────────────────┘              └──────────────────────────┘
```

1. **Candidates** are `job_leads` with status `new`. The supply track adds what it
   knows to each one.
2. **Approving** a candidate is the existing `addLeadToPipeline(lead, 'saved')`.
   Batch approval calls it for each selected lead. There's no new "approved" state:
   the linked lead plus stage `saved` is the per-job submission authorization.
   A manually added `saved` application is not authorized for auto-submit.
3. **The queue** is applications in stage `saved`, in priority order. A saved
   application created from a lead reads its score from that lead (the one whose
   `application_id` points to it). One added by hand has no score and sorts by
   deadline.
4. **Execution** automatically takes approved items, opens the posting, fills it,
   runs the agent review and submits only when no required field or review issue
   remains. The confirmation page moves it to Applied. Human-only blockers stop
   only that application.

This reuses the model that exists, and nothing changes for users until the new
fields have values.

## New fields on `job_leads`

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `posted_at` | `string \| null` (ISO date) | supply | When the source says the job was posted |
| `closed_at` | `string \| null` (ISO time) | supply | When the posting disappeared from its source; closed leads leave the column |
| `screen` | `{ pass: boolean, reasons: string[] } \| null` | supply | Hard filters: graduation date, sponsorship (only when the posting says it doesn't sponsor), citizenship or clearance |
| `fit` | `{ score: number, reasons: string[] } \| null` | supply | Match against the master resume, score 0–1 |

Every write path validates them the same way with `readLeadQueueFields`
(`packages/schema/src/lead-queue.ts`): the local store, the server's lead routes,
and snapshot upload or restore (where an unreadable value becomes null, so older
backups read as-is). `reasons` are short sentences for people, at most 10 of 300
characters. The observation processor creates leads with all four null and keeps
whatever is there when it merges.

Priority is computed when shown and isn't stored: `fit.score` combined with how
close the deadline is (or, without a deadline, how new the posting is). The first
version is `priority(lead, now)` in `packages/supply`: fit × (0.5 + 0.5 × urgency),
unscored leads count as 0.5, and closed, screened-out and past-deadline leads are
`UNRANKED` (below everything). #93 tunes it.

The PR touches every place a new column needs (see
[architecture.md](architecture.md#common-changes-and-every-place-they-touch)):
`JobLead` in `packages/observation-processor/src/types.ts`, Dexie version 13 in
`local.ts`, migration `0021_lead_queue.sql`, the job-leads route, `COLUMNS` in
`routes/sync.ts`, and the snapshot types. Claim 0021 and v13 in the PR title.

## Where the code goes

- **A new package, `packages/supply`** (pure functions with tests): parsers for
  public job sources (the SimplifyJobs list; the Greenhouse, Lever and Ashby
  public job board APIs), the hard filters, the fit score and the priority.
  Keeping it in its own package means the two tracks rarely edit the same files.
- **Screening and scoring use the user's resume and answers, so they run in the
  browser** (or on the user's computer). They never run on the server: that
  would put a sync-off account's resume there.
- **Fetching public postings** isn't user data, so a shared server-side cache was
  allowed. But which companies one account asks for says what that person is
  interested in. Decided below.

## Where public postings are fetched: the browser

The browser fetches public postings itself, straight from each source; requests
never go through the Landed server.

- All four sources allow it. Checked 2026-10-18 with an `Origin` header: the
  Greenhouse job board API, the Lever postings API, the Ashby posting API and
  `raw.githubusercontent.com` (the SimplifyJobs lists) all answer with
  `Access-Control-Allow-Origin: *`, and the web app sets no CSP that would block it.
- The server never learns which companies an account follows, so the
  local-first rule holds without a cache keyed carefully by board.
- It works for every account, with or without a paired computer.
- The cost: it only refreshes while Landed is open.
  The parsers in `packages/supply` are pure, so the daemon can run the same fetch
  on the Workflow schedule later (Landed closed). That is a follow-up, not part
  of this decision. A server-side cache stays out unless a source stops allowing
  browser requests.

## Sources

### SimplifyJobs lists (#90)

The New Grad and Internships repos publish every listing as JSON
(`.github/scripts/listings.json`, the file their README tables are generated
from): id, company, title, link, locations, posting date, whether it's still
open, sponsorship, degrees. That's read instead of the README tables: no HTML to
parse, real posting dates, and closed postings are marked. About 2 MB gzipped
per list; the browser's HTTP cache revalidates it (ETag), so an unchanged list
costs a 304.

- **Which list**: from the brief's level and roles (`listsForBrief`): internships,
  new grad, both when it doesn't say, none for senior roles.
- **Coarse filter** (`selectForBrief`, `packages/supply/src/simplify.ts`): open,
  posted in the last 30 days, every meaningful word of one of the brief's roles
  in the title ("engineer" finds "engineering", level words aside), one of the
  brief's places (NYC, SF, Bay Area and LA understood; remote postings when the
  brief wants remote), not an excluded company. Newest first, at most 60 per list
  per refresh. Hard filters (sponsorship, graduation date) are #92's, not here;
  the list's sponsorship label goes into the lead's description for them.
- **Ingest**: through `ingestFoundJobs` like an agent's finds, with one stable
  observation id per listing (`simplify:<list>:<id>`), so a refresh never adds the
  same source twice and a posting an agent also found is one lead with both
  sources (`found by claude, SimplifyJobs New Grad`).
- **After each refresh** every lead a fetched list made gets its `posted_at`, and
  `closed_at` once the list marks the posting closed or drops it. A list that
  couldn't be fetched closes nothing. Leads are only closed, never reopened.
  Closed leads leave the Leads column; the data stays.
- **When** (#145): part of Find new jobs. The job lists and the company boards
  below each have their own schedule (`sources.schedules` in
  `users.automations.job_search`; every 3, 6 or 12 hours, or at a time of day,
  default every day at 9:00), changed on Workflow → Job lists / Company boards.
  While Landed is open and that automation is on, the app looks every minute at
  which source is due (`dueSources`, `hooks/supply.ts`). A source counts from its
  last check **of the active search** (`job_searches.source_runs`, migration
  0026, Dexie v16: when, what fit, how many were new, already there or closed,
  how many lists or boards it read and couldn't), so a new search is checked
  right away: 30 seconds after the search last changed (each criteria edit is a
  new search; checking after the first would pull every posting for the roles
  alone). A check that reached none of its lists or boards isn't kept, so it's
  tried again after 15 minutes. Workflow shows each source's next check and
  "last checked …: N new in Leads". The Leads column's refresh button and Run now
  check both now.

### jobright lists by direction (#138)

jobright.ai keeps a GitHub repo per direction and level, updated daily
(`packages/supply/src/jobright.ts`, `apps/web/src/lib/jobright.ts`). They carry
the product, data and business roles the SimplifyJobs lists barely do: on
2026-10-22, 298 of 310 data-analysis new-grad rows, 130 of 133 product-management
ones and all 81 business-analyst ones weren't on SimplifyJobs. The research
behind it is on #138.

- **Which lists**: product management, data analysis and business analysis,
  new grad and internship (`JOBRIGHT_DIRECTIONS`), the ones the search's roles
  name (product → product; data, analytics, BI or a product analyst → data;
  business analyst, strategy or operations analyst → business), at the levels
  `listsForBrief` gives. Software roles are the SimplifyJobs lists' job.
- **Reading**: only a README table (company, title, a jobright.ai link, location,
  work model, "Oct 22" without a year: the latest such day not after tomorrow).
  A "↳" row is the company above's. One observation id per jobright job
  (`jobright:<24 hex>`), whichever list it's on. Fetched by the browser like the
  SimplifyJobs lists (raw GitHub allows any origin), under the same Job lists
  switch.
- **What's kept**: posted in the last 30 days, not an excluded company, a word
  of one of the search's roles in the title (`touchesRole`: "Clinical Data
  Coordinator" for "Data Analyst", not "Research Fellow"; looser than
  `roleMatches`, since the list already is the direction and the level), not a
  senior title for an internship or new-grad search, in one of the search's
  places; newest first, at most 60 per list.
- **The application link**: jobright gives its own page, never the application,
  and its pages don't show the original link without signing in. A new row
  whose company's Greenhouse, Lever or Ashby board (found by name with
  `resolveBoards`, at most 25 companies a refresh) has a posting with **the very
  same title** takes that posting: link, places, dates, description. A
  name-guessed board can be another company's (Capital One once found Lever's
  `capital`), and one with the exact title is not. The rest keep the jobright
  link; auto apply skips them ("has only a jobright.ai listing",
  `isListingPage`). In the sample on #138, 5 of 30 rows found their posting: most
  of these companies use Workday, which the browser can't read (#141).
- **Closed**: a row gone from the README hasn't closed, because the table keeps
  only a few days. A lead on its company's posting closes when the board no
  longer lists it. One on the jobright link closes 30 days after it was posted
  (else first seen), as jobright's own pages say (`validThrough`).

### Company job boards (#91)

Greenhouse, Lever and Ashby publish each company's open postings without a
login (`packages/supply/src/ats.ts`, `apps/web/src/lib/boards.ts`):

| ATS | List | What it gives |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{board}/jobs` | company, first-published date, apply-by date; the description per job (`…/jobs/{id}`), fetched only for postings kept, since the list with content is MBs |
| Lever | `api.lever.co/v0/postings/{company}?mode=json` | created time (ms), every location, plain-text description and lists |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{org}` | published time, main and secondary places, remote flag, plain-text description; unlisted postings (`isListed: false`) are open but never new leads |

- **Which companies** (`followedBoards`, at most 25): the "Look at first"
  companies of the active search (a name's board is found by trying its slugs,
  `scaleai`, `scale-ai`, `scale`, on each ATS, once per session), then companies
  applied to, then leads the user approved (status `saved`). Leads that are only
  candidates don't count: following every candidate's company would pull their
  whole boards into the candidates. "Skip" removes a company; the Find new jobs
  card lists them, and × moves one to Skip. The list is worked out in the browser
  and never sent anywhere.
- **What fits**: listed, the brief's roles and places (as for the lists), and its
  level (`levelMatches`: an internship search wants intern / co-op titles, a
  new-grad search skips senior, staff, lead and manager titles; a board has every
  level, the lists only one). No age limit. Newest first, at most 15 per board.
- **Ingest**: `ingestFoundJobs` with `ats:<ats>:<board>:<id>` per posting and the
  posting's full text as the lead's description (for the hard filters).
- **Closed**: after a board is fetched, a lead whose posting was on that board
  and isn't any more gets `closed_at`, including a lead an agent found there (its
  link names the board and the ATS key the posting). On Lever only a posting we
  saw listed can close: its list has published postings only, and one shared by
  link alone never appears there. A board that fails closes nothing. The Find new
  jobs card shows each followed board's page on hover, so a wrong guess (another
  company with the same name) is easy to spot.

## Hard filters (#92)

`screenPosting` (`packages/supply/src/screen.ts`) reads what the posting says
(title, location, description: the full text for board postings, the
SimplifyJobs sponsorship label for list ones) against the master resume (else
the current resume) and the saved answers, and writes `screen`. It runs in the
browser (`apps/web/src/lib/screen.ts`): after each check of the sources, and
whenever the leads, resumes or answers change. Only candidates (status `new`,
open) are screened, and only what changed is written.

| Rule | Filters when | Never when |
|---|---|---|
| Graduation | The posting names a graduation window (between X and Y, in / by Y, Y or later, class of Y, Y届, …) and the resume's latest end date is outside it | The resume has no readable end date ("Present") |
| Sponsorship | The posting says it won't sponsor (unable to sponsor, without sponsorship now or in the future, no visa sponsorship, 不提供签证担保, the "Does Not Offer Sponsorship" label…) and `needs_sponsorship` is yes | It says it sponsors; it only asks the question; "not sponsoring" isn't about visas or applicants in that sentence |
| Citizenship / clearance | A sentence or bullet requires US citizenship, a US person, or a security clearance (held or eligible for: both need citizenship), and `needs_sponsorship` is yes | That sentence calls it a plus (preferred, beneficial, nice to have) or says it isn't needed (no clearance required, does not require, 不需要); it's another country's clearance (UK, DV, Lithuanian…); the person needs no sponsorship: the answers have no citizenship field, so whether they're a citizen isn't known |

The sponsorship and citizenship rules rest on *US* sponsorship, so a job plainly
outside the US (its place names another country and not the US) skips them.

Not sure means not filtered: a missed filter costs a glance, a wrong one hides
a real chance. A rule whose input is missing is skipped; with neither input,
`screen` stays null. Each failure is one sentence for people ("Says it doesn't
sponsor visas; you need sponsorship"). Screened-out leads are hidden from the
Leads column, never deleted; "Filtered out · N" under the column shows them with
their reasons, and **Put back** sets `screen` to pass with the reason "You put
this back", which screening then leaves alone.

## Fit and order (#93)

`scoreFit` (`packages/supply/src/fit.ts`) writes `fit: {score, reasons}` for each
candidate against the active search and the resume (master, else current), in
the browser with the hard filters (`apps/web/src/lib/fit.ts`). Deterministic;
scoring with the user's own agent is a later step.

| Part | Weight | Scores |
|---|---|---|
| Title | 0.35 | A role named outright: 0.75, up to 1 the closer the rest of the title is ("Software Engineer" over "Software Engineer, Fraud & Identity"; level words like "New Grad", "1" don't count against it). Otherwise its similarity to the closest role |
| Skills | 0.3 | The resume's skills the description mentions, 6 is full marks. Whole names only: "go-to-market" isn't Go, "C-level" isn't C, SWIFT isn't Swift, "go deep" isn't Go (English-word skills count only capitalized) |
| Level | 0.15 | Only for a title that is the role and a search that names a level: 0 for a senior title in an internship or new-grad search |
| Place | 0.1 | One of the search's places; the reason names the place that matched |
| Experience | 0.1 | The fewest years the description asks for ("5+ years of …", "four (4) years", "7 or more years", "experience (3+ years)", "3年以上") against full-time years on the resume |

A part without input is left out and the rest are weighed alone. Two or three
reasons, the telling ones first. Leads come through a role and place filter, so
those two can't tell them apart; title closeness, level and (with a resume)
skills and experience do. So a title or place that matches comes last among
the reasons, and the card's one reason is a skills match, a gap or a mismatch
(#94: "Title matches" first on every card said nothing). Both rules were checked against 1,208 real postings
(Stripe, Palantir, Ramp): the years pattern first read 495 and missed 379, and
now reads 868 with 22 left unread.

The Leads column sorts by `priority` (highest first, ties by the sooner
deadline), still grouped by company. A saved application ranks by the lead it
came from (`application_id`), else by its deadline as an unscored lead. The
urgency of a lead with a deadline is never below that of a lead with no date
(0.2), so a far deadline doesn't rank under no deadline at all (review of #102).

The SimplifyJobs lists also drop a senior title in an internship or new-grad
search (`tooSenior`): the lists carry the odd one ("Principal Software Engineer"
in New Grad).

## The Leads column (#94)

`components/kanban.tsx` and `components/leads.tsx`:

- **Each lead card** shows its fit ("86% fit", green from 80%) and its first
  reason, and the footer says who found it and when it was posted. "Details"
  unfolds every reason, the hard filters' result (nothing rules you out, you put
  this back, not checked yet), each source with when it was seen, and the posting
  date.
- **Approve N.** Each lead card has a checkbox; with one or more ticked, the
  header shows "Approve N", "Select all" and "Clear" (Escape clears too).
  Approving calls `approveLeads` (`lib/inbox/leads.ts`): `addLeadToPipeline(lead,
  'saved')` for each, one after another, so two leads at a new company make one
  company. No new state. "Undo" in the note that follows calls `undoApprovals`:
  each application still in `saved` is deleted and its lead is `new` again; one
  the user has moved on (applied, say) is left alone.
- **Order** is `priority`, grouped by company (as #93).
- **Folded under the column**: "Filtered out · N" (with reasons and Put back) and
  "Closed · N" (postings gone from their list or board, newest first, with
  Dismiss and a link to the posting). Closed leads are kept, never deleted.
- **Keyboard**: checkboxes, Details, the posting link, Dismiss and the apply-by
  chip keep Space / Enter to themselves, so they don't pick the card up to drag
  it (dnd-kit's keyboard drag listens on the whole card).
- Two postings on job boards with different ids are never "Possible duplicate"
  (`lib/duplicates.ts`), however alike their titles: approving "Software
  Engineer, New Grad" and "Software Engineer, Platform (New Grad)" at one company
  badged both before.

## Remove duplicates with your agent (#146)

The rules come first (`sameJob` as a posting arrives; see
[observation-processor.md](observation-processor.md)). When Workflow → Remove
duplicates is set to "Landed rules, then your agent" (`users.automations.job_search.dedupe_by`,
`'landed'` by default), the pairs the rules can't call go to the user's own agent:

- **Which pairs**: `uncertainPairs` in the processor. Two open leads at one
  company, titles close (≥ 0.5) but not the same, or the same title in places the
  rules can't line up. Two job-board postings with different ids stay different.
  A pair already compared isn't asked again.
- **The batch** (`lib/dedupe.ts`, `hooks/dedupe.ts`): on each change to the
  leads, at most 10 pairs and about 6,000 tokens of postings, through the
  extension (bridge `same-job`) and Landed for Mac (native `same_job`: the
  user's Claude Code with no tools, else Ollama). It sends only each posting's
  company, title, place, link and the first 1,500 characters of its description.
  Nothing about the user goes out. With no extension or no answer, nothing
  changes, and Landed tries again after 15 minutes.
- **Answers**:
  - **same**: the lead with less to go on (no job-board posting, else no link,
    else the later one) gets `dedupe.same_as` and leaves the column. It is never
    deleted. The kept card says "Claude Code: same job as …", with the reason on
    hover, and **Split**, which clears `same_as`.
  - **different / unsure** (or no answer for a pair): both stay. One extra lead
    beats a real job hidden.

  Either way both leads note the other in `dedupe.checked`, so the pair is never
  asked again, Split included.
- **Logged**: each batch is an `ai_runs` row (task `same_job`, migration 0027):
  the pairs, the answers, how many were the same, and the tokens. Workflow shows
  the last batch.
- `dedupe` is a lead queue field (`readLeadQueueFields`, migration 0027, Dexie v17).

## Rank with your agent (#147)

The rules' fit score (`scoreFit`, above) is always computed. When Workflow → Rank
is set to "Landed rules and your agent" (`users.automations.job_search.rank_by`,
`'landed'` by default), new leads also go to the user's own agent:

- **What it gets** (`lib/rank.ts`, `hooks/rank.ts`): what Landed tells the
  user's agent about them (`agentContext` in `lib/agent-context.ts`: the resume gist, the answers that shape a search, the
  search; never contact details, address, date of birth or EEO answers). With it
  go the batch's postings: title, company, place and the first 2,500 characters of
  the description. It goes through the extension (bridge `rank-leads`) and Landed
  for Mac (native `rank_leads`: the user's Claude Code with no tools, else Ollama).
- **Which leads**: new, open, not filtered out, not hidden as a duplicate, and not
  yet scored for the active search. Newest first, at most 8 and about 4,000 tokens
  of postings a batch.
- **What comes back**: a 0–1 score with 1–3 reasons per lead, kept as
  `rank = {score, reasons, by, at, search_id}` (a lead queue field, migration
  0028, Dexie v18). A score without reasons is dropped. A lead the agent gave no
  score keeps the rules' and isn't asked again in that session.
- **How they combine** (`rankedFit` in packages/supply): while Rank is on the
  agent and the score was made for the active search, the fit the queue orders by
  is `0.4 × rules + 0.6 × agent`. Priority is then fit × urgency, as above.
  Otherwise the order uses the rules' fit alone, so turning the agent off or
  changing the search puts the rules' order back. A new search ranks again, newest
  first. The card shows the combined %, the agent's first reason, and under
  Details the agent's reasons and the rules'. The apply queue orders the same way.
- **New jobs wait for their score**: with the agent on and reachable, a lead first
  seen less than 5 minutes ago without a score for this search stays out of the
  column. The column says "Ranking N new jobs with your agent…". After 5 minutes,
  or if the agent can't be asked, it shows with the rules' score. Nothing is
  blocked.
- **Logged**: each batch is an `ai_runs` row (task `rank_leads`) with the
  postings, the scores and the tokens. Workflow shows the last batch.

## Approved-lead execution (#99)

Approve starts linked `saved` applications automatically in the same `priority`
order as the column. Workflow's Auto apply stage manages on/off, 1–5 simultaneous applications,
Run now and queue/blocker status. The extension opens, fills,
reviews and clicks one unambiguous final submit control when every check passes.
A company already at OA, interview, offer or active recruiter contact is skipped
and the reason is shown. Login, required account, CAPTCHA, missing answers/files,
review flags or an ambiguous final control write a human-readable `Blocked · …`
into `next_step`; each affects only that tab. A successful click writes
`Submitted · waiting for confirmation`, and the portal confirmation moves it to
Applied. The header keeps a retry control but no second approval is required.

This deliberately uses `next_step` instead of adding execution state: it is the
next action the user sees on the card and in the drawer, survives local/cloud
sync and backups, and can be edited by the user. The extension result queue
contains no application answers.

## Applications imported from a spreadsheet

A spreadsheet import ([pipeline.md](pipeline.md#importing-a-spreadsheet)) marks
the leads it already covers as `already_applied` (linked to the application),
with the processor's `applicationForPosting`: the same posting or link, or the
same employer and the same or a nearly identical title. A search after that
doesn't list them again, by the same rule.

## Left for later PRs

- Optional user-configurable daily limits. They must not weaken the per-job
  Approve authorization boundary.
