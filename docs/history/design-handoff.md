> Archived: the original design brief (May 2026). Much of it is out of date — the current architecture is in docs/architecture.md.

# Handoff: Landed — Job Hunt Operations Tool

> **Running it:** `pnpm install && pnpm dev` (needs a local Postgres). Landed is **local-first**: everyone signs in, but each account's data lives in the browser unless the account turns on **Landed Cloud sync** (`apps/server`, Hono + Postgres) to sync across devices. **Apply Assist** lives in the Landed for Mac menu bar: choose open application pages and a resume there, then let lightweight browser bridges fill them with deterministic rules plus optional local Ollama matching. It never submits an application. See [`apps/server/README.md`](apps/server/README.md) for setup, configuration, and deployment, and `CLAUDE.md` for the data-layer rules. The design handoff below predates both changes: read "Supabase" as `apps/server`.

## Overview

**Landed** is a job-hunt operations tool for active job seekers. It solves three pain points:

1. **Tracking** — Visualize every application across portals (5 view modes: Kanban / Table / Timeline / Cards / Map)
2. **AI-assisted comparison & writing** — Route prompts through user's own ChatGPT / Claude / Gemini subscription (no paid API). Compare resume against multiple JDs, or extract requirements and tailor resume.
3. **Auto-sync from portals** — Browser extension that piggybacks on existing logins (Greenhouse / Lever / Workday / Ashby / BOSS Zhipin) and pulls status changes every 6 hours.

This handoff package contains a complete design prototype + functional spec for a developer to build the real product.

---

## About the Design Files

The HTML files in this bundle are **design references**, not production code. They were prototyped in vanilla React + Babel for fast iteration but are **not the artifacts to ship**.

Your task is to **recreate this design in a real production codebase** using your stack of choice. Recommended (see `spec.md` section 2):
- Vite + React + TypeScript
- Zustand for client state, TanStack Query for server state
- Tailwind CSS — port the OKLCH tokens from `design-system.html` into the Tailwind config
- ~~Supabase~~ → self-hosted `apps/server` (Hono + Postgres; auth, REST, SSE realtime)
- Vercel for deployment

## Fidelity

**High fidelity.** Every page is pixel-targeted — final colors, typography, spacing, border treatments, and interaction states. Recreate this UI pixel-perfectly. Use the design system in `design-system.html` as the canonical source for tokens; use individual pages in `index.html` for component composition reference.

---

## Where to start

**Read these three files in order before writing code:**

1. **`handoff-prompt.md`** — A ready-to-use first prompt for Claude Code. Open this and paste it as the first message after you start the project. It contains the work order, scope cuts, and behavior rules.
2. **`spec.md`** — Functional spec covering data model, browser-extension protocol, AI round-trip parsing rules, edge cases, and the 5 open questions to ask the founder.
3. **`design-system.html`** — Visual language reference. Open in a browser. Every color, typography size, spacing token, and component pattern is here.

Then dive into:

- **`index.html`** — Live product prototype. Sidebar nav switches between Applications / Sync / Resume Match / JD Breakdown. Inspect `components/*.jsx` for implementation patterns.
- **`how-it-works.html`** — Browser-extension storyboard. 4 scenes showing the popover in different states (install / tracking / detection / expired). This is the visual spec for the extension popup UI.

---

## The product, in one diagram

```
┌─────────────────────────────────────────────────────────┐
│  Sidebar                                                │
│  ├─ Applications  (5 views)         ← Module 1          │
│  ├─ Sync          (extension UI)    ← Module 2          │
│  ├─ Resume Match  (AI round-trip)   ← Module 3a         │
│  └─ JD Breakdown  (AI round-trip)   ← Module 3b         │
└─────────────────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
  Supabase DB        AI Round-trip       Browser Ext.
  (apps, events,     (user's existing    (per-portal
   ai_runs)           ChatGPT/Claude/     scrapers)
                      Gemini)
```

---

## Screens / Views

### Auth & onboarding

#### Login screen (`components/auth.jsx` — `LoginScreen`)
- Two-column layout. Left 420px: brand mark + "Welcome back / Land your next role." headline + Google/GitHub buttons + email/password form. Right: marketing canvas with mini-Kanban preview, live activity card, AI router preview.
- Sign-in / sign-up mode toggle.
- Persists `landed:signedIn` to localStorage.

