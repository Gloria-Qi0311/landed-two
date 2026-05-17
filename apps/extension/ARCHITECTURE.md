# Architecture

This is the file to read first when picking up work on ApplyMint — across sessions, after a break, or as a new contributor. It maps the codebase, the runtime data flow, and the conventions that aren't obvious from any single file.

## Product positioning (one paragraph)

ApplyMint targets **cross-border job seekers** (China ↔ US primarily): Chinese resume needs to fill English forms or vice versa, names need to be split across First/Last fields, degrees and institutions need bilingual mapping. The fill engine is **rule-based by default** with planned **optional LLM fallback** (user brings their own API key). The product ships on the **Chrome Web Store**; Safari is explicitly not supported. Side panel UI is non-negotiable — popup-only fallback is unacceptable for the multi-step fill workflow.

## Four layers

```
┌───────────────────────────────────────────────────────────┐
│ manifest.json     declares MV3, sidePanel, content scripts│
└───────────────────────────────────────────────────────────┘
              │                         │
              ▼                         ▼
┌──────────────────────┐    ┌──────────────────────────────┐
│ background.js        │    │ Content scripts (per page):  │
│ service worker       │    │   schema.js  ◄── must load   │
│ opens side panel     │    │   content.js   first         │
│ on icon click        │    │ Listens for {action:'fill'}  │
└──────────────────────┘    └──────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│ UI surfaces (chrome.runtime + chrome.storage):           │
│   popup.html / popup.js   — side panel (3-step wizard)   │
│   options.html / options.js — full resume editor         │
│   i18n.js                  — zh/en localization layer    │
└──────────────────────────────────────────────────────────┘
```

## Module reference

