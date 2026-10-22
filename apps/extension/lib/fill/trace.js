// @ts-check
// lib/fill/trace.js — what one fill did, so a bad fill can be traced to the
// rule or model call behind it: each phase (how long, how many fields it
// filled), each model call (asked, answered, which model, errors), and every
// field Landed touched: its question, status, where its value came from and
// the value, or why it was left for the user. Sensitive questions and
// passwords carry no value, only whether they were filled. The service worker
// adds the page and resume, gives it a ref and keeps it
// (lib/fill-trace-store.js); packages/schema/src/fill-trace.ts is the shape.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill (looked up when called, so the load order doesn't matter).
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});

/** Why a field was left for the user, from addManual's hint. */
const REASONS = {
  '需要申请资料': 'needs a saved answer',
  '文件上传': 'file upload: no saved file, or the page did not take it',
  '敏感信息': 'sensitive: left to you',
  '下拉框': 'no option matched',
  '自定义下拉框': 'no option matched in the dropdown',
  '富文本': 'rich-text editor: left to you',
  '开放题': 'open-ended: no answer from your agent',
  '选择题': 'choice question with no saved answer',
  '日期': 'date not filled',
  '多条目': 'entry field not filled',
  '未匹配': 'no rule matched the label',
  '复核已改': 'the review changed it',
  '复核存疑': 'the review flagged it',
};

const MAX_FIELDS = 300;

/** @type {{ started: number, last: number, lastFilled: number, phases: any[], models: any[] } | null} */
let current = null;

const filledNow = () => F.deepAll('[data-landed-status="filled"]').length;

function startTrace() {
  const now = Date.now();
  current = { started: now, last: now, lastFilled: filledNow(), phases: [], models: [] };
}

/** A phase ended: its time and the fields it filled. */
function tracePhase(name) {
  if (!current) return;
  const now = Date.now();
  const filled = filledNow();
  current.phases.push({ name, ms: now - current.last, filled: Math.max(0, filled - current.lastFilled) });
  current.last = now;
  current.lastFilled = filled;
}

/** A model call: what it was asked, what came back. */
function traceModel(kind, { asked = 0, answered = 0, model = null, error = null, ms = 0 } = {}) {
  if (current) current.models.push({ kind, asked, answered, model, error, ms });
}

function kindOf(el) {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file') return el.type;
    return 'text';
  }
  if (el instanceof HTMLTextAreaElement) return 'text';
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') return 'rich';
  if (F.isCustomComboboxTrigger(el)) return 'combobox';
  return 'other';
}

function valueOf(el, kind, group, question) {
  if (kind === 'radio') {
    const picked = (group || [el]).find((r) => r.checked);
    return picked ? F.optionText(picked) : '';
  }
  if (kind === 'checkbox') return el.checked ? 'checked' : '';
  if (kind === 'file') return el.files && el.files.length ? `(file) ${el.files[0].name}` : '';
  if (kind === 'select') return el.value && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.replace(/\s+/g, ' ').trim() : '';
  if (kind === 'combobox') return F.existingComboboxTexts(el, question)[0] || '';
  if (kind === 'rich') return (el.textContent || '').replace(/\s+/g, ' ').trim();
  return 'value' in el ? String(el.value || '') : '';
}

function sensitive(question, el) {
  return (el instanceof HTMLInputElement && el.type === 'password') || F.neverSent(question) || F.isSensitiveLabel(question);
}

/** This frame's trace: the phases and model calls so far, and every field
 *  Landed marked green or yellow. */
function finishTrace({ manual = [], unanswered = [], blocker = null, fields = 0 } = {}) {
  if (!current) startTrace();
  const t = /** @type {NonNullable<typeof current>} */ (current);
  current = null;
  const { getFieldLabel } = global.ResumeFillerFieldDetect;
  const hints = new Map(manual.map((m) => [m.id, m.hint]));
  const radioGroup = new Map();
  for (const group of F.groupChoices(F.deepAll('input[type="radio"]'))) for (const el of group) radioGroup.set(el, group);
  const seen = new Set();
  const out = [];
  for (const el of F.deepAll('[data-landed-field-id]')) {
    const status = el.getAttribute('data-landed-status');
    if (status !== 'filled' && status !== 'review') continue;
    const kind = kindOf(el);
    const group = kind === 'radio' ? radioGroup.get(el) || [el] : null;
    if (group) {
      if (seen.has(group)) continue;
      seen.add(group);
    }
    const members = group || [el];
    const attr = (name) => members.map((m) => m.getAttribute(name)).find(Boolean) || '';
    const question = ((group && F.choiceGroupQuestion(group)) || getFieldLabel(el) || el.getAttribute('aria-label')
      || (kind === 'checkbox' ? F.optionText(el) : '') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim();
    if (!question) continue;
    const field = {
      id: el.getAttribute('data-landed-field-id') || '',
      kind,
      question: question.slice(0, 200),
      status: members.some((m) => m.getAttribute('data-landed-status') === 'review') ? 'review' : 'filled',
      source: attr('data-landed-source'),
    };
    const value = valueOf(el, kind, group, question);
    if (sensitive(question, el)) field.hidden = true;
    else if (value) field.value = value.slice(0, 200);
    const note = attr('data-landed-note');
    if (note) field.note = note.slice(0, 300);
    const hint = members.map((m) => hints.get(m.getAttribute('data-landed-field-id'))).find(Boolean);
    if (hint) field.reason = REASONS[hint] || hint;
    out.push(field);
    if (out.length >= MAX_FIELDS) break;
  }
  return {
    url: location.origin + location.pathname,
    top: window.top === window,
    ms: Date.now() - t.started,
    fields_on_page: fields,
    phases: t.phases,
    fields: out,
    models: t.models,
    unanswered: unanswered.map((q) => String((q && q.question) || '').slice(0, 200)).filter(Boolean).slice(0, 50),
    blocker: blocker ? { kind: String(blocker.kind || ''), message: String(blocker.message || '').slice(0, 300) } : null,
  };
}

Object.assign(F, { startTrace, tracePhase, traceModel, finishTrace });
})(typeof window !== 'undefined' ? window : globalThis);
