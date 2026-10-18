# Pipeline and My Resume

## Pipeline: Leads → Applied → OA / Test → Interview → Offer → Rejected

Stages and interview rounds live in `packages/schema/src/pipeline.ts`, shared by
web, server and the processor's callers. Board columns and filters go through
`columnOf()` in `apps/web/src/data.ts`.

- **Grouped by company in every column** (product decision after acceptance
  review). A company's cards sit together under its name (same company by
  `companyKey`, so 蚂蚁集团 and 蚂蚁 are one group), in the column's own order:
  stage columns most recent first, Leads soonest deadline first (leads and saved
  applications together). A group sits where its first card would. A company with
  one card in a column shows a plain card.
- **`saved` is shown as a lead.** The Leads column holds both agent-found jobs
  (`job_leads`) and applications not applied to yet (stage `saved`). There is no
  Saved column. ([leads-model.md](leads-model.md) proposes one model for both.)
- **`ghosted` is a kind of closed.** It shows in the Rejected column with a tag.
- **Deadlines**: job leads and applications carry `deadline` ("YYYY-MM-DD",
  normalized by `parseDeadline`). Searches and agents fill it in, and the user can
  set it on any card. The Leads column sorts by it, soonest first.

### Interview rounds

One `interview` stage replaced phone + onsite. Each application carries
`interviews: [{round, format: onsite|remote, interviewers: [peer|teammate|leader|hr], at, note}]`.
Rounds are edited in the detail drawer (`components/interview-rounds.tsx`), and
the card shows the next upcoming round, or the latest one. An interview email
that gives a time (`interview_at`) adds a round on its own when the processor
auto-applies it (effect `set_interviews`).

Rounds are **numbered by their time, not by arrival** (`orderRounds` in
`pipeline.ts`). When every round has a time, numbers that already rise with time
are kept (2, 3, 4: round 1 just wasn't recorded), and numbers that disagree
restart from 1 in time order, since emails arrive out of order. A re-read goes
newest first, which once numbered them backwards. Rounds without a time are left
alone. Rounds are always listed by number, then time (`sortRounds`). In the
drawer, setting a time renumbers, a typed number stays, and inconsistent numbers
are put right when the application is opened. Email findings are processed
oldest first. Stored data was repaired (Dexie v9/v10; Cloud accounts via
`repairRoundOrder` in `lib/inbox/repair.ts`, once per session).

### Legacy `phone` / `onsite`

Postgres can't drop enum values, so `phone` and `onsite` stay in the type, but
every write path normalizes them to `interview` plus the round they stood for:
server routes, snapshot upload, local store, and Dexie v5 for data already in the
browser. Never write them again.

### Duplicate applications

`lib/duplicates.ts` and `components/duplicates.tsx` find groups with the
processor's matching (company key, then the same ATS/link or a ≥ 0.8 title match
with brackets kept) and ask on the Agent page, one card per group. The user picks
the one to keep (furthest stage by default) and merges it: blanks filled, notes
and interview rounds combined, earliest applied date, leads and resolved
suggestions re-pointed, the rest deleted. Or the user says "they're different",
remembered as a rejected `dup:<ids>` suggestion. **Never merged automatically.**
Asked in chat, the agent ends its reply with an empty ```` ```landed-dedupe ````
block and the page shows the same review there. The board's "Possible duplicate"
badge uses the same groups.

## My Resume: uploads → master → versions

`resumes.kind` is one of `source`, `master` or `version`
(`packages/schema/src/master-resume.ts`).

- **Uploads** (`source`) are the user's own resumes, parsed into the canonical
  `Resume` shape by their agent (`resume_parse`). The user drops files (several at
  once), and the master updates automatically when a batch is done. PDFs and
  images go to the daemon as files: it writes each into a per-task folder, allows
  `Read` of **that one path only** (`Read(//abs/path)`), requires that the file was
  actually read (otherwise the result would be invented), and deletes the folder
  afterwards. Word files become text in the browser (mammoth). The newest PDF or
  Word upload is also kept as the file the extension uploads (`keepResumeFile` in
  `lib/resume-tasks.ts`). The paste-from-ChatGPT flow (`packages/ai-roundtrip`) is
  only a fallback for when no computer is connected.
- **The master** (one per account) is merged from every upload by the user's
  agent (`resume_merge`). It is the most complete record: each experience is split
  into bullets, and each bullet keeps **every phrasing** (`variants`, with the
  uploads they came from). The user picks the preferred phrasing; a re-merge
  passes the current master back in, so those choices carry over.
- **Versions** are tailored from the master for a role (`resume_tailor`). The
  agent picks the most relevant experience and the best-fitting phrasing, and
  **never invents facts**. Each version stores its target and "why these" notes in
  `target_json`.
- `parsed_json` is always a canonical `Resume`, and for the master it's the
  flattened form. That's what extension autofill reads.
- Both tasks are text-only: no MCP, no tools, except that tailoring may WebFetch
  the job posting when it has only a link. The server validates their output per
  kind (`hub.kindOf` → `parseMasterResume` / `parseLooseResume`).
