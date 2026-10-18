# Proposal: Leads become the apply queue

**Status: open.** This is the first PR of the supply track. It defines the fields
both tracks build on, and nothing else. The supply track writes it, the execution
track reviews it, and the owner merges it.

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

Priority is computed when shown and isn't stored: `fit.score` combined with how
close the deadline is (or, without a deadline, how new the posting is).

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
- **Fetching public postings** isn't user data, so a shared server-side cache is
  allowed. But which companies one account asks for says what that person is
  interested in. Either fetch from the browser or the daemon, or keep the cache
  keyed by job board only, with no account attached to the request. Decide this in
  the PR.

## Left for later PRs

- `apply_mode` (manual / assist / auto) and the daily limit, which only matter
  for the optional auto-submit phase. Auto-submit is not decided.
- Write-back from execution ("blocked: needs an account / a CAPTCHA"). The
  execution track adds it to `applications` when it builds "apply next batch".
- Not applying to companies where the user is already at OA, interview or
  recruiter stage. This is an execution-track rule.
