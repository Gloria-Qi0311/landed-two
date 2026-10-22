// @ts-check
// lib/fill/review.js — after a fill, the user's own agent checks it. The fill
// report (each field's question, the value now in it, where that value came
// from, and the options of choice fields) goes to the native host with the
// candidate's facts: saved answers and resume values, keyed. A fix comes back
// as a fact key (the host supplies that fact's value) or an option index, so
// the reviewer never writes text. Changed fields turn yellow with the reason.
// Values from the user's saved answers, saved fields or the page itself are
// only flagged, never replaced. Sensitive questions (voluntary EEO, date of
// birth, ID numbers, salary, consent) are never sent. Never clicks Submit.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { addManual, choiceGroupQuestion, clickChoice, deepAll, existingComboboxTexts, fillField, groupChoices, isCustomComboboxTrigger, markField, optionText, setSelectOption, tryFillCombobox } = F;
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

// ─── where each filled value came from ────────────────────────────────────
//   answers  saved application answers      resume  the resume, by rule
//   entries  experience / education rows    saved   custom fields, learned mappings
//   model    the local model                page    there before Landed
//   file     an uploaded file

function setSource(el, source) {
  if (el && el.setAttribute && !el.hasAttribute('data-landed-source')) el.setAttribute('data-landed-source', source);
}

/** Every filled field without a source yet came from `source`. */
function tagFilled(source) {
  for (const el of deepAll('[data-landed-status="filled"]:not([data-landed-source])')) el.setAttribute('data-landed-source', source);
}

// ─── what the reviewer sees ───────────────────────────────────────────────

const NEVER_SENT_KINDS = new Set(['gender', 'race', 'hispanic_latino', 'veteran', 'disability', 'date_of_birth', 'consent']);
const NEVER_SENT_WORDS = /gender|\bsex\b|pronoun|\brace\b|ethnic|hispanic|latino|disabilit|veteran|birth|social security|\bssn\b|passport|national id|salary|compensation|desired pay|pay expectation|consent|agree|certif|acknowledg|terms|privacy|性别|种族|族裔|民族|残疾|残障|退伍|出生|身份证|护照|薪|同意|声明/i;

/** Questions the reviewer never sees, whatever the answer. */
function neverSent(question) {
  return NEVER_SENT_WORDS.test(question) || NEVER_SENT_KINDS.has(CA.classify(question));
}

/** Only these may be replaced; the user's own values are only flagged. */
const REPLACEABLE = new Set(['resume', 'model', '']);
const NOT_REVIEWED = new Set(['entries', 'file']);
const LONG_TEXT_KEYS = new Set(['job_description', 'project_description', 'summary']);
// Not previously_employed: a saved yes/no can't say it for every company;
// the resume's employers do (resume.employers).
const YES_NO_KEYS = ['work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations', 'non_compete', 'talent_network', 'adult', 'onsite'];

/** Saved answers and resume values the reviewer may point to, keyed
 *  `answers.<kind>` / `resume.<key>`. Sensitive ones stay out. */
function reviewFacts(answers, flat) {
  const facts = {};
  const put = (key, value) => {
    if ((typeof value === 'string' && value.trim()) || typeof value === 'number') facts[key] = String(value).trim().slice(0, 500);
  };
  if (answers) {
    for (const [kind, value] of Object.entries(CA.answerFlat(answers))) {
      if (!neverSent(kind.replace(/_/g, ' '))) put(`answers.${kind}`, value);
    }
    for (const kind of YES_NO_KEYS) {
      const v = answers[kind];
      put(`answers.${kind}`, v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v);
    }
  }
  for (const [key, value] of Object.entries(flat || {})) {
    if (key.startsWith('_') || LONG_TEXT_KEYS.has(key) || neverSent(key.replace(/_/g, ' '))) continue;
    put(`resume.${key}`, value);
  }
  if (Array.isArray(F.employers) && F.employers.length) put('resume.employers', `${F.employers.slice(0, 15).join('; ')} (the only employers they have worked for)`);
  return facts;
}

/** @typedef {{ id: string, kind: 'radio' | 'select' | 'combobox' | 'text', el: any, group?: HTMLInputElement[], question: string, value: string, source: string, options?: string[] }} ReviewItem */

/** The fill report for this frame: every field Landed touched that the
 *  reviewer may see. `leftOut` counts the sensitive ones. */