#### Onboarding tour (`components/auth.jsx` — `OnboardingTour`)
- 4-step modal shown after first sign-in: Welcome → Track every application → Auto-sync from portals → AI without paying for an API.
- Each step has its own art panel (Landed mark / view-strip preview / sync status list / AI router preview).
- Stepper pill at bottom (active step is wider). Skip / Back / Next controls.
- Persists `landed:onboarded` after first dismissal.

#### Profile menu (`components/auth.jsx` — `ProfileMenu`)
- Triggered by clicking user row at bottom of sidebar.
- Floating popover (224px wide) with header card (avatar, name, email, Pro-plan badge) + grouped items: Profile/Resumes/Preferences | What's new/Show tour again/Help | Sign out.
- Dismisses on outside-click.

### Sidebar (`components/shell.jsx` — `Sidebar`)
- 232px wide, fixed.
- Top: brand mark + bell with red dot when portals need attention.
- 4 nav items (Applications / Sync / Resume Match / JD Breakdown).
- "How it works" + "Design system" external links (review-only — strip from production).
- Scrollable middle section with filter views (when on Applications page): Views (All / Active / Starred) + Pipeline (8 stages with counts).
- Always-visible bottom: Portal status strip + user profile trigger.

### Applications Dashboard (`components/shell.jsx` + 5 view components)

**Page header (`PageHeader` in `shell.jsx`)** — used on every top-level page. 15.5px / 600 title, 11.5px subtitle, right-aligned action cluster. Padding `12px 28px 10px`, bottom hairline border.

**Stats banner (`StatsBanner` in `shell.jsx`)** — optional row below header showing This Week / Interviewing / Offers / Response Rate / Next 7 Days. 17px display numbers.

**Views:**
- **Kanban** (`components/kanban.jsx`) — Horizontal columns per stage. Each card: company mark + name + role + next step pill + meta row.
- **Table** (`components/table.jsx`) — Dense sortable table. Columns: Company / Role / Stage / Next / Location / Comp / Source / Applied / Last activity.
- **Timeline** (`components/other-views.jsx` — `TimelineView`) — Bucketed by relative time (Today / This week / Last 2 weeks / This month / Earlier) with stage dots on a vertical rail.
- **Cards** (`components/other-views.jsx` — `CardsView`) — Grouped by company. Each card lists all roles at that company with stage badges.
- **Map** (`components/other-views.jsx` — `MapView`) — Schematic by geographic region (NOT a real map — pill grid grouped by US-West / US-East / China / Europe / Remote).

**Detail drawer (`components/drawer.jsx`)** — 460px right-aligned overlay. Sections: company header, role + team + job ID, stage chip selector, portal sync card, meta grid (comp/location/remote/source/applied/referral), next step highlight, notes, activity timeline. Footer: Open in portal / Tailor resume / More.

### Sync (`components/sync-page.jsx`)
4 status cards at top: Extension / Portals watched / Needs attention / Last sync.

**Tabs:**
- **Overview** — "How auto-sync works" 4-step explainer + recent activity preview
- **Connections** — Sortable table of all `portal_connections` with provider badges, status pills, last-sync timestamps, Re-auth / Sync now buttons
- **Activity feed** — Reverse-chrono list of `portal_events` (status-change / expired / new-event / sync / rejection)

### Resume Match (`components/resume-match.jsx`)
**Single dashboard, NOT linear steps** — three AIs can be in different states simultaneously (parsed / awaiting / failed). See `AI Round-trip primitive` below for the core pattern.

Sections:
- Inputs (collapsible) — current resume + N JD cards
- Generated prompt (collapsible) — preview + 3 "Launch [AI]" buttons that copy-to-clipboard + open new tab
- Models strip — 3 AI status cards (idle / awaiting / parsing / parsed / failed)
- Active task panel — Paste textarea + 3 sample-insert buttons (JSON / Markdown / Plain text) + parse preview
- Comparison results — Bump chart (rank by AI) + per-JD cards with avg score and per-AI ranks

### JD Breakdown (`components/jd-breakdown.jsx`)
Sections:
- Source JD strip (compact, shows which AI parsed and when)
- Match summary (4 stats: Match% / Must-haves / Gaps / Suggested edits)
- Requirements grid (must-have list with hit/partial/miss dots + nice-to-have + N-week gap study plan)
- **Resume Tailor** — Same Models strip as Resume Match (proving the round-trip primitive). Below: Diff viewer showing each bullet's original (strikethrough) + tailored (with inline segment highlighting — green for additions, red for removals). Per-bullet accept/reject + Accept all / Reject all + Apply to resume.

