# Extension, Apply Assist and Landed for Mac

Apply Assist fills job application forms in the user's browser and stays local.
Manual Open & autofill, the extension popup and the menu bar stop before Submit.
Explicitly approving one Lead authorizes the automatic queue to fill, review and
submit that one application when there are no unresolved fields. Login, account
creation, CAPTCHA, missing answers/files and review flags block only that job and
tell the user what to fix.

## Code layout (`apps/extension`)

| Piece | Files | Runs in |
|---|---|---|
| Service worker | `background.js` | The extension. Tab registry, `fillTab`, portal polling, pending-event queue, native messaging |
| Content scripts | `manifest.json` → `content_scripts[0]`, in this order: `schema.js`, `lib/*` helpers, `lib/portal-parsers/*`, `lib/choice-answers.js`, `lib/fill/*.js`, `content.js` | Every frame of every page (`all_frames`, `match_about_blank`) |
| Page bridge | `lib/web-bridge.js` (content script on Landed origins), `lib/bridge-handler.js` | Landed web tabs only |
| Popup and options | `src/popup/App.tsx`, `src/options/App.tsx` (React, built by Vite) | The extension |

Content scripts are classic scripts that share the page's `window`. The fill code
is split by kind of field. Each `lib/fill/*.js` file is an IIFE that takes what it
needs from `window.LandedFill` and adds its own functions to it. `content.js` only
holds the message listener and `handleFill`.

| Module | What it does |
|---|---|
| `core.js` | Field ids, `deepAll` / `isRendered` (open shadow roots), outlining, sensitive labels, `fillField`, visible inputs |
| `blockers.js` | Stops before sign-in, account creation or CAPTCHA; never works around them |
| `selects.js` | Native `<select>` |
| `values.js` | Turning resume and answer values into what a field wants |
| `combobox.js` | Search-box dropdowns (react-select, place autocompletes), `chooseCity` |
| `files.js` | Resume and cover letter uploads |
| `choices.js` | Radio and checkbox groups, saved answers |
| `inputs.js` | Text inputs in batches |
| `dates.js` | Date pickers, multi-entry sections (experience, education) on Chinese portals |
| `experience.js` | Work Experience and Education sections on English forms (Workday's "My Experience"): one entry per job and school |
| `ai.js` | Asking the local model for unknown labels and unanswered choices |
| `review.js` | Where each value came from; the fill report; the agent review after a fill |
| `unanswered.js` | Empty questions worth asking the user once; filling them on open pages once answered |
| `trace.js` | What this fill did, step by step: phases, model calls, every field's source or why it was left |
| `frames.js` | A sub-frame showing a form reports itself to the service worker |
| `portal.js` | Status detection on candidate portal pages |

A new module goes in `manifest.json` before `content.js`. Tests load the content
scripts in manifest order through `tests/helpers/content-scripts.js`, so whole-page
fill tests run the same code as the browser.

## Control surfaces

- **Landed for Mac menu bar app** (`apps/daemon/macos/LandedMenuBar.swift`): the
  primary control surface. It lists pages reported by every connected browser
  profile, lets the user choose up to five pages, and writes per-session commands
  under `~/.landed/apply-assist`.
- **Extension popup**: one Fill button for the current tab (`fill-tab`).
- **Open & autofill from Landed** (below).

The resume is **automatic by default** (`resume_id: "auto"`). Each page gets the
version tailored for its job: the application Landed opened it for, the target's
link, or company + most of the role in the page title; else the current resume;
else the master (`apps/extension/lib/resume-pick.js`, the same rule as
`pickResumeFor` on the web). The page bridge sends each version's
`{role, company, job_url, application_id}` with the resumes. The user can still
choose one.

The extension is a lightweight DOM bridge. It publishes only tab metadata and
resume names, keeps resume contents in browser storage, receives menu commands,
and fills selected pages in parallel. Chromium uses the registered
`dev.landed.assist` Native Messaging host. Safari uses the embedded Web Extension
handler plus the loopback-only server in `apps/daemon/src/safari-bridge.ts`, and
the menu app wakes it with `SFSafariApplication`. Landed.app embeds Safari support
and registers the native host for Chrome, Chromium, Brave and Edge during
`setup`; each browser profile still needs one explicit enable step. Future
Firefox support should reuse the local session protocol instead of moving the UI
back into a browser.

## How a page is filled

Deterministic DOM rules run first. Fields are outlined green (filled) or yellow
(needs review).

1. **Saved answers** for text fields first (legal names before the resume rules),
   then native selects, custom dropdowns and radio groups.
2. **Resume rules** for the rest.
3. **Files**: the resume file and cover letter go into upload fields.
4. **Unknown labels** go to `apps/daemon/src/native-host.ts` → `match_fields`.
5. **Unanswered choices** go to `native-host.ts` → `choose_options`.
6. **Review**: the user's own agent checks the filled form → `review_fill` (below).
7. **Still empty**: the questions worth asking go to the Extension page, once (below).

### Work Experience and Education sections

Fix, 2026-10-19: on Workday's "My Experience" page only the resume file went
in. `lib/fill/experience.js` runs before the other phases and owns these
sections' fields, so the page-wide rules (the user's own city, only the current
job) and the local model never touch them:

- **Work Experience** gets every job *and internship* on the resume, newest
  first (`workEntries`), one entry each: job title, company, that job's location
  (left empty when the job has none), "I currently work here", From / To
  (Workday's MM and YYYY boxes, a single MM/YYYY box, or a year), role
  description. "Add" or "Add Another" makes the next entry.
- **Education** gets each school: school, degree, field of study, GPA, years.
  Workday's "type and press Enter" search boxes (school, field of study) are
  typed, Entered and the matching result is clicked; only on Workday, since an
  Enter elsewhere can submit a form.
- Sections are found by Workday's ids (`workExperienceSection`,
  `workExperience-N`, `formField-jobTitle`…), else by their headings ("Work
  Experience", "Work Experience 1") and field labels. What can't be filled stays
  yellow when it has a value or is required. Chinese portals' sections keep the
  older `dates.js` path.

### Forms in iframes and web components

Content scripts run in every frame (`all_frames`). A sub-frame showing a form (3+
fields, not a chat box or newsletter signup, re-checked as dialogs open) reports
`frame-form` to the service worker. The service worker keeps the tab's form frames
in session storage and fills the page plus those frames, adding the results up
(`fillTab` in `background.js`; the popup's Fill goes through it with
`fill-tab`). Queries reach into open shadow roots (`deepAll`), labels resolve in
the field's own root, and the outline styles are injected there too.

### Models: labels and key names only

- **`match_fields`** uses the user's Ollama, or without it the user's Claude Code
  (`claude -p`, `--tools ''`, `--strict-mcp-config`, `--setting-sources ''`, no
  session saved, `haiku`; `claudeMatchArgs`). The model sees field labels and
  resume key names only, may select an existing key, and the host supplies its
  original value. Unknown keys and confidence below 0.8 are rejected. Saved text
  answers join the local call as extra key names (never values; not sent to the
  remote fallback).
- **`choose_options`** is **local Ollama only**: these prompts carry the user's
  answers as facts, so there is no Claude fallback. The model returns an option
  index (≥ 0.85), and the extension clicks that existing option.
- **`review_fill`** (below) sends filled values to the user's own agent, with
  sensitive questions left out.
- Page labels are untrusted prompt text.

Browser extensions are the only code that touches the DOM. `lib/fill/submit.js`
may click exactly one unmistakable final-submit control only for a tab carrying
the per-job authorization created by Approve. It rejects intermediate Next /
Continue / Review / Apply-now controls, multiple candidates, blockers, missing
required fields and yellow review fields. Every other fill surface stops before
Submit.

### Review after filling

Product decision (2026-10-18, #95): after a full fill, the user's own agent checks
the answers, the way it already parses and tailors their resume. The user's
Claude Code goes first, with the same sandbox as `match_fields` (`claudeArgs`),
else local Ollama (`qwen3.5:9b` when installed). In testing, 8 fields with 4
planted errors: Claude Code (haiku) caught 4, qwen3.5:9b 3, qwen3.5:4b 2. Without
either, the fill finishes without a review.

Token use: a one-line system prompt replaces Claude Code's own (about 6k tokens)
and thinking is capped at 1024 tokens (`MAX_THINKING_TOKENS`; with none, haiku
missed the error that takes an inference). A page costs about 2k tokens in and
1.5–2k out. `match_fields` gets the same short system prompt and no thinking:
about 1.5k tokens a call.

1. **Where each value came from.** Each fill phase tags what it filled
   (`data-landed-source`): `answers` (saved application answers), `resume`
   (a resume rule), `entries` (experience and education rows), `saved` (custom
   fields, learned mappings), `model` (the local model), `page` (there before
   Landed), `file`.
2. **The fill report** (`fillReport` in `lib/fill/review.js`): every field Landed
   touched, with its question, the value now in it, its source and, for selects
   and radio groups, the options. Experience and education rows, files and
   checkboxes are left out. So is every sensitive question (`neverSent`:
   voluntary EEO, date of birth, ID and passport numbers, salary, consent and
   terms); the summary only counts them.
3. **Facts** (`reviewFacts`): saved answers as `answers.<kind>` and resume values
   as `resume.<key>`, sensitive ones and long descriptions left out.
4. **The reviewer** (`review_fill` in `native-host.ts`) answers each field with ok,
   fix or doubt. A fix names a fact key, and the host supplies that fact's value,
   or an option index; anything else, or confidence below 0.85, becomes a doubt
   (≥ 0.6) or nothing. The reviewer never writes text.
5. **Applying.** A fix replaces values from a resume rule or the local model and
   fills empty fields. Values from the user's saved answers, saved fields or the
   page itself are only flagged. Changed and flagged fields turn yellow with the
   reason (`data-landed-note`, also the field's tooltip) and join the review list.
   The popup says what the agent changed and how many to look at.

### Questions a fill couldn't answer

Product decision (2026-10-19, #96): what a form asks that nothing answers is
asked once, on the Extension page, and answered by rule on every form after.

1. **Reported.** After a fill, `unansweredQuestions` (`lib/fill/unanswered.js`)
   lists the fields still empty and yellow, with the question, the form's options
   for a choice, the site, and `key`: the saved answer the question is about
   (`classify`, only answers in `ASKABLE_KEYS`). Never reported: sensitive
   questions (`neverSent`), files, open-ended text (textareas, answered per job),
   dates, checkboxes, and fields the resume should hold (`matchResumeKey`).
2. **Queued.** `fillTab` queues them in `chrome.storage.local`
   (`landed:unanswered-questions`, one per question per site) and remembers the
   tab for the session.
3. **Kept with the answers.** The Landed tab takes them over the page bridge
   (`take-questions`, once) and adds them to `application_answers.unanswered`
   with `addUnanswered` (`packages/schema/src/application-answers.ts`): the same
   question however worded (`sameQuestion`: the same key, or 80% of the
   meaningful words) is one entry with its sites and a count; nothing already
   answered, skipped (`skipped`, "Don't ask again") or sensitive is added. It's
   part of the answers row, so it syncs and backs up with them; saving the
   answers form keeps the latest list.
4. **Asked.** The Extension page lists them (`components/pending-questions.tsx`;
   the sidebar's Extension item counts them, the Agent page points there). An
   answer goes to its `key` (a yes/no one takes Yes or No), else "other
   questions" (`answerPending`).
5. **Answered from then on.** "Other questions" match a field by `sameQuestion`
   (`customAnswerFor` in `choice-answers.js`, mirroring the schema) for text
   fields, selects, custom dropdowns and radio groups. When the answers reach the
   extension (`sync-answers`), the tabs the questions came from get
   `fill-answers`: only fields still empty and yellow are filled, so nothing the
   user typed changes.

Questions only the user's answers can answer (`ANSWER_ONLY`: how you heard,
18+, authorization, sponsorship, relocation, travel, onsite, other locations,
worked here before, non-compete, talent network) stay yellow when nothing is
saved, instead of taking a resume field that happens to match ("How did you hear
about us?" used to get the resume summary).

### Fill traces

Product decision (2026-10-21): every fill keeps a trace, so a bad fill can be
traced to the rule or model call behind it without reproducing it.

- **Recorded per frame** (`lib/fill/trace.js`): `startTrace` when a fill starts,
  `tracePhase` after each phase (files, entries, answers, resume, selects,
  dropdowns, dates, choices, saved fields, model, review: how long, how many
  fields it filled), `traceModel` for each model call (`match_fields`,
  `choose_options`, `review_fill`: asked, answered, model, error, time), and
  `finishTrace` for every field Landed marked: question, kind, status, source
  (`data-landed-source`), the value (clipped), the review's note, and why it was
  left for the user (the `addManual` hint in words). Sensitive questions
  (`neverSent`, `isSensitiveLabel`) and passwords carry `hidden: true` and no
  value. A blocked page's trace says why nothing was filled.
- **Added up per page** (`fillTab` → `lib/fill-trace-store.js`): the page (no
  query string), the resume, the totals, the frames, and how the fill started
  (`popup`, `menu`, or `assist` for a tab Landed opened; that one's empty retries
  before its form appears aren't kept). It gets a 6-character ref (Crockford
  base32). A Landed-opened tab's outcome (ready, blocked, submitted, error) is
  added when it's known, and the ref goes with the result to Landed, which
  appends `· fill <ref>` to the application's next step.
- **Kept**: the last 20 in `chrome.storage.local` (`landed:fill-traces`). A
  Landed Cloud account's also go to the server (`PUT /api/fill-traces/:ref`,
  `fill_traces`, migration 0022), kept 30 days and deleted with Cloud sync off.
  The server refuses a sync-off account's (`requireCloud`); those stay in the
  extension. Uploading happens after the fill returns, so a slow server never
  holds up the popup. Traces are debugging records, not job-hunt data: not in
  Dexie or the snapshot.
- **Read**: the popup shows the ref next to each page's result; clicking it
  copies the whole trace. On the user's paired computer, `landed fill-trace
  <ref>` (`pnpm landed fill-trace <ref>` from the repo; `--json` for the raw
  trace) reads it with the computer's runtime token (`GET
  /api/runtime/fill-traces/:ref`, read-only, the owner's traces only) and prints
  it with `formatFillTrace` (`packages/schema/src/fill-trace.ts`). The server
  validates every trace with `parseFillTrace`: known keys only, strings clipped,
  at most 300 KB, a hidden field's value dropped.

## Application answers and the Extension page

`/extension` (sidebar under My Resume; product decision after acceptance review:
extension content is managed there, not inside My Resume) holds what forms ask
that a resume doesn't: legal and preferred names, date of birth, permanent
address, work authorization, sponsorship, start date, relocation and travel,
preferred locations, "worked here before", how you heard, talent network,
voluntary EEO, LinkedIn / GitHub / website links, "18 or older", "onsite N days a
week", plus free "other questions" (`packages/schema/src/application-answers.ts`,
`parseApplicationAnswers`).

**What Landed already knows is filled in on its own** (product decision
2026-10-19). Many of these questions are answered by the resume (master, else
current) or the active job search. `useKnownAnswers` (`apps/web/src/hooks/answers.ts`,
mounted once in the app) fills the blank ones with `suggestAnswers`
(`apps/web/src/lib/answer-suggestions.ts`) and saves them, so the extension has
them at once. The Extension page says so in a card above the answers ("10
answers are already filled in from your resume and job search… if one isn't
right, just change it"), marks each one "From your resume" / "From your job
search" while it's as written, and has **Undo** (saved at once, like the fill).

| Answer | From |
|---|---|
| Legal first and last name | the resume's name, only when it has both a first and a last part (one word, or a Chinese name, can't say which part is which) |
| LinkedIn, GitHub, website | the resume's links, made full `https://` links; text that isn't a link is skipped |
| City, state, country | the resume's location ("Seattle, WA" → Seattle / Washington / United States; Canadian provinces; "City, Country"), only when all three are blank, so a half-typed address isn't mixed with it. Marked "where you live now": a permanent address may differ |
| Earliest start | the latest school end date still ahead ("June 2027") |
| Preferred locations | the search's places (not "Remote"), up to three |
| Sponsorship | the search's `needs_sponsorship`, when it said |

Only blanks are filled, never an answer the user gave. Each question is filled
in **once**: `application_answers.prefilled` notes what was written and from
where (validated by `parseApplicationAnswers`, kept by `mergeAnswers`), so one the
user cleared, changed or undid isn't filled in again. Never filled in: date of
birth, street address, work authorization, "18 or older", EEO and consent. The
never-guessed rules below still hold for everything else.

One row per account in the data store (`application_answers`, Dexie v11,
migration 0019, in snapshots, deleted server-side when Cloud is turned off). The
page bridge hands them to the extension (`sync-answers` →
`landed:application-answers` in `chrome.storage.local`).

`apps/extension/lib/choice-answers.js`:

- `classify` says which question a label asks;
- `answerFor` turns the saved answer into yes/no, text, decline or agree;
- `pickOption` finds the option that says it (a tie is no answer).

For choice questions, the question is the legend, group label or surrounding
text, and each option is its own label.

**"Have you worked here before?" follows the resume** (fix, 2026-10-19): one saved
yes/no can't answer it for every company — a Yes saved from one form made every
company's question Yes. `previouslyEmployed` in `choice-answers.js`: a company
on the resume (named in the question, or the careers site's host) is Yes;
any other is No when the saved answer is No or blank; a saved Yes for a
company the resume doesn't show stays with the user. The local model and the
reviewer get the resume's employers as a fact instead of the saved yes/no, and
an agent's read of a form never saves a Yes for it.

**Never guessed:**

- no saved answer → yellow;
- EEO left blank → "I don't wish to answer";
- consent (privacy policy, data processing, "I confirm…") is ticked only when the
  user turns on `agree_to_terms` ("Tick consent boxes for me"). It's the user's own
  switch: an agent's read never sets it;
- saved answers alone never authorize Submit; only Approve on that lead does.

The agent can read a form the user already filled (screenshot or text) and answer
with a ```` ```landed-answers ```` block (`extractAnswers`). The chat card saves
it with `mergeAnswers` (what it read replaces, the rest stays, consent untouched),
only when the user clicks.

### Files to upload

Same page: the user's own resume file and an optional cover letter, one per kind.
The newest PDF or Word file uploaded on My Resume becomes the resume file
(`keepResumeFile` in `lib/resume-tasks.ts`). Limits: .pdf/.doc/.docx ≤ 3 MB
(`packages/schema/src/application-files.ts`; `application_files`, Dexie v12,
migration 0020, stored as base64 text so snapshots carry them; the list is
metadata, bytes one file at a time).

**A tailored version uploads its own one-page PDF** (product decision
2026-10-19, #97). `apps/web/src/lib/resume-pdf.ts` (pdf-lib) makes it in the
browser from the version's `parsed_json`: one column, real text in reading order,
standard section names (education first for students and new grads), US Letter,
body 10.5 pt stepping down to 9.5 pt at most. A version that doesn't fit on one
page gets no PDF; My Resume says about how many lines to cut
(`VersionPdfCard`). Text the built-in fonts can't show is swapped or dropped, and
a version with Chinese, Japanese or Korean text gets no PDF until a CJK font is
embedded. The PDF is derived, so it's never stored: the page bridge fingerprints
each of the 20 newest versions (`versionHash`), asks which ones the extension
has (`version-pdf-ids`) and sends the missing or changed ones (`sync-version-pdf`;
`null` for a version that can't have one). A fill carries the resume's id
(`resumeId`), and `loadApplicationFiles(resumeId)` puts that version's PDF in
place of the saved resume file; otherwise the saved file goes in as before.

The bridge asks the extension which file ids it has (`file-ids`) and sends only
missing or changed ones (`sync-file`). `lib/fill/files.js` puts them into upload
fields by label (`fileKind` in `choice-answers.js`: resume/CV vs cover letter,
`accept` respected) with a `DataTransfer`. Upload fields are identified by what
names them, then their id/name (Greenhouse: `resume`, `cover_letter`), then the
surrounding text closest first. A field with no saved file is reported
(`missing_files`) and the popup says where to add it.

### Search-box dropdowns

react-select on Greenhouse and place autocompletes (`role=combobox` /
`aria-autocomplete`) are **never filled as text**. That left typed text that
looked chosen while the form still said "required". `chooseInCombobox`
(`lib/fill/combobox.js`):

1. opens the list (ArrowDown too, for background tabs), else types the value and
   waits for results;
2. clicks a real option (react-select ≤ 5.6 options have no role, only
   `…-option-N` ids);
3. clears its search text when nothing fits, and blurs it so no menu stays open.

A dropdown with no rule answer has its options read (≤ 12 per page; searched
lists show none) and goes to the local model like radio groups. Place
autocompletes take the result whose place name *is* the city ("Seattle Hill" is
another place), in the saved state when there are several.

## Open & autofill, approved execution, and submissions → Applied

A lead card (sparkle icon) and a saved application's drawer
(`components/apply-assist.tsx`) ask the extension over the page bridge
(`assist-open`: http(s) link, resume id, Landed ids only) to open the posting and
fill it with the resume `pickResumeFor` chooses (`lib/apply-assist.ts`: the
version tailored for this application or posting, then a close role at the same
company, then the master, then the current one).

The extension remembers the tab's application or lead (`chrome.storage.session`),
fills again on the next page if the form wasn't on the first, and stamps the ids
on that tab's portal events. Confirmation events (`raw_kind` applied /
already_applied) become applications in the browser (`ingestPortalConfirmations`
in `lib/inbox/confirmations.ts`, run by `hooks/extension-bridge.ts` on load, on
focus and on every new event, one tab at a time via Web Locks): the stamped
application or lead, else screenshot matching. A forward move is undoable, and
each submission is handled once (`portal-applied:` ledger suggestion, so deleting
the application doesn't bring it back). Events older than 30 days are ignored.

**Approved-lead execution** (#99) starts automatically after Approve and keeps a
manual Retry approved control. Automation owns its on/off switch, 1–5 concurrent
limit, Run now and queue/blocker status (`automations.auto_apply`). The global
`useAutoApplyRunner` stays mounted on every Landed route. It uses the same
`priority` order as the cards and opens only as many linked `saved` applications
as the configured concurrency leaves free, one tab at a time in that order;
each tab then fills, reviews and submits independently. A manually saved
application has no linked-lead authorization and is never included. A skipped or
blocked job never consumes the rest of the batch:

- another application at that company is already at OA, interview or offer;
- an active application at the company has a `recruiter_response` note;
- the application is already filling / waiting for review, lacks a posting link,
  or has no usable resume.

Before touching fields, `blockers.js` checks for a visible password/account form
or CAPTCHA. It never signs in, creates an account or works around the challenge.
The service worker queues a small result (Landed ids, counts and blocker only;
never form values) under `landed:assist-results`. The open Landed tab takes each
result once: `next_step` becomes a specific `Blocked · …`, `Review highlighted
fields, then submit` for manual fills, or `Submitted · waiting for confirmation`,
and the batch UI tells the user while every other tab continues.
After the user signs in or creates the account and the tab navigates, the normal
fill can run again. Turning Auto apply off prevents new tabs but does not cancel
an authorized tab already running. The menu bar and the web batch both cap a
selection at five.

## Landed for Mac updates itself

`apps/daemon/src/updater.ts` (product decision: no reinstall per release).

- `build-mac.mjs` stamps every build with a time-sortable id
  (`20261015T085012Z-<commit>`, also CFBundleVersion) in `Resources/build.json`,
  embeds the public half of an Ed25519 **release key** (`Resources/update-key.pem`)
  and writes `Landed-mac.json` `{version, build, sha256, size, signature}`. It
  signs only on the release machine, whose private key lives in
  `~/.landed-release` (never in the repo; losing it means users reinstall once).
- `setup` copies `build.json` and the key next to the installed daemon.
- The service checks `GET /api/downloads/landed-mac.json` on its paired server 2
  minutes after start and every 6 hours. A newer build is installed **only if the
  signature verifies with the key this install came with** and the zip's size and
  SHA-256 match. The server just hosts, so a compromised server can't push code.
- Install: unpack (`ditto`), confirm the app's own build id, quit the menu app,
  swap `Landed.app` in place (the running copy, else Spotlight's, else
  /Applications), `lsregister`, `open -g … --updated`. The app's launch runs
  `setup`, which installs the new daemon, extension and native host and restarts
  the service; `--updated` keeps the menu closed.
- Unsigned builds (the mini's own, running from source) never update.
  `deploy.sh` uploads the zip first, then the manifest.
