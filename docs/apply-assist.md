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
| `open-answers.js` | Open-ended questions ("Why us?"): the user's agent writes and checks them |
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

**Landed picks the resume for each job** (product decision 2026-10-20: Landed
is a fully automatic service, and a user applying to several kinds of roles has
a resume for each; choosing it is Landed's job). `resume_id: "auto"` by default;
`apps/extension/lib/resume-pick.js`, the same rule, words and weights as
`pickResumeFor` on the web (a parity test runs both):

1. The version tailored for this job: the application Landed opened it for, the
   target's link, or company + most of the role in the page title.
2. Else, of the resumes with **a file to upload** (an upload's own file, a
   version's one-page PDF): **the one of this job's direction** (at least half
   of a direction's words in the job title). Each upload says what it's for
   (`resumes.directions`, set at upload to Landed's guess, `guessDirections`:
   its intended position and latest titles without level or season; the user
   can change it on My Resume, `DirectionsCard`, never required). One resume of
   the job's direction → that one (`direction`). Several (a role between two
   directions, "Product Analyst") → `composite`, and what the posting asks for
   decides among them. None → the best overall, `unsure`. Scoring, when needed:
   0.75 × the job title against the resume's direction (a version's target role;
   an upload's intended position, its name minus the person's name and "resume",
   its two latest job titles; abbreviations and word forms folded: PM = product
   manager, "Product Management" = manager) + 0.25 × the share of its skills the
   posting mentions. Under 0.3, or within 0.1 of the next one, it's `unsure`:
   still picked, and said ("not sure, check it").
3. None with a file: the current resume, then the master (`no_file`).

**Between close resumes, the user's agent decides** (auto apply). When step 2
ends `composite` or `unsure`, the pick carries its `candidates` (best first, up
to four), and before opening the tab auto apply asks the user's own agent
(`askAgentToPick` → bridge `pick-resume` → native `pick_resume`: their Claude
Code with no tools, else local Ollama). It gets the job's title, company and
posting text and, per candidate (`pickCandidate`), what it's for, its job titles
and skills: never the person's name, contact details or address (a direction
drawn from a file name with the person's name in it is left out). It can only
name one of the candidates, with confidence ≥ 0.7; anything else, no agent, or
an error keeps the rules' pick. Its choice is recorded as `agent`, with its one
sentence of why ("your agent read the posting: …"). The posting is untrusted
prompt input.

The page's job title and posting text come from the tab (content.js `page-job`).
**Which resume and why is recorded on the application** (`applications.resume_choice`
`{resume_id, name, reason, at}`, written when auto apply or Open & autofill opens
it, shown in the drawer: "Resume: Data resume · a Product Analyst role fits “Data
resume” and “PM resume”; the posting asks for SQL, Tableau"). Nothing asks the
user: Approve is the one decision, and the record is there to look at.
The popup shows each tab's pick, why, and its file. The user can still choose one.

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
5b. **Open-ended questions** ("Why us?") go to `native-host.ts` → `draft_answers` (below).
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
- **`draft_answers`** ("Open-ended questions", above) is the one request where
  the agent writes text: answers from the posting and the resume's experience
  (never contact details), passed by a second check before they go in.
- **`pick_resume`** (above, "Between close resumes") sends a posting and the
  candidate resumes' directions, titles and skills to the user's own agent; it
  names a candidate or nothing.
- **`same_job`** sends pairs of leads the duplicate rules couldn't call: only the
  postings' public details (company, title, place, link, the start of the
  description), never anything about the user. It answers same, different or
  unsure per pair, with the tokens used
  ([leads-model.md](leads-model.md#remove-duplicates-with-your-agent-146)).
- **`rank_leads`** sends what the chat agent is told about the user (no contact
  details, address, date of birth or EEO answers) and a batch of new postings.
  Each gets a 0–1 score with 1–3 reasons; one without reasons gets none
  ([leads-model.md](leads-model.md#rank-with-your-agent-147)).
- Page labels are untrusted prompt text.

Browser extensions are the only code that touches the DOM. `lib/fill/submit.js`
may click exactly one unmistakable final-submit control only for a tab carrying
the per-job authorization created by Approve. It rejects intermediate Next /
Continue / Review / Apply-now controls, multiple candidates, blockers, missing
required fields and yellow review fields. Every other fill surface stops before
Submit.

### Green means the value is there

A field the fill marked green must still hold its value once the page's own
scripts have run (`lib/fill/settle.js`, after every other phase, before the
review). Some sites clear what was typed unless it was picked from their list
(Lever's Current location is a plain input with plain-div results, and it
empties itself on blur), so marking a field green the moment Landed wrote to it
showed green fields that were empty.

- **Type, then pick, recognized by behavior**: each short text field Landed
  filled is retyped key by key. If suggestions appear by the field (elements the
  page adds or shows next to it that share a word with what was typed), the
  matching one is clicked: a place by its city and state (`chooseCity`), else
  the closest text. If nothing on the page changes within about 0.4 s, it's a
  plain field; if the page changes but nothing appears by the field within about
  1.2 s, too (results can take that long from the site's server, Lever's
  location search), so pages that restyle on every keystroke don't hold each
  plain field 2 s. Roles and ids aren't needed, so a widget that doesn't announce
  itself works too. **Never a button, link or submit** (owner's review,
  2026-10-22): a candidate that is or sits inside a `button` (a `<button>` in a
  form submits unless its type says "button"), `a[href]`, `[role=button]`,
  `[role=link]` or `[role=menuitem]` is never clicked, unless it's a
  `role=option`; a submit never, even inside a list.
- **Then every green field is read again** the way a person sees it: a text
  field's value, a select's chosen option, a dropdown's choice shown in its
  control (react-select keeps its search input empty), not a placeholder like
  "Select…". One that's empty now turns yellow, with "didn't keep the value"
  on it, and counts in `lost`. Upload fields aren't re-read (sites empty the
  input once they've sent the file), nor are fields the page has hidden since.
- **Type, then pick only the same thing**: a place is picked by its city and
  state; a company or school only when the suggestion is the same name (legal
  suffixes and a qualifier after a separator aside: "Google LLC",
  "University of Washington - Seattle"), never a different one that starts alike
  ("Google Cloud"). Otherwise nothing is clicked: better left for the user than
  wrong, above all when an approved application submits on its own.
- **For approved applications** (auto apply): a field that didn't keep its
  value is a review issue named in the blocker ("Current location didn't keep the
  value…"), so that application stops and the others go on. Optional questions
  are asked once but marked `optional`, so `unanswered` counts only required ones
  and an optional blank never stops a submit.
- **The popup lists the fields left for the user**, each with why (no saved
  answer, didn't keep the value, sensitive, the review flagged it…); a click
  brings the tab forward and focuses that field (content.js `focus-field`).
- **Optional questions nothing answers** (no `required` / `aria-required`, no
  `*` / `✱` / "required" in the label) aren't yellow and don't count as needing
  review. They're marked `blank`, so they're still asked once on the Extension
  page and filled when answered. The popup says how many stayed blank.
- **A field's question is text a person sees** (`getStrictLabel`): hidden text
  and suggestion lists or menus beside the field (Lever's "No location found…")
  are never its label. This is also what the reviewer is sent.
- **On real sites**: `pnpm --filter ./apps/extension live-check` fills real
  application pages (one open posting from a few public Lever, Greenhouse and
  Ashby boards, or the URLs given) with a made-up applicant, and fails on any
  green field that's empty. Nothing reaches the company: every form `submit`
  event is blocked, and once the fill starts every request that isn't a read is
  blocked at the network (Ashby and Greenhouse's React forms submit with fetch,
  no submit event). A GraphQL query is a read (Ashby looks up locations with
  POST); a mutation never is. Blocked writes are listed; one named like a
  submission (submit / apply) counts as a submit and fails the page, the rest
  (Ashby saving each field as a draft, analytics) are blocked but aren't. Saved test pages
  can't show this, because they don't run the site's scripts.
  `LANDED_EXTENSION_DIR` points it at another copy, such as the installed one.
  Run it before releasing fill changes; it's not in CI, since live sites change.

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

### Open-ended questions

Product decision (2026-10-22, #98, as a fully automatic service): Approve is the
user's one decision, so an approved application doesn't stop at "Why do you want
to work here?". `lib/fill/open-answers.js`, after the model step:

- **Which**: empty textareas nothing else answered, and one-line boxes that
  plainly ask for an essay ("Why…", "Describe…", "Tell us…"); required ones, and
  optional ones only when they ask why (interest, motivation). Never sensitive
  questions (`neverSent`), links, salary or dates. Limits from the field's
  `maxlength` and its label or hint ("max 500 characters", "200 words", "300字");
  none given: about 180 words. The resume summary no longer fills a question
  about the job or one experience ("What interests you about this role?",
  "Tell us about a project"): `field-detect.js` `SUMMARY_QUESTION_*`.
- **Who writes**: the user's own agent, `draft_answers` (their Claude Code with no
  tools, `sonnet`, else local Ollama). It gets the job (title, company, posting
  text: the lead's, else the page's), the resume this application is filled from
  (experience, internships, projects, education, skills, summary: never the name,
  contact details or address) and up to four answers the user edited before, as
  their voice. It may only use the resume's facts and the posting; a question
  the facts can't answer truthfully gets no answer.
- **The check**: a second call reads every answer against the same facts and
  passes only ones that claim nothing the resume doesn't say, answer the
  question and say nothing about the company the posting doesn't. The host also
  drops answers over their limit or with a placeholder. Only passed answers go
  in: green, source `draft` (not sent to `review_fill` again), with a note.
- **No agent, or nothing passed**: the field stays empty. A required one is
  yellow (`开放题`, "needs an answer to an open-ended question") and an approved
  application stops with that reason; an optional one stays blank.
- **Kept**: what was written goes back with the fill result
  (`open_answers`, the assist results queue) and onto the application
  (`applications.open_answers`, migration 0024, Dexie v15). The drawer shows
  them under "Answers sent"; the user can edit one, and edited ones are the
  examples the agent follows next time (`openAnswerExamples`). A Landed-opened
  tab keeps what it wrote (`drafted`, by question), so a reload or the form's
  next page doesn't ask the agent again.

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

Work authorization and sponsorship are about the US. A question that names
another country and not the US ("Are you authorized to work in the United
Kingdom?", "Do you require sponsorship to work in Germany?", 新加坡…) isn't what
they say: `classify` doesn't map it to them (`asksAboutAnotherCountry` in
`lib/choice-answers.js`), the local model isn't asked to pick it from them
(`choose_options`, `match_fields`), and the review doesn't see it. It stays
yellow and is asked once as its own question; `sameQuestion` answers it after
that. "The US or Canada" and "the country where this job is located" still take
the saved answers.

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

**A correction on a form is remembered** (product decision 2026-10-22: Landed
is an automatic service; the user shouldn't make the same fix on every form).
When the user changes a field on a page Landed filled (a trusted `change`,
never Landed's own events), `lib/fill/learn.js` reads what the question is about
and the new answer. Only facts that hold for every application are kept
(`LEARNABLE`): city, state, country, earliest start, LinkedIn / GitHub /
website, how they heard, and the general yes/nos (18 or older, authorized to
work, sponsorship, relocate, travel, onsite, other locations, non-compete,
talent network). Never date of birth, street address, EEO, consent, "worked
here before?" (one company's) or open-ended text; a bare "Location" isn't kept
either (it may be where they'd work). **Nor a question about one place or one
amount** (owner's review, 2026-10-22): "No" to "Are you willing to relocate to
Austin, TX?" isn't "No" to relocating anywhere, and a UK work-authorization
"No" must never flip the saved US one. `namesPlaceOrAmount` (extension
`lib/choice-answers.js`, the same rule in `packages/schema` for `learnAnswers`,
a web test runs both): a percentage or a number of days / hours / weeks; a
country other than the US, a US state, "City, ST", a Chinese city or
"办公室 / 分公司"; or a capitalized name inside a sentence (a city, an office, a
company), unless the label capitalizes every word. The US and its visas
(H-1B, OPT…) are general. The extension sends the question along, and the page
drops a correction without one or with such a question. A city from a location box keeps the city
("Bellevue, Washington, United States" → Bellevue); a yes/no takes the option's
first word. The background queues one per question (`landed:answer-corrections`,
the latest wins), the open Landed tab takes them (bridge `take-corrections`)
and `learnAnswers` saves each as the answer, noted in
`application_answers.learned` with what it was before and the site. The
Extension page lists them ("Remembered from forms you corrected": City: Bellevue
· was Seattle · on jobs.lever.co) with **Undo** for each, which puts the old
answer back. A remembered answer also takes its question off the waiting list.

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

**Workday questionnaire labels** (fix, 2026-10-22): a custom dropdown's own
accessible text may be only `Select One Required`; the real question is a long
nearby label or one of several `aria-labelledby` references. `getFieldLabel`
keeps up to 300 characters of that question. `Select One` / `Required` is a
prompt, never an existing answer: when no saved answer covers the real question,
it must enter the Extension page's pending-question queue. Global Settings and
language dropdowns are page chrome, not application fields. A Workday question
that explicitly defines time-limited non-immigrant authorization as **No** is
not the ordinary authorization question: needing sponsorship or lacking work
authorization proves No; a generic saved Yes alone never proves Yes.

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

**The file uploaded is the picked resume's own, never another one's** (the form
and the file must be the same resume). Each uploaded resume keeps the file it was
read from (`resume_files`, migration 0023, Dexie v14; saved when its upload
becomes a resume, `keepFileFor` in `lib/resume-tasks.ts`; My Resume shows it on
the resume, `SourceFileCard`, with a way to add it when missing). A version's
file is its one-page PDF (below). The Landed page hands every upload's file to
the extension by resume id (bridge `sync-version-pdf`; `null` for one with no
file, so the extension knows), and `loadApplicationFiles(resumeId, kind)` uses
it. The extension keeps the newest 40 resumes' files and asks for
`unlimitedStorage` (Chrome caps `storage.local` at 10 MB without it, and a few
resumes' files are more; it adds no install warning). A hand-over that still
fails comes back as an error, and the file's place says so (My Resume's file
card, the Extension page's file slots: "Your browser extension couldn't keep
this file…", `useFileHandoff`) instead of the file being dropped silently.
A picked resume with no file of its own gets none, and the popup says so.
Only the master (merged, no file of its own) gets the account's default file.
Until the page has handed over uploads' files (an older Landed page), the
extension keeps the old behavior: the default file. Uploads from before resumes
kept their files get the account's file when it's named after them
(`adoptKeptFiles`); older files were replaced and must be uploaded again.

Same page: the account's default resume file and an optional cover letter, one
per kind. The newest PDF or Word file uploaded on My Resume becomes the default
(`keepResumeFile`). Limits: .pdf/.doc/.docx ≤ 3 MB
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
manual Retry approved control. Workflow's Auto apply stage owns its on/off switch, 1–5 concurrent
limit, Run now
and queue/blocker status (`automations.auto_apply`). The global
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
or CAPTCHA. A CAPTCHA counts only when it's on screen for the person: shown, with
a size, not hidden, not marked invisible. Lever, Greenhouse and Ashby embed
invisible ones (a zero-height hCaptcha, Google's `size=invisible` badge in the
corner, hidden challenge frames) that act only on submit; counting those stopped
every fill on those sites. A page that says "verify you are human" or "security
check" counts; a "protected by hCaptcha" footer doesn't. It never signs in, creates an account or works around the challenge.
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
