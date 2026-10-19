// @ts-check
// lib/fill/core.js — what every fill step shares: finding fields (inside open shadow
// roots too), visibility, the green / yellow marks, the review list, and
// writing text inputs the way a person would.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { normalize } = global.ResumeFillerFieldDetect;

let landedFieldCounter = 0;

function fieldId(el) {
  const existing = el.getAttribute('data-landed-field-id');
  if (existing) return existing;
  const id = `landed-${++landedFieldCounter}`;
  el.setAttribute('data-landed-field-id', id);
  return id;
}

// ─── forms inside web components (open shadow roots) ──────────────────────
// Some application pages build their form, or its dialog, out of web
// components: document.querySelectorAll doesn't see inside them.

function shadowRoots(root) {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) out.push(el.shadowRoot, ...shadowRoots(el.shadowRoot));
  }
  return out;
}

/** querySelectorAll across the document and every open shadow root. */
function deepAll(selector) {
  const roots = [document, ...shadowRoots(document)];
  return roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));
}

/** On screen? (offsetParent alone is unreliable inside shadow roots.) */
function isRendered(el) {
  return !!el.offsetParent || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}

const MARK_STYLES = [
  '[data-landed-status="filled"] { outline: 2px solid #2f9e67 !important; outline-offset: 2px !important; }',
  '[data-landed-status="review"] { outline: 2px solid #d39b22 !important; outline-offset: 2px !important; }',
].join('\n');

function markField(el, status) {
  if (!el || !el.setAttribute) return;
  // The outline styles go where the field lives: the page, or its shadow root.
  const root = el.getRootNode ? el.getRootNode() : document;
  const host = root && root !== document && root.appendChild ? root : (document.head || document.documentElement);
  const scope = root && root.querySelector ? root : document;
  if (!scope.querySelector('#landed-apply-assist-styles')) {
    const style = document.createElement('style');
    style.id = 'landed-apply-assist-styles';
    style.textContent = MARK_STYLES;
    host.appendChild(style);
  }
  fieldId(el);
  el.setAttribute('data-landed-status', status);
}

function addManual(manual, el, label, hint, value) {
  const text = String(label || '').trim();
  if (!text) return;
  markField(el, 'review');
  const id = fieldId(el);
  const existing = manual.find((item) => item.id === id);
  if (existing) {
    if (existing.hint === '未匹配' && hint !== '未匹配') existing.hint = hint;
    if (existing.value == null && value != null) existing.value = value;
    return;
  }
  manual.push({ id, label: text, hint, value: value ?? null });
}

function isSensitiveLabel(label) {
  const n = normalize(label || '');
  return [
    'salary', 'compensation', 'pay expectation', 'desired pay', '薪资', '薪酬', '期望工资',
    'work authorization', 'authorized to work', 'sponsorship', 'visa', '工作许可', '签证',
    'gender', 'sex', 'pronoun', 'race', 'ethnicity', '性别', '种族', '族裔', '代词',
    'disability', 'veteran', '残障', '残疾', '退伍',
    'social security', 'ssn', 'date of birth', 'birth date', '出生日期', '身份证',
  ].some((keyword) => n.includes(normalize(keyword)));
}

function canAskModel(item) {
  // An entry's fields (lib/fill/experience.js) take that entry's values: a
  // model matching labels to the resume would give every job the current one.
  return !['敏感信息', '文件上传', '选择题', '多条目', '日期'].includes(item.hint);
}

const MULTI_ENTRY_SECTIONS = [
  {
    resumeKey: 'experience',
    sectionKeywords: ['工作经历', '工作经验', 'work experience', 'employment', 'full-time', 'full time'],
    flatEntry: (e) => ({
      current_company: e.company || '',
      current_title: e.title || '',
      job_description: e.description || '',
      location: e.location || '',
      _start_date: e.start_date || '',
      _end_date: e.end_date || '',
      _current: !!e.current,
    }),
  },
  {
    resumeKey: 'internship',
    sectionKeywords: ['实习经历', '实习经验', '实习', 'internship', 'intern experience'],
    flatEntry: (e) => ({
      current_company: e.company || '',
      current_title: e.title || '',
      job_description: e.description || '',
      location: e.location || '',
      _start_date: e.start_date || '',
      _end_date: e.end_date || '',
      _current: !!e.current,
    }),
  },
  {
    resumeKey: 'education',
    sectionKeywords: ['教育背景', '教育经历', '教育信息', '学历', 'education', 'academic'],
    flatEntry: (e) => ({
      edu_school: e.school || '',
      edu_major: e.major || '',
      edu_degree: e.degree || '',
      edu_gpa: e.gpa || '',
      _start_date: e.start_date || '',
      _end_date: e.end_date || '',
      _current: false,
    }),
  },
  {
    resumeKey: 'projects',
    sectionKeywords: ['项目经历', '项目经验', '项目', 'projects', 'project experience'],
    flatEntry: (e) => ({
      project_name: e.name || '',
      project_description: e.description || '',
      _start_date: e.start_date || '',
      _end_date: e.end_date || '',
      _current: false,
    }),
  },
];

// ─── input / textarea 填值 ───────────────────────────────────────────────────

function setTextFieldValue(el, value) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return false;
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

function fillField(el, value) {
  if (!value || !setTextFieldValue(el, value)) return;
  markField(el, 'filled');
}

function clearField(el) {
  if (!setTextFieldValue(el, '')) return;
  el.removeAttribute('data-landed-status');
}

// ─── 自定义下拉框（combobox / 非原生 select）─────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 日期字段判断 ────────────────────────────────────────────────────────────

function isDateField(el) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (['date', 'month', 'datetime-local'].includes(type)) return true;
  // year/month selects 不归入 isDateField，交给 fillDateAndCurrentInContainer 处理
  return false;
}

// ─── 可见 inputs ─────────────────────────────────────────────────────────────

/** The search box of a custom dropdown (react-select, autocompletes):
 *  typing into it only filters, it doesn't choose — Phase 3 picks an option. */
function isComboboxInput(el) {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list'
    || el.getAttribute('aria-autocomplete') === 'both';
}

function getVisibleInputs() {
  return /** @type {(HTMLInputElement | HTMLTextAreaElement)[]} */ (
    deepAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea')
  ).filter(el => (isRendered(el) || (el instanceof HTMLInputElement && el.type === 'email')) && !isComboboxInput(el));
}

Object.assign(F, { landedFieldCounter, fieldId, shadowRoots, deepAll, isRendered, MARK_STYLES, markField, addManual, isSensitiveLabel, canAskModel, MULTI_ENTRY_SECTIONS, setTextFieldValue, fillField, clearField, sleep, isDateField, isComboboxInput, getVisibleInputs });
})(typeof window !== 'undefined' ? window : globalThis);
