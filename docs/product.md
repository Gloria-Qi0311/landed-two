# Landed: the product

What Landed is, what the user does and what Landed does for them, the pipeline
every job goes through, and the principles behind each decision. How the code
is laid out is in [architecture.md](architecture.md). Each area doc has the
details. This page says how the parts make one product, and points to the
area docs.

## What Landed is

**Landed applies to jobs for the user.** It is for someone in a hiring season
(students, new grads, interns) who applies to many jobs, often of several kinds
(product, data, engineering), with a resume for each kind. They hand applying
over to Landed:

1. Landed finds jobs that fit what they're looking for.
2. It shows them as **Leads**, best first.
3. The user **approves** the ones they want. That's their one decision.
4. Landed fills and submits each approved application with the right resume,
   writes the open-ended answers, records what it did, and keeps every
   application up to date from email and the companies' portals.

It stops only for what only a person can do: sign in, solve a CAPTCHA, or
answer a sensitive or legal question it has no answer for.

Two things set it apart:

- **It applies accurately, not just in volume.** Green means the value is
  there. It never guesses, and it never invents a fact. Anything it isn't sure
  about stops that one application with the reason.
- **The AI work runs on the user's own agents.** That means Claude Code, Codex,
  Gemini CLI or local Ollama, on their own computer and subscription. The data
  stays in their own browser unless they turn on Cloud sync.

## Who does what

| The user | Landed |
|---|---|
| Sets up once: uploads resumes and says what each is for; answers the questions forms ask (work authorization, sponsorship, start date…); installs the extension and Landed for Mac; connects their mailbox | Reads the resumes into one master and its versions. Fills in the answers it already knows from the resume and the search. Remembers a fact the user corrects on a form |
| Says what they're looking for, in chat or on Find new jobs | Finds jobs on a schedule, drops duplicates and plainly ineligible ones, and ranks the rest |
| Approves Leads (one or many; undoable) | Applies to each approved job: picks the resume, fills every field, writes the open-ended answers, has the user's agent review the form, and submits |
| Clears a blocker when one comes up (sign in, CAPTCHA, a question only they can answer) | Stops only that application and says why. The others go on |
| Reads updates; answers "Needs your input" | Moves applications forward from email and portals on its own when sure (undoable), and asks when not |

The user should never have to make a choice Landed can work out itself. When
Landed decides, it shows what it chose and why (which resume, why this score,
what it answered), with a way to change it.

## The pipeline

Every job goes through one pipeline. Each stage has a default **executor**,
Landed's own rules, and some can add the user's agent as an optional layer.
Each stage has a schedule or trigger. Scheduling runs in Landed for Mac, so it
works with the page closed. Processing happens in the browser, where the data
is. (Product decision 2026-10-22, #148: the Automation page becomes this
Workflow. Until #140 lands, the stages are spread over Find new jobs, Auto
apply, email checks and portal checks.)

```
 ① Find jobs     job lists · platform APIs · wild jobs (agents) · plus manual add, CSV import, screenshots
      ↓
 ② Dedupe        the same job never twice; never two jobs merged into one
      ↓
 ③ Screen, rank  hard filters (only what a posting says outright), fit × urgency
      ↓
    Leads ──► the user approves (authorizes that one job)
      ↓
 ④ Apply         extension: resume, fill, open-ended answers, review, submit
      ↓
 ⑤ Write back    confirmed → Applied, with the resume used and the answers sent
      ↓
 ⑥ Keep current  email checks, portal checks → stage moves, or a question
```

### ① Find jobs

