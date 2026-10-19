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
 supply track writes                       the user approves             execution track reads
┌──────────────────────────┐   approve    ┌──────────────────────────┐   "apply next batch"
│ Candidates               │ ───────────► │ Queue                    │ ─────────────────────►
│ job_leads, status 'new'  │ (one or many)│ applications, 'saved'    │  open → fill → user submits
│ + posted_at, closed_at,  │ addLeadTo-   │ linked lead carries the  │  → confirmation → Applied
│   screen, fit            │ Pipeline     │ score and reasons        │    (already works)
└──────────────────────────┘              └──────────────────────────┘
```

1. **Candidates** are `job_leads` with status `new`. The supply track adds what it
   knows to each one.
2. **Approving** a candidate is the existing `addLeadToPipeline(lead, 'saved')`.
   Batch approval calls it for each selected lead. There's no new "approved" state:
   stage `saved` means approved.
3. **The queue** is applications in stage `saved`, in priority order. A saved
   application created from a lead reads its score from that lead (the one whose
   `application_id` points to it). One added by hand has no score and sorts by
   deadline.
4. **Execution** opens the posting with Apply Assist (it already takes an
   application id), and the confirmation page moves it to Applied. No change is
   needed there for this PR.

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
- The cost: it only refreshes while Landed is open (like the agent relay pull).
  The parsers in `packages/supply` are pure, so the daemon can run the same fetch
  on the Automation schedule later (Landed closed). That is a follow-up, not part
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
- **When**: part of Find new jobs, together with the company boards below. While Landed is open and that automation is on,
  30 seconds after the search last changed (each criteria edit is a new search;
  checking after the first would pull every posting for the roles alone) and every
  6 hours. The Leads column's refresh button checks now.

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

## Left for later PRs

- `apply_mode` (manual / assist / auto) and the daily limit, which only matter
  for the optional auto-submit phase. Auto-submit is not decided.
- Write-back from execution ("blocked: needs an account / a CAPTCHA"). The
  execution track adds it to `applications` when it builds "apply next batch".
- Not applying to companies where the user is already at OA, interview or
  recruiter stage. This is an execution-track rule.