function fillReport() {
  const radioGroup = new Map();
  for (const group of groupChoices(deepAll('input[type="radio"]'))) for (const el of group) radioGroup.set(el, group);
  /** @type {ReviewItem[]} */
  const items = [];
  const seenGroups = new Set();
  let leftOut = 0;
  for (const el of deepAll('[data-landed-field-id]')) {
    const status = el.getAttribute('data-landed-status');
    if (status !== 'filled' && status !== 'review' && status !== 'blank') continue;
    const id = el.getAttribute('data-landed-field-id');
    /** @type {Omit<ReviewItem, 'id'> | null} */
    let item = null;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const group = radioGroup.get(el) || [el];
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      const options = group.map(optionText);
      const picked = group.find((r) => r.checked);
      const source = group.map((r) => r.getAttribute('data-landed-source')).find(Boolean) || '';
      item = { kind: 'radio', el, group, question: choiceGroupQuestion(group) || options[0] || '', value: picked ? optionText(picked) : '', source, options };
    } else if (el instanceof HTMLInputElement && ['checkbox', 'file', 'hidden', 'password', 'submit', 'button'].includes(el.type)) {
      continue;
    } else if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options).map((o) => o.text.replace(/\s+/g, ' ').trim());
      const value = el.value && el.selectedIndex >= 0 ? options[el.selectedIndex] : '';
      item = { kind: 'select', el, question: getFieldLabel(el) || el.name || '', value, source: el.getAttribute('data-landed-source') || '', options };
    } else if (isCustomComboboxTrigger(el)) {
      const question = getFieldLabel(el) || '';
      item = { kind: 'combobox', el, question, value: existingComboboxTexts(el, question)[0] || '', source: el.getAttribute('data-landed-source') || '' };
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      item = { kind: 'text', el, question: getFieldLabel(el) || el.getAttribute('aria-label') || el.name || '', value: el.value || '', source: el.getAttribute('data-landed-source') || '' };
    }
    if (!item || !item.question || NOT_REVIEWED.has(item.source)) continue;
    // Empty: anything may fill it. A value Landed didn't put there is the
    // user's or the page's own.
    if (!item.value) item.source = '';
    else if (!item.source) item.source = 'page';
    if (neverSent(item.question)) { leftOut++; continue; }
    // Another country's work authorization or sponsorship: the facts (about
    // the US) don't answer it, so the reviewer mustn't pick from them.
    if (CA.asksAboutAnotherCountry(item.question)) continue;
    items.push({ id: item.group ? item.group[0].getAttribute('data-landed-field-id') || id : id, ...item });
    if (items.length >= 60) break;
  }
  return { items, leftOut };
}

// ─── asking, and applying what comes back ─────────────────────────────────

function askNativeHost(request) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'native-assist', request }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Put the reviewer's fix in; false when the page didn't take it. */
async function applyFix(item, fix) {
  if (item.kind === 'select') {
    const option = item.el.options[fix.option_index];
    if (!option) return false;
    setSelectOption(item.el, option);
    return item.el.value === option.value;
  }
  if (item.kind === 'radio') {
    const radio = item.group[fix.option_index];
    if (!radio || CA.classify(optionText(radio)) === 'consent') return false;
    clickChoice(radio);
    return radio.checked;
  }
  if (typeof fix.value !== 'string' || !fix.value) return false;
  if (item.kind === 'combobox') return (await tryFillCombobox(item.el, fix.value)) === true;
  fillField(item.el, fix.value);
  return item.el.value === fix.value;
}

function showNote(item, note) {
  for (const el of item.group || [item.el]) {
    markField(el, 'review');
    el.setAttribute('data-landed-note', note);
    if (!el.getAttribute('title')) el.setAttribute('title', `Landed review: ${note}`);
  }
}

/** Review this frame's fill with the user's own agent. Returns a summary for
 *  the popup: how many fields it checked, changed and flagged. */
async function runFillReview(manual, answers, flat) {
  const { items, leftOut } = fillReport();
  const summary = { checked: 0, fixed: 0, flagged: 0, left_out: leftOut, model: null, error: null };
  if (items.length === 0) return summary;
  const started = Date.now();
  const traced = () => F.traceModel?.('review_fill', {
    asked: items.length, answered: summary.fixed + summary.flagged, model: summary.model, error: summary.error, ms: Date.now() - started,
  });
  const response = await askNativeHost({
    type: 'review_fill',
    fields: items.map(({ id, question, value, source, options }) => ({ id, question, value, source, ...(options ? { options } : {}) })),
    facts: reviewFacts(answers, flat),
  });
  if (!response || !response.ok) {
    summary.error = (response && response.error) || 'Landed for Mac did not answer';
    traced();
    return summary;
  }
  summary.checked = items.length;
  summary.model = typeof response.model === 'string' ? response.model : null;
  const reviews = response.reviews && typeof response.reviews === 'object' ? response.reviews : {};
  for (const item of items) {
    const outcome = reviews[item.id];
    if (!outcome || typeof outcome.reason !== 'string') continue;
    const target = item.group ? item.group[0] : item.el;
    if (outcome.verdict === 'fix' && REPLACEABLE.has(item.source) && await applyFix(item, outcome)) {
      showNote(item, `changed: ${outcome.reason}`);
      addManual(manual, target, item.question, '复核已改', null);
      summary.fixed++;
      continue;
    }
    if (outcome.verdict === 'fix' || outcome.verdict === 'doubt') {
      showNote(item, `check this: ${outcome.reason}`);
      addManual(manual, target, item.question, '复核存疑', null);
      summary.flagged++;
    }
  }
  traced();
  return summary;
}

Object.assign(F, { setSource, tagFilled, neverSent, reviewFacts, fillReport, runFillReview });
})(typeof window !== 'undefined' ? window : globalThis);
