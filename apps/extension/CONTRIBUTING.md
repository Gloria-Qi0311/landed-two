# Contributing

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first — it explains the four-layer extension structure and the seven-phase fill pipeline that most issues touch.

## Local setup

```bash
git clone https://github.com/AntaresYuan/resume-filler.git
cd resume-filler
npm install
```

Load the extension into Chrome:

1. Visit `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select the repo root
4. Click the extension icon to open the side panel

When you change source files, click the circular reload icon on the extension card (or hit `Ctrl/Cmd+R` on `chrome://extensions`) before reloading the test page.

> **Note:** `node_modules/` lives at the repo root and Chrome will scan it when loading the unpacked extension — this slows the load but does not break it. We deliberately don't ship a build step (see #1). If load time becomes painful, run `rm -rf node_modules` before loading and `npm install` again before running tests.

## Daily commands

```bash
npm test           # Jest, all tests in tests/
npm run test:watch # Jest in watch mode
npm run lint       # ESLint (CI gates on this)
npm run lint:fix   # autofix lint issues
```

CI runs `npm run lint` and `npm test` on every PR (`.github/workflows/ci.yml`). PRs cannot merge if either fails.

## Branch + PR flow

One PR per issue.

```bash
git checkout main
git pull origin main
git checkout -b feat/<issue-number>-<short-slug>     # e.g. feat/3-extract-field-detect
# … work, commit …
git push -u origin <branch>
gh pr create
```

The PR title should match the issue title; the body should `Closes #<n>` so GitHub auto-closes the issue on merge. Use the existing PR for #1 (`#16`) as a template.

### Commit messages

```
<short imperative summary, ≤72 chars>

<optional body explaining "why" — what motivates this change. The diff
already shows "what". Wrap at ~72 chars.>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

The `Co-Authored-By` line is included when Claude Code authors a commit. Drop it if you wrote the commit by hand.

## Required smoke test (before merging anything that touches `*.js` or `*.html`)

CI does not test the extension end-to-end. Before merging UI/filler changes:

1. Reload the extension at `chrome://extensions`
2. Open the side panel, paste a sample resume JSON (any valid one — see `tests/schema.test.js` for shape examples), confirm step 2 transitions to step 3
3. Open a real ATS application page (Greenhouse is the easiest baseline — try [Anthropic Careers](https://www.anthropic.com/jobs), Stripe, OpenAI, Coinbase). Click an open role's apply button.
4. Click **Fill** in the side panel
5. Verify: name / email / phone fill correctly; education and experience entries populate; the unmatched-fields list in step 3 looks reasonable

Pure docs changes can skip this.

For deeper changes (#3, #4, #5, #9, #10), test on at least one Workday + one Greenhouse + one Lever page.

After #5 lands, the fixture-based integration tests will replace most of this manual loop. Until then it's required.

## Adding a new field-detection rule (the most common contribution)

Use case: a real form has a label that ApplyMint doesn't recognize. The fix has two parts.

### Step 1: capture the failure

Open a `Field-detection failure` issue using the template. Include:
- Form URL
- Failure type (skipped / mis-filled / etc.)
- The exact label text
- The DOM `outerHTML` of the input (use `$0.outerHTML` after right-click → Inspect)
- The expected resume key (e.g. `basic.email`)

### Step 2: extend `FIELD_MAP`

`content.js` line ~4. Each entry has the shape:

```js
{ keys: ['english_keyword', 'another_variant', '中文关键词'], resumeKey: 'email' }
```

- `keys` is matched after `normalize()` (lowercase, whitespace/punct stripped) — write entries in their normalized form
- Include the CJK variant alongside English — `matchResumeKey` switches strategies based on label language
- Order matters within `FIELD_MAP`: more-specific rules go first. The generic `name` rule is intentionally late, with context blocking for "first/last name" and "company/school name"

### Step 3: add a test

`tests/schema.test.js` covers schema; field-detection tests will live in `tests/field-detect.test.js` after #3 extracts the module. Until then, document the case as a fixture entry that #5 will pick up: save the relevant DOM snippet to a future location at `tests/fixtures/ats/<ats>/<company>-<role>.html` and note the expected key in your PR description.

### Step 4: smoke test on the original site

Reload the extension on the URL from the issue. Confirm the field now fills.

## Style conventions

- **English only** for code, comments, commit messages, README, and all GitHub artifacts. The exception is i18n string values inside `i18n.js` dictionaries, which carry user-facing text in their target language.
- **No drive-by refactors** in feature PRs. If you spot lint debt or dead code unrelated to the issue, open a separate `chore` issue rather than mixing it in.
- **Comments only when WHY is non-obvious.** A subtle invariant, a workaround for a specific browser bug, an intentional ordering decision — yes. Restating what the code does — no.
- **No new dependencies without discussion.** The extension ships unbundled; every dependency adds review surface and load weight. Open an issue first.
- **No `chrome.*` API additions to `manifest.json` permissions** without discussion. The current set (`activeTab`, `storage`, `scripting`, `sidePanel`) is deliberately minimal for store review.

## Reporting bugs

Use the GitHub issue templates:

- **Bug report** — general defects
- **Field-detection failure** — site-specific fill problems (preferred for any issue tied to a URL)
- **Feature request** — new capabilities

For ATS-specific issues, also apply the relevant label: `ats:workday`, `ats:greenhouse`, `ats:lever`.

## Roadmap

Active work is tracked under [milestones](https://github.com/AntaresYuan/resume-filler/milestones) v2.3 → v2.6. The roadmap is shaped by the cross-border positioning described in [`ARCHITECTURE.md`](./ARCHITECTURE.md) — features that don't serve cross-border applicants typically get deferred or declined.
