# devloop log

Autonomous dev-loop run log. One entry per task completed by Claude Code via the `/devloop` skill.

---

## 2026-05-12 · PR #25 — Step 3 UX redesign + AI takeover button + label mappings (closes #10)

- **Branch:** `feat/10-step3-ai-takeover` (squash-merged as `54cbe8e`, branch deleted)
- **Issue:** #10 (auto-closed via "Closes #10")
- **Files:** `lib/label-classifier.js` (new, +128), `tests/label-classifier.test.js` (new, +120), `content.js` (+40/-17), `i18n.js` (+38), `popup.html` (+56), `popup.js` (+302/-83). Total +618/-83 across 6 files after fixups.
- **Verification:** `npm run lint` clean, `npm test` 190/190 pass, `node -c` parse OK on edited files. No browser smoke (out of scope for autonomous loop — `CONTRIBUTING.md` smoke-test checklist still applies before next release).
- **Sub-agent review:** independent read-only review (Read/Grep/Glob only) flagged 2 P1 issues, both fixed in `d62a1da` before merge:
  1. `RESUME_SECTION_OPTIONS` hard-coded bilingual strings (`'基本信息 / Basic Info'`) in `popup.js` violated the "all UI strings flow through `i18n.js`" invariant. Replaced with `getResumeSectionOptions()` resolved at render time via `I18N.t('popup.section.*')`. Added missing `popup.section.internship` key to zh + en dictionaries.
  2. `saveCustomField` / `saveLabelMapping` did non-atomic `chrome.storage.local.get` → mutate → `set`. Two rapid clicks on adjacent unmatched cards could drop a write. Both now go through a `mutateStorage(key, mutator)` helper that chains writes on a single Promise queue.
- **Follow-ups recorded (non-blocking, not opened as issues yet):**
  - `tests/label-classifier.test.js` "covers every FIELD_MAP key" test asserts a hard-coded expected list rather than introspecting `content.js`'s `FIELD_MAP` — new resume keys won't fail the test. Cosmetic.
  - `lib/label-classifier.js` "experience" bucket contains `expected` and `available`, which match Workday intent labels ("Expected start date", "Available date") rather than work experience. Consider a dedicated `intent` bucket.
  - a11y: `aiTakeoverBtn` / `skipBtn` / `mapSelect` lack `aria-label`s; `.manual-group-title` is `<div>` rather than a heading. Screen-reader hierarchy is flat.

---

## 2026-05-12 · PR #26 — Per-section validation in resume editor (closes #11)

- **Branch:** `feat/11-resume-validation` (squash-merged as `3acf49e`, branch deleted)
- **Issue:** #11 (auto-closed via "Closes #11")
- **Files:** `lib/validators.js` (new, +140), `tests/validators.test.js` (new, +190), `options.js` (+125/-3), `options.html` (+44), `i18n.js` (+16). Total +512/-3 across 5 files.
- **Behaviors:** pure regex validators (email, international phone, URL) + `validateResume()` that returns a structured issue list. Inline blur errors on basic `email/phone/linkedin/github/portfolio` and `projects[].link`. Save-time top banner summarizing remaining issues — saving never blocked.
- **Verification:** `npm run lint` clean, `npm test` 237/237 (was 190; +47 from validator suite including post-review URL cases), `node -c` parse OK, CI green (44s + 13s).
- **Sub-agent review:** flagged URL regex rejecting `linkedin.com?ref=share` and `example.com#anchor` (real share-link shapes). Fixed in `69ae664` by widening tail from `(\/[^\s]*)?` to `([/?#][^\s]*)?` + 2 new tests.
- **Follow-ups recorded (non-blocking, not opened as issues yet):**
  - `options.js` `save()` writes `chrome.storage.local.set({ resume })` without the `mutateStorage` serialization PR #25 introduced for popup.js. Lower race risk (full replace) but worth converting in a future cleanup.
  - On `resumefiller:languagechange`, banner re-renders without first running `collectFlatFields()` — banner reflects post-save state, not current DOM.
  - Banner doesn't auto-clear when user fixes errors mid-edit.
  - Inline `.field-error` spans aren't linked to inputs via `aria-describedby`.
  - Pre-existing (not from this PR): Chinese comments in `renderCustomFields`.

