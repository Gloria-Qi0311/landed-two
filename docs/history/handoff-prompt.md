# Claude Code — first prompt

> Copy everything below the divider into Claude Code as your first message. Adjust the *bracketed* sections to match your stack preferences.

---

I'm handing off a design prototype for **Landed**, a job-hunt operations tool. Your job is to turn it into a working product. Before you write any code, **read these three files in order**:

1. `spec.md` — functional spec (data model, extension protocol, AI round-trip rules, edge cases, open questions)
2. `design-system.html` — canonical visual language (tokens, components, patterns). Open in a browser to see it rendered.
3. `index.html` — the live prototype. Read the imported scripts (`components/*.jsx`) for component patterns.

Also useful:
- `how-it-works.html` — extension storyboard, treat as visual spec for the popover states
- `data.js` — demo data shape (use this as the seed for your real schema)

---

## What I want you to deliver in v1

A working web app with:

- **Auth** (Supabase Auth — email + Google + GitHub)
- **Applications module** — 5 views (Kanban / Table / Timeline / Cards / Map) backed by real Postgres data. Kanban must support drag-and-drop between stages with optimistic update.
- **Sync module** — UI only for v1. Wire up the page to display real `portal_connections` and `portal_events` from the DB. The extension itself is **out of scope for this first sprint** — but design the API surface so the extension can post events to it.
- **AI Workspaces** — Resume Match and JD Breakdown. The round-trip primitive must work end-to-end:
  - Generate prompt → copy to clipboard + `window.open(provider_url)`
  - Paste-back textarea + three-tier parser (JSON → markdown → heuristic)
  - Persist `ai_runs` to DB
  - Render comparison from saved runs
- **Empty states** — when a user has no applications / no portals / no resume, render the empty-state components in `components/empty-states.jsx`. Do NOT show demo data to real users.
- **Onboarding tour** — first-time-after-signup, show the 4-step tour from `components/auth.jsx`. Persist `onboarded_at` on the user row.

---

## What to defer to v2 (do not build now)

- The browser extension itself (Manifest V3, content scripts, scrapers per portal vendor) — separate sprint
- Add-new-application form (the "+ Add" button in the dashboard) — stub it for now, just open a basic form modal that posts to `applications`
- Multi-resume targeting (one resume per JD)
- Gmail / Outlook email parsing
- Mobile-specific layout (responsive degradation is fine, no native mobile)

---

## Stack I want you to use

- **Frontend:** [Vite + React + TypeScript], [Zustand] for client state, [TanStack Query] for server state, [Tailwind] or just import the CSS variables from the prototype's design tokens
- **Backend:** [Supabase] (Postgres + Auth + Row-Level Security + Realtime for the activity feed)
- **Deployment:** [Vercel] for the web app

Match `spec.md` section 3 for the data model. Generate Supabase migrations from those table definitions.

---

## Things to strip from the prototype before shipping

- The **Tweaks panel** (search for `EDITMODE-BEGIN` and `__edit_mode_*` and remove all of it — it's design-review infrastructure, not user-facing)
- The demo data in `data.js` — replace with empty state on first run
- Any hardcoded "Apr 19" timestamps — use real `created_at` / `last_activity_at`

---

## Open questions I want you to surface, not guess

From `spec.md` section 10:

1. Pricing tier definition — free vs Pro
2. Mobile strategy
3. Team / coach mode
4. Resume parser depth (filename-only vs structured fields)
5. Notification channels (extension only vs email/SMS)

Default to my preferences if I've already answered, otherwise ASK before building speculatively.

---

## Order of work I want

**Sprint 1 (this week):**
1. Read all docs. Confirm understanding back to me with a 1-paragraph summary + any clarifying questions.
2. Scaffold the project, set up Supabase, write migrations from `spec.md`.
3. Implement Auth + onboarding tour + sidebar shell.
4. Implement Applications module with real CRUD (Kanban first, others can follow).
5. Implement empty states everywhere.

**Sprint 2:**
6. AI Workspaces (Resume Match end-to-end first, then JD Breakdown reusing the same primitive).
7. Sync page UI (no extension yet — just the DB-backed display).
8. Polish + edge cases from `spec.md` section 8.

**Sprint 3 (separate):**
9. Browser extension.

When you start each task, **show me a screenshot or recording before moving on**. I want to review pixel parity with the prototype.

---

## How to handle UI questions

When you hit a state the prototype didn't cover (e.g. "what does the search results panel look like with 0 hits") — **don't invent**. Either:
- Match the closest existing pattern in `design-system.html`
- Or note it in a `design-questions.md` file in the repo so the design partner can resolve a batch

The design system is the source of truth for visual decisions. If you're tempted to pick a new color, font size, or radius — there's almost certainly already one defined.

---

## Last thing

The product's whole differentiation is in two patterns: **AI round-trip without paid API** and **portal sync without per-portal logins**. If you find yourself simplifying either of those, stop and ask. Everything else is table stakes.

Ready? Confirm you've read the three docs, then start with Sprint 1, Step 1.
