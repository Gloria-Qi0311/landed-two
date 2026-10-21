// `landed fill-trace <ref>` prints a fill trace as text
// (packages/schema/src/fill-trace.ts): the page, the totals, each phase and
// model call, and every field with its value's source or why it was left. A
// sensitive field shows as hidden even if a value slipped into the upload.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatFillTrace, normalizeFillTraceRef, parseFillTrace } from '@landed/schema/fill-trace'

const raw = {
  v: 1, ref: 'k7q2mx', at: '2026-10-21T20:03:00Z', via: 'assist', extension: '2.8',
  page: { url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Product-Analyst', title: 'Product Analyst' },
  resume: { id: 'r1', name: 'Alex Chen resume' },
  result: { filled: 1, review: 2, fields: 3, missing_files: ['resume'], unanswered: 1, blocker: null, agent_review: { checked: 2, fixed: 0, flagged: 1, left_out: 1, model: 'claude', error: null } },
  outcome: { status: 'blocked', blocker: { kind: 'review', message: '1 field was flagged by the agent' }, at: '2026-10-21T20:04:00Z' },
  frames: [{
    url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Product-Analyst', top: true, ms: 4200, fields_on_page: 3,
    phases: [{ name: 'resume', ms: 120, filled: 1 }, { name: 'model', ms: 2300, filled: 0 }],
    models: [{ kind: 'match_fields', asked: 1, answered: 0, model: 'qwen3.5:4b', error: null, ms: 2300 }],
    fields: [
      { id: 'landed-1', kind: 'text', question: 'Email', status: 'filled', source: 'resume', value: 'alex.chen@example.com', note: 'check this: looks like a personal address' },
      { id: 'landed-2', kind: 'select', question: 'Gender', status: 'review', source: '', hidden: true, value: 'leaked', reason: 'sensitive: left to you' },
      { id: 'landed-3', kind: 'text', question: 'How did you hear about us?', status: 'review', source: '', reason: 'needs a saved answer' },
    ],
    unanswered: ['How did you hear about us?'],
    blocker: null,
  }],
}

test('refs: any case, O for 0 and I/L for 1; nothing else', () => {
  assert.equal(normalizeFillTraceRef('k7q2mx'), 'K7Q2MX')
  assert.equal(normalizeFillTraceRef(' 0OIL1A '), '00111A')
  assert.equal(normalizeFillTraceRef('K7Q2M'), null)
  assert.equal(normalizeFillTraceRef('K7Q2MU'), null, 'U is not a ref character')
  assert.equal(normalizeFillTraceRef(undefined), null)
})

test('a trace as text: page, totals, review, outcome, phases, model calls, fields', () => {
  const trace = parseFillTrace(raw)
  assert.ok(trace)
  const text = formatFillTrace(trace)
  assert.match(text, /^Fill K7Q2MX · 2026-10-21T20:03:00\.000Z · via assist · extension 2\.8/)
  assert.match(text, /Result: 1 filled · 2 need review · 3 fields on the page · 1 questions to ask · no saved file: resume/)
  assert.match(text, /Review by claude: 2 checked · 0 changed · 1 flagged · 1 sensitive not sent/)
  assert.match(text, /Outcome: blocked — review: 1 field was flagged by the agent/)
  assert.match(text, /Phases: resume 0\.1s \+1 · model 2\.3s/)
  assert.match(text, /Model match_fields: asked 1, answered 0 · qwen3\.5:4b · 2\.3s/)
  assert.match(text, /! Email \[text #landed-1\] — "alex\.chen@example\.com" — from resume — review: check this: looks like a personal address/)
  assert.match(text, /\? Gender \[select #landed-2\] — \(hidden: sensitive\) — left for you: sensitive: left to you/)
  assert.match(text, /\? How did you hear about us\? \[text #landed-3\] — \(empty\) — left for you: needs a saved answer/)
  assert.doesNotMatch(text, /leaked/)
})

test('not a trace: no ref, or too big', () => {
  assert.equal(parseFillTrace({ ...raw, ref: 'nope' }), null)
  assert.equal(parseFillTrace(null), null)
  const huge = { ...raw, frames: Array.from({ length: 10 }, () => ({ ...raw.frames[0], fields: Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, kind: 'text', question: 'Q'.repeat(200), status: 'filled', source: 'resume', value: 'v'.repeat(200) })) })) }
  assert.equal(parseFillTrace(huge), null)
})