| Source | Executor (default) | Status |
|---|---|---|
| **Job lists**: SimplifyJobs New Grad and Internships | Landed's code reads the list, no tokens | Shipped (#90). More lists, especially product / data / business: #138 |
| **Platform APIs**: Greenhouse, Lever, Ashby boards of up to 25 followed companies | Landed's code | Shipped (#91). More platforms: #138 |
| **Wild jobs**: postings on no list (company sites, posts, referrals) | The user's agents (`job_search`, web tools only), and cloud agents | Shipped. Playbook and measurement: #138 |
| The user: Add, a spreadsheet import, screenshots in chat | The user, Landed reads | Shipped (#120; chat blocks) |

What to look for comes from the active search: a brief the user confirms in
chat, or sets on Find new jobs (roles, places, level, companies to look at
first, sponsorship). Public postings are fetched by the browser, never through
the server, and which companies the user follows never leaves the browser.
Fetching from Landed for Mac with the page closed is planned (#141). It needs
the owner's OK on that rule. Every posting has one stable observation id, so
refreshing never adds it twice, and a posting gone from its source is marked
closed. Each source gets its own executor and schedule in #145. Area docs:
[leads-model.md](leads-model.md), [agents.md](agents.md#job-search).

### ② Dedupe

`packages/observation-processor` is the one place matching rules live
(`sameJob`, `applicationForPosting`). A job already in Leads or already applied
to doesn't come back, and a lead for a job the user applied to leaves Leads
(`already_applied`). On the board, near-identical applications are flagged
"Possible duplicate" and merged only when the user clicks. Planned (#146): the
pairs the rules can't decide go to the user's agent, which sees the two
postings only. "Not sure" counts as different: one extra lead is better than a
real job hidden. Area doc: [observation-processor.md](observation-processor.md).

### ③ Screen and rank

- **Hard filters** act only on what a posting says outright: graduation window,
  no sponsorship when the user needs it, citizenship or clearance. If Landed
  isn't sure, the job isn't filtered. Filtered leads are hidden, never deleted,
  and one the user puts back stays back (#92).
- **Rank**: fit (title, skills, level, place, years) × urgency (deadline,
  posting age), with two or three reasons on each card (#93). Planned (#147):
  the user's agent scores each new batch with reasons. The rule score stays as
  the floor, and an agent that times out never holds a lead back.

Area doc: [leads-model.md](leads-model.md).

### Leads and Approve

The Leads column holds candidates (`job_leads`, status `new`) and approved jobs
(`applications`, stage `saved`), best first, grouped by company. **Approve on
one lead authorizes applying to and submitting that one job**, and nothing
else: not a discovered lead, not a manually saved application, not a later
job. Approving many is the same thing, one job at a time, and it can be undone.
Planned (#142): a five-minute window after Approve, with a countdown, before
the application starts.

### ④ Apply

The extension executes, in the user's own browser. Auto apply is on by
default, runs 1–5 applications at a time in priority order, and skips a company
already at OA, interview, offer or recruiter contact.

1. **Pick the resume**: the version tailored for this job, else the resume whose
   direction is this job's ("Product Manager", "Data Analyst"). When two fit or
   none clearly does, the user's agent reads the posting and chooses (#125,
   #132). The file uploaded is always that resume's own. Which resume and why is
   recorded on the application.
2. **Fill**: saved answers → resume rules → each job and school entry → files →
   dropdowns and radios. Unknown labels go to a local model, which sees labels
   and key names only.
3. **Open-ended questions** ("Why us?"): the user's agent writes them from the
   posting and the resume. A second call checks every claim against the resume,
   and only answers that pass go in (#133).
4. **Settle**: every field marked green is read again after the page's scripts
   ran. Green means the value is there (#124).
5. **Review**: the user's agent checks the filled form. It can pick a fact or an
   option, but never writes text.
6. **Submit**: only when every required field is answered, the review left
   nothing unresolved, and there's no sign-in or CAPTCHA. Then one unambiguous
   final Submit is clicked. Anything else stops that application with the
   reason.

Questions nothing answered are asked once on the Extension page. The answer
fills every later form. A fact the user corrects on a form (city, start date, a
general yes/no) becomes the saved answer, with Undo (#134). Manual Open &
autofill, the popup and the menu bar fill but never submit. Planned (#142):
other executors (an agent driving Chrome) once the owner agrees on their safety
rules. Area doc: [apply-assist.md](apply-assist.md).

### ⑤ Write back

The "thanks for applying" page moves the application to Applied. The
application keeps the resume used and why, the open-ended answers sent
(editable; edited ones teach the agent), and the fill trace. Planned (#143):
Applied the moment a submit is confirmed, and a CAPTCHA that appears after
Submit recorded as a blocker.

### ⑥ Keep current

| Check | Executor | Reach | Then |
|---|---|---|---|
| Email | The user's agent with the mailbox's **read** tools only, on a schedule | New mail since the last check (or back to an import, up to 90 days) | Status observations |
| Portals | The user's agent with Chrome's **navigate and read** tools only | Portals of applications quiet for N days, at most 5 a run | Status observations |
| Pages the user visits | The extension | Confirmation and status pages | Portal events |

Observations go through the processor. A confident forward move is applied on
its own and can be undone. An ambiguous one, a low-confidence one, or one that
would reopen a closed application asks the user. An application with no news
for 21 days asks whether to call it ghosted. Planned (#144): choose the agent
for each check. Area docs: [agents.md](agents.md), [pipeline.md](pipeline.md).

## Around the pipeline

- **Resumes** (My Resume): uploads are read by the user's agent into one
  **master** that keeps every phrasing. **Versions** are tailored to a job,
  never inventing a fact, and each version's one-page PDF is made in the
  browser. Each upload says what it's for (its directions) and keeps its own
  file. [pipeline.md](pipeline.md#my-resume-uploads--master--versions)
- **Application answers** (Extension page): what forms ask that a resume
  doesn't. Landed fills in what it already knows from the resume and search,
  each answer once and marked with Undo. Consent is ticked only if the user's
  own switch is on. [apply-assist.md](apply-assist.md#application-answers-and-the-extension-page)
- **The chat agent** (Agent page): one agent. It knows the resume gist, the
  answers that shape a search, and the search; never contact details. It
  proposes through cards the user clicks: a search brief, applications read
  from screenshots, answers read from a filled form, duplicates to merge.
  [agents.md](agents.md#agent-page-and-chat)
- **Cloud agents** (ChatGPT, Claude, Muse…): connect over MCP, read a briefing,
  and report jobs and email updates as observations.
- **Bringing history in**: spreadsheet import (statuses read by rules, then the
  user's agent for the ones the rules can't read) and CSV export.
  [pipeline.md](pipeline.md#importing-a-spreadsheet)

## Principles

These shape every decision. CLAUDE.md holds the rules, and the area docs hold
the reasons.

1. **Fully automatic; Approve is the one decision.** Don't push a choice back to
   the user that Landed can make. When Landed decides, show what and why, with a
   way to change it.
2. **Landed's rules first, the agent as an optional layer.** Structured data is
   read by code, which costs no tokens and invents nothing. The agent is used
   only where judgment is needed, and when it isn't sure, the safe default wins
   (keep the rules' pick, don't merge, don't fill).
3. **Agents report; Landed decides.** Agents never write to the pipeline. They
   send observations, and one package turns them into leads and suggestions.
   Agents propose, and the user acts on what changes the record (reported
   applications, answers read from a form, merges).
4. **Never guess, never invent.** No saved answer means the field stays for the
   user. If unsure, don't filter. Tailoring and open-ended answers use only the
   resume's facts.
5. **Everything automatic is recorded and undoable**: approvals, email updates,
   imports, answers filled in or remembered, merges.
6. **Local-first.** Data lives in the browser unless the user turns on Cloud
   sync. The server relays and never stores a sync-off account's data.
   Scheduling runs in Landed for Mac, and processing runs in the browser.
7. **The user's own agents, inside fences.** Each agent call has a fixed
   request type validated at both ends, a fixed tool allowlist, and a fixed
   scope of what it sees (below). Widening any of them is a product and
   security decision for the owner.
8. **Never past a human gate.** Never bypass a CAPTCHA or sign-in, never store
   a site password, never tick consent the user didn't switch on.

## What each agent call sees

| Call | Runs on | Sees | Never sees | Can only |
|---|---|---|---|---|
| `match_fields` | Local Ollama, else Claude Code with no tools | Field labels, resume key names | Any value | Name a key; the value comes from Landed |
| `choose_options` | Local Ollama only | A question, its options, the saved answers | — | Pick an option |
| `review_fill` | The user's Claude Code with no tools, else Ollama | The filled form and the facts it came from | Sensitive questions: EEO, date of birth, ID numbers, salary, consent | Pick a fact or an option; flag the rest |
| `pick_resume` | Same | The posting; each candidate resume's directions, titles, skills | Name, contact details, address | Name one candidate (confidence ≥ 0.7) |
| `draft_answers` | Same (writing: `sonnet`) | The posting; the resume's experience, projects, education, skills, summary; the user's edited answers | Name, contact details, address | Write answers that a second call checks against the resume |
| `classify_statuses` | Same | Status words from an imported sheet | Companies, roles, notes | Name a stage, or "unknown" |
| Chat | The user's chosen agent, web tools | Resume gist, search answers, the search | Contact details, address, date of birth, EEO | Answer, propose cards |
| `job_search` | The user's agents, WebSearch / WebFetch | The search brief | — | Report found jobs |
| `email_check` | Agent with the mailbox's read tools | The mailbox | — | Report status updates |
| `portal_check` | Agent with Chrome navigate / read | The portals of quiet applications | — | Report status updates |
| Resume parse / merge / tailor | The user's agent | The resume | — | Read; tailoring never invents |
| Planned: same job (#146) | The chosen agent | Two postings' public text | Anything about the user | Same / different / not sure |
| Planned: rank (#147) | The chosen agent | The posting; the master resume's gist | Name, contact details, address, date of birth, EEO | A 0–1 score and reasons |

## Where the user sees it

| Surface | Holds |
|---|---|
| **Applications** | The board (Leads → Applied → OA / Test → Interview → Offer → Rejected, cards grouped by company), Leads with Approve, "Needs your input", the agents' updates |
| **Agent** | Chat, the agent's questions, setup (connecting a computer and agents) |
| **Automation** (to become **Workflow**, #140) | Find new jobs, auto apply, email and portal checks: schedules, executors, last runs |
| **My Resume** | Uploads, the master, versions, what each is for, each one's file |
| **Extension** | Application answers, files, questions waiting for an answer, answers remembered from forms |
| Extension popup / Landed for Mac menu bar | Fill the page in front of the user (no submit), the fields left and why |

## Where it's going

| Issue | What | Owner |
|---|---|---|
| #148 | Workflow overview: the pipeline above, every stage configurable | Both |
| #140 | Foundation: `workflow` config replacing `automations`, migration, page | Antares (first) |
| #141 | Landed for Mac runs every stage on its schedule, page closed | Antares |
| #142 · #143 · #144 | ④ undo window and executors · ⑤ immediate write-back · ⑥ agent per check | Antares |
| #138 | More job lists and platforms (beyond engineering), the wild-job playbook, before/after numbers | Gloria |
| #145 · #146 · #147 | ① three source kinds, each configured · ② agent for undecided pairs · ③ agent scores with reasons | Gloria |

Order: #140 first, then #141 alongside #145, then #146 before #147, and #142,
#143 and #144 in any order.