### Empty states (`components/empty-states.jsx`)
First-time user views when no data exists yet. **Real users must see these, not the demo data.**

- `EmptyApplicationsView` — Two CTAs: Connect portal (recommended) / Add manually + CSV import row
- `EmptySyncView` — Install extension prompt + 8 supported portals + Install for Chrome / See how it works
- `EmptyResumeMatchView` — 2-step layout: Upload resume → Add JDs (second step grayed until first done)
- `EmptyJDBreakdownView` — Big paste box + URL / Pick from applications shortcuts

### Tweaks panel
**Design-review infrastructure — strip from production.** Search for `EDITMODE-BEGIN` and `__edit_mode_*` and remove. See `spec.md` section 7.

---

## Interactions & Behavior

### AI Round-trip primitive (the core pattern)

This pattern appears in both Resume Match and JD Breakdown. It's how Landed delivers AI value without paying for an API.

```
1. Generate prompt (task-specific template)
2. User clicks "Launch ChatGPT" / "Launch Claude" / "Launch Gemini"
   → copy prompt to clipboard
   → window.open(provider_url, '_blank')
   → model card flips to "awaiting"
3. User pastes AI response into our textarea
4. tryParseResponse() — three-tier fallback:
   a. JSON.parse → success
   b. Markdown table heuristic → success
   c. Plain text heuristic → fail with manual-fix UI
5. Save → write ai_runs row → comparison view updates
6. If parse failed → show raw text + error + "Paste again" textarea
```

Full implementation reference: `components/resume-match.jsx` and `components/jd-breakdown.jsx`. The parser logic is in `tryParseResponse` in `resume-match.jsx`.

### Portal sync (browser extension)

Out of scope for sprint 1, but designed for sprint 3:

```
1. User logged into careers portal (Greenhouse etc.)
2. Content script reads DOM, finds applications
3. Service worker schedules 6-hour periodic alarm
4. Each cycle: open hidden tab, scrape, diff against last snapshot
5. Emit portal_events for deltas; push to web app via Postgres NOTIFY → SSE
6. Cookie expired → emit expired event → web app surfaces re-auth UI
```

Full walkthrough in `how-it-works.html`. Per-vendor scraping mapping in `spec.md` section 4.

### Animations & transitions
- Drawer slide-in: 180ms cubic-bezier(0.2, 0, 0, 1)
- Onboarding modal fade-in: 200ms ease
- Pulse animation (expired portals, syncing dots): 2s ease-in-out infinite
- Tab/view pill transitions: 120ms
- Hover transitions on cards: 120ms

---

## State Management

Read `spec.md` section 3 for the full data model. Key tables:
- `users` (email + password hash, `current_resume_id`, `onboarded_at`)
- `companies` (per-user; auto-generated `hue` + `logo_chars`)
- `applications` (the core entity — stage, dates, notes, portal links)
- `portal_connections` (one per portal-vendor login)
- `portal_events` (append-only event stream from the extension)
- `ai_runs` (every AI round-trip + parsed JSON + raw response)

Client state (Zustand recommended):
- Current page, current view, current filter
- Selected application (for drawer)
- AI workspace state per provider (idle / awaiting / parsing / parsed / failed)
- Onboarding step

---

## Design Tokens

All tokens use OKLCH for perceptual uniformity. **Source of truth: `design-system.html`** — open it in a browser to see every token rendered.

### Colors (cool theme)
| Token | Value | Usage |
|---|---|---|
| `--bg` | `oklch(0.985 0.002 240)` | Page background |
| `--surface` | `oklch(1 0 0)` | Cards, drawers, popovers |
| `--surface-2` | `oklch(0.975 0.003 240)` | Inset / nested surface |
| `--surface-3` | `oklch(0.955 0.005 240)` | Hover / selected nav |
| `--fg` | `oklch(0.22 0.01 240)` | Primary text |
| `--fg-muted` | `oklch(0.55 0.01 240)` | Secondary text |
| `--border` | `oklch(0.90 0.005 240)` | Default 0.5px border |
| `--border-subtle` | `oklch(0.94 0.004 240)` | Row dividers in cards |
| `--border-strong` | `oklch(0.82 0.008 240)` | Hover state on cards |
| `--accent` | `oklch(0.48 0.13 240)` | Links, focus |

