# Landed — Functional Spec

Handoff package for Claude Code. The design prototype is in `index.html`. The extension storyboard is in `how-it-works.html`. The visual language is documented in `design-system.html`.

This spec captures behavioral requirements **the prototype can't express on its own** — backend shape, extension protocol, parsing rules, edge cases.

---

## 1. Product summary

A job-hunt operations tool with three core modules:

1. **Applications** — visual tracker for every role applied to (Kanban, Table, Timeline, Cards, Map views)
2. **Sync** — browser-extension-backed auto-pull of status changes from career portals
3. **AI Workspaces** — Resume Match (rank JDs against resume) and JD Breakdown (extract requirements + tailor resume); both use a shared "AI Round-trip" pattern

No paid AI API. All AI work is routed through the user's existing ChatGPT / Claude / Gemini subscription.

---

## 2. Architecture overview

```
┌────────────────────────┐    ┌────────────────────────┐
│  Browser extension     │    │  Web app (this repo)   │
│  - content scripts     │    │  - React + Vite        │
│  - service worker      │◄──►│  - dashboard + AI flow │
│  - portal scrapers     │    │  - tweaks panel        │
└──────────┬─────────────┘    └────────────┬───────────┘
           │                                │
           └────────────┬───────────────────┘
                        ▼
           ┌────────────────────────────┐
           │  Supabase (auth + db)      │
           │  - users                   │
           │  - applications            │
           │  - portal_connections      │
           │  - portal_events           │
           │  - ai_runs                 │
           └────────────────────────────┘
```

**Recommended stack:**
- Frontend: Vite + React + TypeScript, Zustand for state, TanStack Query for server state
- Auth + DB: Supabase (Postgres, Row-Level Security)
- Extension: Manifest V3, content scripts per portal vendor
- No own AI API — strict round-trip through user's browser

---

## 3. Data model

### `users`
| field | type | notes |
|---|---|---|
| `id` | uuid | Supabase auth |
| `email` | text | |
| `current_resume_id` | uuid | FK to resumes |

