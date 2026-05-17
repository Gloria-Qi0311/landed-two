# ATS fixtures

Real-page DOM snapshots that drive both the integration tests
(`tests/integration/ats-benchmark.test.js`) and the `npm run benchmark`
accuracy report.

## Why this exists

CI cannot navigate to a live ATS application page. Instead, we
freeze the DOM at apply-page load time, redact PII, and check it in.
Every captured fixture becomes a permanent regression test for that
ATS — when a future change to `content.js` or any `lib/*.js` module
breaks fill on that page, the test goes red on the next PR.

The collection also doubles as our **private benchmark library** —
`npm run benchmark` reports per-ATS accuracy that can be cited in
the store listing or marketing material.

## Capture process

1. Open the apply page in Chrome (use a job you'd never actually
   apply to — e.g. find a role at a company whose ATS you want to
   cover, click Apply, but **don't submit**).
2. F12 → **Elements** tab → right-click the `<html>` node →
   **Copy** → **Copy outerHTML**.
3. Paste into `tests/fixtures/ats/<ats>/<company>-<role-slug>.html`.
   - Examples: `tests/fixtures/ats/workday/salesforce-pm.html`,
     `tests/fixtures/ats/greenhouse/stripe-swe.html`,
     `tests/fixtures/ats/lever/netflix-data.html`.
4. **Redact** anything personal in the HTML before committing
   (search for your name, email, phone, address, any pre-filled
   account info, hidden CSRF / session tokens).
5. Create a sibling `.expected.json` describing what filling
   `tests/fixtures/sample-resume.json` should produce on this page.
   See [Expected JSON shape](#expected-json-shape) below.
6. Run `npm test` — the integration runner will pick up the fixture
   automatically. Run `npm run benchmark` to see the accuracy table.

## File layout

```
tests/fixtures/
├── sample-resume.json              ← shared resume; do not duplicate
├── README.md                       ← this file
└── ats/
    ├── example/                    ← synthetic fixtures (kept for
    │                                  framework smoke tests; do not
    │                                  delete)
    ├── workday/
    ├── greenhouse/
    ├── lever/
    └── ashby/
```

One `.html` + one `.expected.json` per fixture. Slugify file names
so they sort cleanly: `<company>-<role-slug>.{html,expected.json}`.

## Expected JSON shape

```json
{
  "description": "Stripe Senior SWE — single-page Greenhouse form",
  "url_at_capture": "https://job-boards.greenhouse.io/stripe/jobs/...",
  "captured_at": "2026-05-09",
  "notes": "Optional: any quirks in this page worth flagging",
  "expected_fills": {
    "basic.email": "alice.wong@example.com",
    "basic.firstName": "Alice",
    "basic.lastName": "Wong",
    "basic.phone": "+1-415-555-0123",
    "education[0].school": "Stanford University",
    "experience[0].company": "Stripe"
  },
  "expected_unmatched": [
    "Are you authorized to work in the US?",
    "How did you hear about this role?"
  ]
}
```

- `expected_fills`: keys are dotted paths into `sample-resume.json`.
  The runner extracts the resume value at that path, finds the form
  field that matched it, and asserts the field's value equals the
  resume value (or the cross-lingual translation of it). One key
  per assertion; missing fields fail the test for that fixture.
- `expected_unmatched` (optional): labels that should land in the
  Step-3 manual list. The runner confirms every entry actually
  appeared. Use sparingly — these tend to drift.

## Redaction rules

Before committing a fixture:

- Search the HTML for your real name, email, phone — replace with
  `Test User`, `test@example.com`, `+1-555-0100`.
- Strip any `value=` attributes on inputs that already had your
  data prefilled (the page might have remembered you).
- Strip CSRF tokens, session IDs, OAuth `state` params, anything
  in `<script>` blobs that looks like a token.
- Strip any inline analytics scripts (Segment, Mixpanel, etc.) —
  they balloon file size without aiding the test.
- The fixture only needs to render and contain the form. It does
  not need to be a perfect snapshot.

If you're not sure whether something is sensitive, redact it.

## Naming for the benchmark report

The per-ATS accuracy table groups by the parent directory name
(`workday`, `greenhouse`, etc.). Don't put fixtures directly in
`tests/fixtures/ats/`; they need to live in an ATS-named subfolder
to get counted.