### Stage colors
Each pipeline stage has a 4-color set (bg / fg / dot / ring). Hue rotates ~30° per stage. See `stageColors` in `components/primitives.jsx`.

### Themes
Cool (default), Warm, Editorial (with Instrument Serif display), Dark. See `index.html` `:root[data-theme=*]` selectors.

### Typography
- **Body**: Inter 400/500/600
- **Mono**: JetBrains Mono (timestamps, IDs, file paths, code)
- **Display (optional)**: Instrument Serif (Editorial theme only)
- Scale: 10.5 (eyebrow) / 11 (micro) / 11.5 (caption) / 12 (small) / 12.5 (body) / 14 (section title) / 15.5 (page title) / 17 (display number) / 22 (marketing/DS section head)

### Spacing & radii
- Radii: 4 (chip) / 6 (button) / 8 (card) / 10 (panel) / 999 (pill)
- Borders: 0.5px hairline universally
- Page padding: header `12px 28px 10px`, body `16px 28px 24px`
- Shadows: drawer `-12px 0 40px rgba(0,0,0,0.08)`, popover `0 12px 40px rgba(0,0,0,0.18)`

---

## Assets

- **Brand mark**: SVG geometric "L" with orange accent dot. See `LandedMark` in `components/primitives.jsx`. Use SVG directly — don't rasterize.
- **Company logos**: Auto-generated colored monograms keyed off a stable per-company `hue` (0–360) and 2-char `logo` string. No external logo fetching. See `CompanyMark` in `components/primitives.jsx`.
- **Icons**: 30 single-color SVG line icons in `Icon` (in `components/primitives.jsx`). 24×24 viewBox, 1.5 stroke (2 for emphasis). Listed in `design-system.html` § Iconography.
- **Fonts**: Inter + JetBrains Mono + Instrument Serif — loaded from Google Fonts.

No external image assets. No company logos pulled from third parties.

---

## Files in this bundle

```
design_handoff_landed/
├── README.md                  ← you are here
├── handoff-prompt.md          ← READ THIS FIRST — paste into Claude Code
├── spec.md                    ← functional spec, data model, edge cases
├── design-system.html         ← visual language reference (open in browser)
├── how-it-works.html          ← extension storyboard (open in browser)
├── index.html                 ← live product prototype (open in browser)
├── data.js                    ← demo data shape — replace with DB
└── components/
    ├── primitives.jsx         ← Icon, StageBadge, CompanyMark, LandedMark, etc.
    ├── shell.jsx              ← Sidebar, PageHeader, StatsBanner, SectionLabel
    ├── kanban.jsx             ← Kanban view
    ├── table.jsx              ← Table view
    ├── other-views.jsx        ← Timeline / Cards / Map
    ├── drawer.jsx             ← Application detail drawer
    ├── sync-page.jsx          ← Sync page (Overview / Connections / Activity)
    ├── resume-match.jsx       ← Resume Match (AI round-trip primitive)
    ├── jd-breakdown.jsx       ← JD Breakdown + Resume Tailor diff view
    ├── auth.jsx               ← Login / Profile menu / Onboarding tour
    ├── empty-states.jsx       ← First-time user views
    └── browser-window.jsx     ← Chrome window chrome (storyboard only)
```

---

## Open questions to resolve before coding

From `spec.md` section 10 — surface these to the founder. **Don't guess.**

1. **Pricing tier definition** — Free vs Pro split. What's behind paywall? AI run count? Tracked portals?
2. **Mobile strategy** — Read-only mobile? Full mobile? Or web-only?
3. **Team / coach mode** — Career coaches with multiple clients? (Likely v2.)
4. **Resume parser depth** — Filename-reference only, or parse to structured fields?
5. **Notification channels** — Extension-only desktop notifications, or email/SMS for big events (offer, rejection)?

---

## How to start (TL;DR for the developer)

1. `cd` into the project, open `handoff-prompt.md`, copy its content
2. Start a new Claude Code session and paste it as the first message
3. Claude Code will read the 3 docs, ask any clarifying questions, then propose a plan
4. Review the plan, approve, and let it execute Sprint 1
5. After each sprint, do a screenshot review against `index.html` for pixel parity