| File | LOC | Responsibility | Public API exposed |
|---|---|---|---|
| `manifest.json` | 33 | MV3 manifest. Declares `sidePanel`, `content_scripts` (schema.js loads before content.js — load order matters), `options_page`, permissions (`activeTab`, `storage`, `scripting`, `sidePanel`). | — |
| `background.js` | 6 | Service worker. Single responsibility: open side panel on `chrome.action.onClicked`. | — |
| `schema.js` | 244 | Resume JSON schema, normalization, legacy-flat-schema upgrade, flatten-for-fill. Pure JS, no DOM. IIFE attaches to `window` (or `globalThis`). | `RESUME_SCHEMA`, `blankEntry`, `emptyResume`, `normalizeResume`, `isResumeFilled`, `flattenResumeForFill` |
| `content.js` | 803 | Page DOM scan + form filling. **No IIFE, no exports** — symbols are private to file scope (this is why it's not directly testable; see #3). Registers a top-level `chrome.runtime.onMessage` listener. | message handler for `{action:'fill'}` and `{action:'ping'}` |
| `popup.js` / `popup.html` | 396 / 770 | Side panel UI: 3-step wizard (copy LLM prompt → paste JSON → fill on current tab). Reads/writes `chrome.storage.local`. Sends `{action:'fill'}` via `chrome.tabs.sendMessage`. | — |
| `options.js` / `options.html` | 459 / 907 | Full resume editor. Section-based form rendering. Same storage keys as popup. | — |
| `i18n.js` | 501 | Localization (`zh` default, `en`). Reads `chrome.storage.local.uiLang`, falls back to `localStorage`. Exposes `window.ResumeFillerI18n` with `t(key, params)`, `setLang()`, `applyText(root)`. | `window.ResumeFillerI18n` |

## Data flow (end-to-end fill)

```
User action                 Popup (UI)                Content script        Page DOM
───────────                 ──────────                ──────────────        ────────

Step 1: copy LLM prompt ──► popup.js reads i18n
                            shows prompt template

         User pastes resume into ChatGPT/Claude externally,
         pastes returned JSON back into popup step 2

Step 2: paste JSON ───────► popup.js
                            normalizeResume(input)
                            chrome.storage.local
                              .set({ resume })

Step 3: click "Fill" ─────► popup.js reads
                              { resume, customFields }
                            from chrome.storage
                            chrome.tabs.sendMessage(
                              tabId,
                              { action:'fill',
                                resume, customFields })──► onMessage listener
                                                            handleFill(resume, cf)
                                                            flattenResumeForFill(resume)
                                                            ┌─ Phase 1 ─► fill text inputs ──► DOM
                                                            ├─ Phase 2 ─► fill <select> ──────► DOM
                                                            ├─ Phase 3 ─► fill comboboxes ────► DOM
                                                            ├─ Phase 4 ─► report contented... (no fill)
                                                            ├─ Phase 5 ─► fill dates +
                                                            │            multi-entry sections ─► DOM
                                                            └─ Phase 7 ─► apply user-saved
                                                                          custom mappings ────► DOM
                                                            return { filled, manual }
                            ◄─────────────── response ────
                            popup.js renders unmatched
                            list (manual array) for
                            user decision
```

## `content.js` fill pipeline (the heart of the project)

`handleFill(resumeData, customFields)` runs phases sequentially. Phase numbers in source are historical (Phase 6 was merged into Phase 5; there is no Phase 6 in code).

| Phase | What it does | Key functions |
|---|---|---|
| **1. Text inputs** | Iterates visible `input` / `textarea`, calls `matchResumeKey()` to map label → resume key, fills via `fillField()`. Skips date-typed inputs (handled in Phase 5). | `getVisibleInputs`, `fillInputBatch`, `matchResumeKey`, `fillField` |
| **2. Native `<select>`** | For each visible `<select>` that isn't a year/month picker, fuzzy-match resume value to an option. | `tryFillSelect` |
| **3. Combobox / custom dropdown** | Targets `[role="combobox"]`, `[aria-haspopup="listbox"]`, `[aria-haspopup="true"]`. Async — clicks the trigger, waits for options to render, picks the matching one. | `tryFillCombobox`, `doClick`, `findCustomDateTriggers` |
| **4. Contenteditable / `[role="textbox"]`** | Currently **only reports** these as `manual` (does not fill). Rich-text auto-fill is unsafe today. | (inline in `handleFill`) |
| **5. Dates + multi-entry sections** | The most complex. For each section in `MULTI_ENTRY_SECTIONS` (experience / internship / education / projects), locates the section container, fills year/month split selects, custom date pickers, and "currently working/studying" checkboxes; clicks "+" to add additional entries. | `fillAllSectionDates`, `fillYearSelect`, `fillMonthSelect`, `findAddButtonForSection`, `waitForNewInputs`, `commonAncestor` |
| **7. User-saved custom fields** | Exact label-match against `customFields` (keys saved by the user from previous step-3 decisions). Applied last so user overrides win. | (inline in `handleFill`) |

Returns `{ filled: string[], manual: {label, hint, value}[] }` — popup.js renders the `manual` array as the unmatched-fields decision UI.

## Field detection (Phase 1-3 backbone)

`matchResumeKey(el)` is the most-touched function. Pipeline:

1. `getFieldLabel(el)` — walks up looking at, in order: `<label for>`, ancestor `<label>`, `aria-label`, `aria-labelledby`, parent text, `placeholder`, `name`, `id`. CJK-aware.
2. `normalize()` collapses whitespace/punct/case for Latin labels; `normalizeSpaced()` preserves word boundaries.
3. `isCJKKey()` switches to character-level CJK matching when the label is Chinese.
4. Iterates `FIELD_MAP` (declarative table at top of `content.js`); first hit wins. **Special rule**: the generic `name` mapping is blocked when context indicates "first/last/given/family name" or "company/school/project name" (avoids mis-mapping).

This whole subsystem will be extracted to `lib/field-detect.js` in #3 to make it unit-testable and to expose a `registerFallback()` hook for the LLM matcher (#9).

## Storage schema (`chrome.storage.local`)

| Key | Shape | Written by | Read by |
|---|---|---|---|
| `resumes` | `{ profiles: { [id]: { id, name, data: ResumeData } }, activeProfileId: string }` — multi-resume store introduced in #14 | popup.js, options.js | popup.js (fill — uses active profile), options.js (editor — edits active profile) |
| `resume` (legacy) | `ResumeData` — pre-#14 single-resume shape. Auto-migrated into `resumes` on first load by popup or options, then removed. Never written after migration. | (none, post-migration) | (migration path only) |
| `customFields` | `{ [section]: { [label]: value } }` — user-confirmed label→value mappings from step 3. Currently global (not per-profile). | popup.js, options.js | popup.js (sends to content.js), options.js (editor) |
| `labelMappings` | `{ [label]: resumeKey }` — user-confirmed label→resume-field mappings from step 3 (added in #10). Currently global. | popup.js | content.js (Phase 7) |
| `uiLang` | `"zh" \| "en"` | i18n.js | i18n.js |
| `aiSettings` | `{ enabled, provider, apiKey, model }` (#8) | options.js | popup.js, content.js |

`RESUME_SCHEMA.version` (the in-resume schema) is at v2 with a migration registry in `schema.js` that ran v1→v2 to backfill `englishName` / `chineseName`. The multi-resume store shape is a separate, one-shot storage-key migration (`resume` → `resumes`) handled by `loadProfileStore` in popup.js and options.js; both surfaces are race-safe because `migrateLegacyResume` uses a deterministic profile id (`p_migrated`).

## Key invariants

- **`schema.js` must load before `content.js`.** Enforced by `manifest.json`'s `content_scripts.js` array order. `content.js` calls `window.flattenResumeForFill` and `window.normalizeResume` at runtime.
- **`content.js` runs on `<all_urls>` at `document_idle`.** Don't add work to top-level scope beyond the `onMessage` listener — anything heavier slows every page load.
- **No bundler, no TypeScript.** Files load as-is from the unpacked extension directory. `package.json` exists only for dev dependencies (Jest, ESLint).
- **No directory or filename may start with `_`** — Chrome MV3 reserves `_` prefixes. Tests live under `tests/` (not the Jest default `__tests__/`); fixtures will live under `tests/fixtures/` (not `__fixtures__/`).
- **All UI strings flow through `i18n.js`.** Don't hard-code `zh` or `en` strings in `popup.js` / `options.js` — add a key to both dictionaries in `i18n.js` and reference it via `I18N.t('key')` or a `data-i18n` attribute.
- **`innerHTML` writes must escape via `escapeHtml()`.** Each call site is annotated with `eslint-disable-next-line no-unsanitized/property` plus a one-line justification.

## Where things will move (forward-looking)

| Today | Future home (issue) |
|---|---|
| `FIELD_MAP`, `matchResumeKey`, `getFieldLabel`, `normalize*` (in `content.js`) | `lib/field-detect.js` (#3) |
| `tryFillSelect`, `tryFillCombobox` value-matching logic | `lib/value-match.js` (#4) |
| Bilingual name / degree / school / company mapping (does not exist yet) | `lib/cross-lingual.js` (#6) |
| `RESUME_SCHEMA.version` migration (does not exist yet) | `schema.js` `migrations/` registry (#7) |
| LLM fallback (does not exist yet) | `lib/llm-match.js` (#9), wired through #3's `registerFallback()` |

If you're modifying anything in the "Today" column, check the linked issue first — there may be in-progress refactor work that would conflict.
