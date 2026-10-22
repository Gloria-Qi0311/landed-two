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
  Saved column. ([leads-model.md](leads-model.md): how the two become the apply queue.)
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
with brackets kept; two different job-board postings never match, whatever their
titles) and ask on the Agent page, one card per group. The user picks
the one to keep (furthest stage by default) and merges it: blanks filled, notes
and interview rounds combined, earliest applied date, leads and resolved
suggestions re-pointed, the rest deleted. Or the user says "they're different",
remembered as a rejected `dup:<ids>` suggestion. **Never merged automatically.**
Asked in chat, the agent ends its reply with an empty ```` ```landed-dedupe ````
block and the page shows the same review there. The board's "Possible duplicate"
badge uses the same groups.

### Importing a spreadsheet

Someone who starts using Landed mid-season already tracks applications in a
sheet. **Import a spreadsheet**, at the top of the Add window (and on the empty
board; one Import window for both, `App.tsx`), takes a
CSV file or cells pasted from Excel, Numbers or Google Sheets
(`lib/import-applications.ts`, `components/import-applications.tsx`). It all
runs in the browser, like the export.

- **Reading**: UTF-8, or GB18030 (Excel on a Chinese Windows); commas, tabs or
  semicolons; quoted cells. A title row above the header is skipped.
- **Columns** are recognized from English and Chinese headers and summed up in
  one line; most sheets need nothing changed, so the per-column choices sit
  behind "Change" (open at once when the company or role column isn't found).
  A column Landed has no place for (priority, type…) goes into notes as
  "Priority: high", so nothing is lost; only row numbers and ids are left out.
  A column that looks like a password is never read, and can't be chosen. A
  work mode written in the location ("上海 · 线下") is read as on-site.
- **Statuses** in either language map to stages, finality first ("rejected
  after OA" is Rejected). Withdrawn and a turned-down offer are Rejected with a
  note (there's no stage for them); no response is Ghosted. Not applied yet is
  a lead in any wording, read before the words for applied that it contains
  ("待申请", "未申请", "计划网申", "未开始", "Not yet applied", "Haven't applied",
  "Will apply", "To do", "Not started"; fix 2026-10-22: a user's 31 "待申请" rows
  went to Applied). **Rules first, then the user's agent**: the statuses the
  rules can't read ("先放着", "回头投", "HR约了周四", "gonna apply this weekend")
  go to the user's own agent (`unreadStatuses` → bridge `classify-statuses` →
  Landed for Mac `classify_statuses`: their Claude Code with no tools, else
  Ollama). Only those status words are sent, never a company, role or note; it
  names a stage from the list or "unknown". The preview lists **every status**
  once ("待申请 · 31 rows → Lead"), with who read it (Landed, your agent, your
  pick); one pick changes all its rows, and Import waits while the agent reads.
  One nobody could read is yellow: Applied when the row has an applied date,
  otherwise a lead. **Dates** are read
  in the usual ways (9/15, 9月15日, Excel day numbers) and never guessed.
- **Against what's in Landed**, with the duplicate rule above: a row already
  there is left out, unless the sheet is further along, then it's offered as a
  move forward (checked by default). Never backwards, never reopening a closed
  one, never merged, with one correction: a job Landed has as Applied with no
  applied date, which the sheet plainly says isn't applied yet, is offered back
  to Leads (checked; an earlier import read it wrong), and a lead that import
  marked applied for it is a lead again. Undo puts both back. A row twice in the sheet is added once, at its furthest
  stage. A company already in Landed keeps Landed's spelling.
- **After**: leads found earlier for these jobs become `already_applied`, so they
  leave Leads and a search doesn't bring them back. Imported applications count
  as news on the day of the import (`last_activity_at`), so the 21-day "still
  waiting?" questions don't all arrive at once. Undo puts everything back. With
  email checks set up, a button re-reads email back to the oldest import, at most
  90 days, to bring them up to date; older ones keep the sheet's status.
- The store call is `importApplications` (`POST /api/import`): each company is
  found or created by exact name, all or nothing, at most 2000 rows a call (the
  import sends 200 at a time). Demo data uses it too.

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
  `target_json`. Its one-page PDF is made in the browser whenever it changes and
  is what the extension uploads for that job ([apply-assist.md](apply-assist.md#files-to-upload)).
- `parsed_json` is always a canonical `Resume`, and for the master it's the
  flattened form. That's what extension autofill reads.
- Both tasks are text-only: no MCP, no tools, except that tailoring may WebFetch
  the job posting when it has only a link. The server validates their output per
  kind (`hub.kindOf` → `parseMasterResume` / `parseLooseResume`).