### `companies`
Per-user. (User may have private notes; we don't share globally.)
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | |
| `name` | text | |
| `hue` | int 0–360 | Auto-assigned from name hash; used by `CompanyMark` |
| `logo_chars` | varchar(2) | Auto-derived from name first letters (override allowed) |
| `sector` | text | |
| `loc` | text | |
| `portal_url` | text | URL that drops user back into their applications list |

### `applications`
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | |
| `company_id` | uuid | |
| `role` | text | |
| `team` | text | nullable |
| `stage` | enum | `saved / applied / oa / phone / onsite / offer / rejected / ghosted` |
| `salary` | text | free text |
| `location` | text | |
| `remote` | enum | `Remote / Hybrid / On-site` |
| `applied_at` | timestamp | nullable for `saved` stage |
| `next_step` | text | nullable |
| `referral` | bool | |
| `source` | text | LinkedIn / Referral / OCR / etc. |
| `job_id` | text | external ID from portal |
| `portal_application_url` | text | link to user's specific app on the portal |
| `notes` | text | |
| `starred` | bool | |
| `last_activity_at` | timestamp | updated whenever stage or notes change |

### `portal_connections`
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | |
| `company_id` | uuid | |
| `provider` | text | Greenhouse / Lever / Workday / Ashby / BambooHR / BOSS / SmartRecruiters |
| `portal_host` | text | e.g. `boards.greenhouse.io` |
| `status` | enum | `active / syncing / expired / disconnected` |
| `last_sync_at` | timestamp | |
| `last_seen_login_at` | timestamp | last time extension confirmed valid session |
| `failure_reason` | text | when status=expired |

### `portal_events`
Append-only stream of everything the extension detected.
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | |
| `connection_id` | uuid | |
| `application_id` | uuid | nullable for connection-level events |
| `type` | enum | `status-change / new-event / expired / sync / rejection` |
| `created_at` | timestamp | |
| `payload_json` | jsonb | type-specific fields |

### `ai_runs`
Every AI round-trip the user completes.
| field | type | notes |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | |
| `task` | enum | `resume_match / jd_breakdown / resume_tailor` |
| `provider` | enum | `chatgpt / claude / gemini / other` |
| `prompt_text` | text | what we generated and copied to clipboard |
| `response_text` | text | what user pasted back |
| `parsed_json` | jsonb | structured result after `tryParseResponse` |
| `parse_format` | enum | `json / markdown / heuristic / failed` |
| `created_at` | timestamp | |

---

## 4. Browser extension

### Manifest V3 shape
- `content_scripts` matched per portal vendor (Greenhouse / Lever / Workday / Ashby / BOSS / etc.)
- `service_worker` for periodic alarm + diffing
- `host_permissions` only for portals the user opts in to (request incrementally)
- `storage.local` for last-snapshot cache
- No portal cookies ever exfiltrated. Only parsed text fields (role, stage, dates) sync up.

### Detection cycle
1. User visits a portal page that matches one of our content scripts
2. Script parses the DOM, finds applications, posts to extension popup
3. Popup offers "Track this company" → on accept, write `portal_connections` row + initial `applications` rows
4. Service worker schedules `chrome.alarms.create('portal-sync', { periodInMinutes: 360 })`
5. On alarm, for each active connection:
   - Open a hidden / pinned tab to the portal's "my applications" URL
   - Wait for content script to scrape DOM
   - Diff against last snapshot stored in `storage.local`
   - Emit `portal_event` for each delta
   - Push to web app via Supabase realtime

### Status detection mapping per portal
Maintain a per-vendor mapping table — when the portal says "Final Round", that maps to our `onsite` stage. When it says "Application Withdrawn", that's `rejected`. **Do not try to auto-detect new mappings via LLM** — explicit dictionaries per vendor are safer.

### Expired login flow
- Content script tries to read the applications list. If redirected to login OR DOM lacks expected markers → set connection status = `expired`, emit event of type `expired`
- Web app surfaces this in the Sync page + sidebar warning + (if extension can) a chrome.notifications popup
- "Re-authenticate" button just opens the portal's login page in a new tab. After successful login the next scheduled sync resolves the expiration silently.

---

## 5. AI Round-trip primitive

Used by Resume Match and JD Breakdown. The UI lives in `components/resume-match.jsx` (and the parallel structure in `components/jd-breakdown.jsx`).

### Flow
```
1. Generate prompt
   Caller provides:
   - task type
   - structured input (e.g. array of JDs + resume reference)
   - desired output schema (JSON shape)

   Primitive produces a prompt template like:
     "Return JSON: { rankings: [{ jd_id, rank, score, reasons, gaps }] }
      # RESUME ... # JDS ..."

2. Launch
   On user click:
   - navigator.clipboard.writeText(prompt)
   - window.open(provider.url, '_blank')
   - flip state to "awaiting"
   - show toast "Prompt copied · ChatGPT opened. Paste reply when ready."

3. Paste
   Active task panel reveals a textarea + 3 "Insert sample" buttons (JSON / Markdown / Plain text)
   for testing. On user paste, run tryParseResponse.

4. tryParseResponse (sync, deterministic)
   a. JSON.parse → if shape matches expected schema → return { ok: true, format: 'JSON' }
   b. Markdown table heuristic → look for | jd1 | … | with numeric scores → return { ok: true, format: 'Markdown' }
   c. Heuristic on plain text → look for known titles + scores → return { ok: false, error: "..." }
   d. Otherwise → { ok: false, error: "..." }

5. Save → write ai_runs row → update local state → fire UI animation
   If next AI is "idle", auto-select it.

6. Recovery (parse failed)
   - Show the raw text + the error
   - Reveal "Paste again" textarea
   - Optionally: "Fix manually" mode that lets user fill the structured fields by hand
```

### Parser rules

The parser **must be permissive about whitespace, capitalization, and field ordering**. It **must not** be permissive about field semantics — score must be a number, jd_id must reference a known JD.

If the model returns fewer rankings than JDs sent, that's OK — surface a "Missing 1 JD — try a follow-up?" hint.

If the model returns extra rankings (hallucinated JDs not in input), drop them and surface a "Dropped 1 hallucinated entry" hint.

### Provider URLs
Don't hardcode forever — keep a config:
```ts
const PROVIDERS = {
  chatgpt: { url: 'https://chat.openai.com', launchMethod: 'newTab' },
  claude:  { url: 'https://claude.ai',        launchMethod: 'newTab' },
  gemini:  { url: 'https://gemini.google.com', launchMethod: 'newTab' },
};
```

### What we don't do
- We don't try to auto-fill the AI's input box. That requires browser automation we don't have, and changes break weekly.
- We don't store the user's AI conversation history. We only save the prompt we sent + the response they pasted back.

---

## 6. View-specific behavioral notes

### Applications views
- **Kanban** — drag-and-drop between columns updates `stage` + emits a local event (not a portal event, since it's user-initiated). Saving requires no network round-trip; optimistic update.
- **Table** — column-header click sorts. Resizable columns are nice-to-have, not required.
- **Timeline** — bucketed by relative time (today / week / 2-weeks / month / earlier). Buckets are computed client-side from `last_activity_at`.
- **Cards** — grouped by company. Always-shown.
- **Map** — schematic by geographic region. Not a real map (Mapbox / Leaflet would be overkill). Cities are the leaves; user clicks a pill → opens detail drawer.

### Detail drawer
- 460px wide, right-aligned overlay
- Click outside or Esc closes
- Stage selector is a chip grid — click any stage, instant save
- The "Open in portal" button uses `applications.portal_application_url` if set; falls back to `companies.portal_url`; falls back to a generic Google search.

### Sync page
- **Overview** tab is a marketing-style "How auto-sync works" + live preview of recent activity
- **Connections** tab is a table of all `portal_connections` with sync now / re-auth / disconnect controls
- **Activity feed** tab paginates `portal_events` desc by `created_at`

---

## 7. Tweaks panel — design infra only

The Tweaks panel exists for the design-review iteration phase. **Strip it from production builds.** It uses a `postMessage`-based protocol unique to the design host and has no value to end users.

---

## 8. Edge cases & gotchas

1. **Multi-portal companies.** Some companies post the same role on Greenhouse AND their own ATS. Don't auto-dedupe — surface a "Possible duplicate" warning instead.

2. **Recruiter emails as a status source.** Future feature: a Gmail / Outlook integration that parses interview-confirmation emails → emits `new-event`. Out of scope for v1.

3. **Re-auth race conditions.** If a user has 3 expired connections to different portals on the same vendor (e.g. 3 Greenhouse boards) — re-authing one doesn't fix the others. Each portal is independent.

4. **Time-zone handling.** Always store timestamps as UTC. Render in user's local TZ. The bumpchart sort order is by `last_activity_at` desc.

5. **Resume versioning.** A user may want one resume per JD. v1: single `current_resume_id`. v2: per-application override.

6. **Cookie persistence across portals.** Don't ever try to centralize cookies. Each portal is its own login session. Trying to be clever here is a security smell.

7. **AI prompt size.** Truncate JD text to ~4k tokens (~16k chars) before pasting into prompt. If a JD is longer, summarize-then-rank in two passes. Surface this to the user.

8. **Bilingual job posts.** When a JD has both English and Chinese sections (common for tech companies in mainland China), keep both in the prompt — let the AI sort it out. Don't pre-translate.

9. **Stripped Tweaks panel.** Search for `EDITMODE-BEGIN` / `__edit_mode_*` and remove them in the production build pipeline.

---

## 9. Future modules — not in v1

| Module | Why deferred |
|---|---|
| Add-new-application form | Standard CRUD, not differentiating |
| Calendar integration | Useful but heavy; users can copy/paste for now |
| Gmail email triage | Requires OAuth + DPA, big lift |
| Native iOS / Android | Cross-device is solved by the web app + extension |
| Multi-resume targeting | Wait until users ask |
| Public profile / "I just landed" share | Out of scope for ops tool |

---

## 10. Open questions for the founder

1. **Pricing.** Free + Pro tier? What's behind the Pro paywall? AI run count? Number of tracked portals?
2. **Mobile.** Read-only mobile view, or full mobile? Affects whether we Skip-it.
3. **Team mode.** Career coaches using Landed with multiple clients? Probably v2.
4. **Resume parser.** v1 we just ask user to upload PDF and reference filename in prompt. v2 we'd parse it into structured fields. When?
5. **Notifications channel.** Desktop only (via extension) or also email / SMS for major events (offer, rejection)?

---

## 11. Files to read in this prototype

- `index.html` — main shell + Tweaks panel
- `data.js` — demo data (40 companies, 44 applications, portal statuses)
- `components/primitives.jsx` — colors, icons, StageBadge, CompanyMark, PortalDot, LandedMark, PageHeader, SectionLabel
- `components/kanban.jsx` — Kanban view
- `components/table.jsx` — Table view
- `components/other-views.jsx` — Timeline / Cards / Map
- `components/drawer.jsx` — Detail drawer
- `components/shell.jsx` — Sidebar, PageHeader, StatsBanner
- `components/sync-page.jsx` — Sync page (Overview / Connections / Activity)
- `components/resume-match.jsx` — Resume Match with AI round-trip
- `components/jd-breakdown.jsx` — JD Breakdown with Resume Tailor diff view
- `how-it-works.html` — Extension storyboard (4 scenes)
- `design-system.html` — Visual language reference

When in doubt about the look-and-feel, **the design-system page is canonical** — it's a curated subset of what the live product uses.