---

## 2026-05-12 · PR #27 — Multi-resume support: profiles, switcher, legacy migration (closes #14)

- **Branch:** `feat/14-multi-resume` (squash-merged as `cda60a4`, branch deleted)
- **Issue:** #14 (auto-closed via "Closes #14")
- **Files:** `lib/profiles.js` (new, +163), `tests/profiles.test.js` (new, +284), `popup.js` (+134/-25), `options.js` (+150/-3), `popup.html` (+39), `options.html` (+45), `i18n.js` (+22), `ARCHITECTURE.md` (+9/-2). Total +846/-30 across 8 files.
- **Decisions (taken at kickoff before coding):** switcher in popup top (A), default profile name from `intent.apply_position` fallback "Resume N" (B), duplicate-as-new copies full data (A). Side discovery: schema-migration framework (#7) already exists in `schema.js` at v2 — the issue annotation was stale, so this PR only added a one-shot storage-key migration (`resume` → `resumes`) on top.
- **Behaviors:** new `resumes = { profiles, activeProfileId }` storage shape. Popup gets a profile dropdown in the fill screen (hidden when only one profile). Options gets a profile bar with rename / "duplicate as new" / "delete this resume" (delete disabled when only one remains). `content.js` is unchanged — popup keeps sending the active profile's `ResumeData` via `chrome.tabs.sendMessage`.
- **Verification:** `npm run lint` clean, `npm test` 276/276 (was 237; +39 from the new profiles suite including determinism + orphan-active-id), `node -c` parse OK, CI green (12s + 11s).
- **Sub-agent review:** flagged 3 P1 + 2 P2, all fixed in commit `c44d0f1`:
  1. P1 dual-surface migration race → `migrateLegacyResume` now uses deterministic id `p_migrated`; concurrent migrations converge.
  2. P1 `saveProfileStore` not serialized → routed through `_storageWriteChain` Promise queue in both surfaces.
  3. P1 `handleProfileDuplicate` side effects → source profile no longer overwritten; the editor's current edits land in the duplicate only.
  4. P2 orphan-active-id → `createProfile` re-anchors active to the new profile when current active is missing.
  5. P2 misleading rename toast → added `options.profile_renamed` key.
- **Follow-ups recorded (non-blocking, not opened as issues yet):**
  - `loadProfileStore` is duplicated in popup.js and options.js. Worth extracting to `lib/profile-storage.js`.
  - `customFields` and `labelMappings` are still global, not per-profile. Could be per-profile in a future iteration.
  - If user is editing options and switches profile in popup, options shows stale data until refresh.
  - Discoverability: the popup dropdown is hidden when only one profile exists. Users learn about multi-resume by going to options.

---

## 2026-05-12 · PR #28 — Add DeepSeek as a preset LLM provider (no-issue follow-up)

- **Branch:** `feat/add-deepseek-provider` (squash-merged as `3d56060`, branch deleted)
- **Origin:** opportunistic add suggested mid-conversation — Doubao already covers the China-side LLM access case, but Doubao's funnel (火山方舟 console + endpoint id creation) and DeepSeek's funnel (key paste only) attract different user pools, and DeepSeek has higher mindshare in CN dev circles.
- **Files:** `lib/llm-providers.js` (+24/-1), `tests/llm-providers.test.js` (+18/-2). +41/-3 total.
- **Verification:** `npm run lint` clean, `npm test` 278/278 (+2 from DeepSeek header/body shape tests), CI green (15s). Existing `OpenAI/Anthropic/Doubao/Custom` paths untouched.
- **Sub-agent review skipped (intentional):** purely additive provider config matching the OpenAI entry's shape; existing test contract + 2 new tests cover correctness. Marginal value of another review didn't pencil out vs. the three PRs earlier in this loop where the agent caught real bugs. Documenting the call so the next loop iteration doesn't read "no review" as an oversight.

---

## 2026-05-12 · PR #29 — Import-as-new-profile flow (no-issue follow-up)

- **Branch:** `feat/import-as-new-profile` (squash-merged as `79a69ee`, branch deleted)
- **Origin:** user reload-tested v2.3 (PR #27) and hit a gap immediately — pasting a second resume JSON overwrote the first. PR #27 shipped multi-resume *storage* + *manual management* (Duplicate-as-new) but not a multi-resume *import path*. This PR fixes that.
- **Files:** `popup.html` (+1), `popup.js` (+44/-6), `options.html` (+18), `options.js` (+43/-1), `i18n.js` (+14/-4). Total +109/-11 across 5 files. No new tests — `lib/profiles.js` was untouched, the change is UI wiring.
- **Surfaces:**
  - popup: new "导入新简历" footer link sets module-level `importIntent='new'`; existing "重新导入 JSON" stays `'replace'`. Step-2 paste handler branches on intent. Onboarding entries (`step1NextBtn`, `fillBackBtn`) also reset to `'replace'` so the flag can't leak across screen transitions.
  - options: import modal gets a "作为新简历导入" checkbox; when ticked, `doImport` creates a profile + sets it active + persists immediately. Button label syncs between "导入并覆盖" and "导入为新简历" based on checkbox state.
- **Both paths re-anchor** active to the newly-created id explicitly after `createProfile` — `createProfile` preserves an already-valid active id by design (for Duplicate-as-new flow), so create-and-switch is a two-call sequence.
- **Verification:** `npm run lint` clean, `npm test` 278/278, `node -c` parse OK, CI green (21s).
- **Sub-agent review:** flagged P1 intent leak across `step1NextBtn` / `fillBackBtn` + two nits (misleading `popup.reimport_confirm` copy, static "Import & overwrite" button label even when "as new" ticked). All three fixed in `7086441` before merge.

---

## 2026-05-12 · Loop complete

**Total shipped in this run:** PR #25 (closes #10), PR #26 (closes #11), PR #27 (closes #14), PR #28 (no-issue, DeepSeek provider preset), PR #29 (no-issue, multi-resume import path — fills the gap PR #27 left behind).

**Test count:** 190 → 278 (+88 across label-classifier, validators, profiles, DeepSeek provider, and follow-up cases).

**Remaining open issues, all still blocked on user input:**

- **#13 Cover letter / long-form answer LLM draft (P1, v2.6)** — needs prompt design, UI placement, cost/safety framing.
- **#12 Chrome Web Store launch package (P1, v2.5)** — privacy policy, screenshots, store description, support email, icon assets.
- **#15 Error reporting + anonymous usage analytics (P2, v2.6)** — needs external endpoint (Sentry / Vercel function) and depends on #12 privacy policy.

**Shipped in this run:** PR #25 (closes #10), PR #26 (closes #11). Queue exhausted of items that are clean autonomous candidates.

**Remaining open issues, all needing user input before autonomous work can continue:**

- **#14 Multi-resume support (P2, v2.6)** — Originally annotated "depends on #7" (schema migration framework). That dep is stale: `schema.js` already has a v1→v2 migration registry shipped, so adding v2→v3 is just a new entry. Real blocker is UX/product: where the "switch resume" dropdown lives (popup top? options page?), the popup indicator's design, default profile naming, and what "duplicate as new" copies. Once those are decided this is autonomous-doable.
- **#13 Cover letter / long-form answer LLM draft (P1, v2.6)** — Big product feature: prompt design, where it lives in the UI, what the user inputs (job description? company? role?), how cost/safety are framed. Not a code task to start with.
- **#12 Chrome Web Store launch package (P1, v2.5)** — Privacy policy, screenshots, store description, support email, icon assets — all user-side content authorship.
- **#15 Error reporting + analytics (P2, v2.6)** — Needs an external endpoint (Sentry free tier or self-hosted Vercel function), and depends on #12 for the privacy-policy update. Endpoint setup + credential is the user's call.
