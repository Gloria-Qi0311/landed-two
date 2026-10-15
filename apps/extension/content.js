// @ts-check
// content.js — scan the page, fill what we can, report what we can't.
// Requires schema.js and lib/field-detect.js to load first
// (see manifest.json content_scripts order).
//
// TS coverage is via JSDoc + checkJs (see apps/extension/tsconfig.json).
// Cross-module surface (window.ResumeFiller*) is typed as `any` for now —
// proper types arrive when packages/extension-core/src/*.js gains JSDoc.

// Field detection (FIELD_MAP, normalize*, getFieldLabel, matchResumeKey)
// lives in lib/field-detect.js. Value-to-option matching (abbreviations,
// synonyms, ranges) lives in lib/value-match.js. Bilingual translation
// (Chinese ↔ English schools / companies / degrees / names) lives in
// lib/cross-lingual.js. LLM batch fallback (matchWithCache) lives in
// lib/llm-match.js (only invoked when handleFill is called with
// aiTakeover: true. It prefers Landed.app + local Ollama, then uses the
// explicitly configured remote provider as an optional fallback.
const FD = window.ResumeFillerFieldDetect;
const { normalize, getFieldLabel, matchResumeKey } = FD;
const VM = window.ResumeFillerValueMatch;
const CL = window.ResumeFillerCrossLingual;
const CA = window.LandedChoiceAnswers;
let landedFieldCounter = 0;

function fieldId(el) {
  const existing = el.getAttribute('data-landed-field-id');
  if (existing) return existing;
  const id = `landed-${++landedFieldCounter}`;
  el.setAttribute('data-landed-field-id', id);
  return id;
}

function markField(el, status) {
  if (!el || !el.setAttribute) return;
  if (!document.getElementById('landed-apply-assist-styles')) {
    const style = document.createElement('style');
    style.id = 'landed-apply-assist-styles';
    style.textContent = [
      '[data-landed-status="filled"] { outline: 2px solid #2f9e67 !important; outline-offset: 2px !important; }',
      '[data-landed-status="review"] { outline: 2px solid #d39b22 !important; outline-offset: 2px !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
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
  return !['敏感信息', '文件上传', '选择题'].includes(item.hint);
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

function fillField(el, value) {
  if (!value) return;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return;
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  markField(el, 'filled');
}

// ─── 原生 <select> 填值 ──────────────────────────────────────────────────────

function tryFillSelect(el, value) {
  if (!value) return false;
  const candidates = Array.from(el.options).map((opt) => ({
    text: opt.text,
    value: opt.value,
    raw: opt,
  }));
  const result = VM.pickBestOption(value, candidates);
  if (!result) return false;
  setSelectOption(el, result.candidate.raw);
  return true;
}

// ─── 自定义下拉框（combobox / 非原生 select）─────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isShown(el) {
  if (!el.offsetParent) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The options a dropdown shows now: its own listbox when it names one,
 *  else real options on the page, else the looser list-item guesses. */
function visibleOptions(el) {
  const owned = ['aria-controls', 'aria-owns']
    .map((a) => el.getAttribute(a)).filter(Boolean)
    .flatMap((id) => id.split(/\s+/)).map((id) => document.getElementById(id)).filter(Boolean);
  for (const list of owned) {
    const inList = Array.from(list.querySelectorAll('[role="option"], li')).filter(isShown);
    if (inList.length) return inList;
  }
  const real = Array.from(document.querySelectorAll('[role="option"], [id*="-option-"]')).filter(isShown);
  if (real.length) return real;
  return Array.from(document.querySelectorAll(
    '[role="listitem"], [role="menuitem"], li, .option, .item, .dropdown-item, .select-option'
  )).filter(isShown);
}

async function openComboboxOptions(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.click();
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  // A search box opens on ArrowDown even when the page doesn't have focus
  // (a background tab), where the click's focus never arrives.
  if (el.tagName === 'INPUT') {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
  }
  await sleep(350);
  return visibleOptions(el);
}

/** Type into a search box the way a person does (React sees an input event). */
function typeInto(el, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Wait for search results (often loaded from the site's server). */
async function waitForOptions(el, timeoutMs) {
  let last = -1;
  for (let waited = 0; waited < timeoutMs; waited += 150) {
    await sleep(150);
    const options = visibleOptions(el);
    if (options.length && options.length === last) return options;
    last = options.length;
  }
  return visibleOptions(el);
}

function clickOption(target) {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target.click();
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

function closeCombobox(el) {
  if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  // react-select keeps its menu open while its search box has focus.
  if (el && typeof el.blur === 'function') el.blur();
}

/** A dropdown's options without choosing one (for the local model). */
async function peekComboboxOptions(el) {
  const options = await openComboboxOptions(el);
  const texts = options.map((opt) => (opt.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  closeCombobox(el);
  await sleep(80);
  return texts;
}

/** Choose an option in a custom dropdown: open it and pick from the full
 *  list; a search box with nothing suitable listed gets `query` typed and
 *  its results picked from. Nothing suitable: the search text is cleared,
 *  so no half-typed value looks filled while the field is still empty. */
async function chooseInCombobox(el, choose, query) {
  const texts = (options) => options.map((opt) => (opt.textContent || '').replace(/\s+/g, ' ').trim());
  const searchable = el.tagName === 'INPUT';
  let options = await openComboboxOptions(el);
  let index = options.length ? choose(texts(options)) : -1;
  if (index < 0 && searchable && query) {
    typeInto(el, String(query).slice(0, 60));
    options = await waitForOptions(el, 2500);
    index = options.length ? choose(texts(options)) : -1;
  }
  if (index >= 0 && options[index]) {
    clickOption(options[index]);
    await sleep(120);
    markField(el, 'filled');
    return true;
  }
  if (searchable && el.value) typeInto(el, '');
  closeCombobox(el);
  return false;
}

/** Place autocompletes ("Location (City)") list "Seattle, Washington,
 *  United States" for "Seattle, WA": the result whose place name IS the city
 *  ("Seattle Hill" is another place), in the user's state when there are
 *  several (WA = Washington). */
function chooseCity(value, state) {
  const parts = String(value).split(',').map((p) => CA.norm(p)).filter(Boolean);
  const city = parts[0];
  const region = state ? CA.norm(state) : parts[1] || '';
  return (texts) => {
    if (!city) return -1;
    const exact = texts
      .map((t, i) => ({ i, parts: String(t).split(',').map((p) => CA.norm(p)) }))
      .filter((o) => o.parts[0] === city);
    if (exact.length === 0) return -1;
    const inRegion = region ? exact.find((o) => o.parts.slice(1).some((p) => CA.sameText(region, p) >= 0.95 || CA.sameText(p, region) >= 0.95)) : null;
    return (inRegion || exact[0]).i;
  };
}

async function tryFillCombobox(el, value, opts) {
  if (!value) return false;
  const choose = opts && opts.city ? chooseCity(value, opts.state) : (texts) => {
    const result = VM.pickBestOption(value, texts.map((text, i) => ({ text, value: text, raw: i })));
    return result ? result.candidate.raw : -1;
  };
  return chooseInCombobox(el, choose, value);
}

function setSelectOption(el, option) {
  el.value = option.value;
  option.selected = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  markField(el, 'filled');
}

// ─── files to upload (Landed → Extension page) ─────────────────────────────

function loadApplicationFiles() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CA.FILES_KEY, (res) => {
        void chrome.runtime.lastError;
        const stored = res && res[CA.FILES_KEY];
        resolve(stored && typeof stored === 'object' ? stored : {});
      });
    } catch {
      resolve({});
    }
  });
}

/** Does the input take this file? (`accept` lists types or extensions.) */
function acceptsFile(input, file) {
  const accept = String(input.getAttribute('accept') || '').toLowerCase().split(',').map((a) => a.trim()).filter(Boolean);
  if (accept.length === 0) return true;
  const ext = '.' + file.name.toLowerCase().split('.').pop();
  return accept.some((a) => a === ext || a === file.mime || (a.endsWith('/*') && file.mime.startsWith(a.slice(0, -1))));
}

/** Put a saved file into an upload field the way a drop or pick would. */
function attachFile(input, file) {
  try {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.mime }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!input.files && input.files.length > 0;
  } catch {
    return false;
  }
}

/** What an upload field is for. Upload fields are usually hidden behind an
 *  "Attach" button, with the "Resume/CV" heading not tied to them, so look
 *  at what names them, then their id or name ("resume", "cover_letter"),
 *  then the text around them, closest first. */
function fileInputKind(el) {
  const clean = (t) => String(t || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || '').join(' ');
  const candidates = [labelledBy, getFieldLabel(el), el.getAttribute('aria-label'), el.id, el.name].map(clean);
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) candidates.push(clean(node.textContent).slice(0, 200));
  for (const text of candidates) {
    const kind = text && CA ? CA.fileKind(text) : null;
    if (kind) return { kind, label: text.slice(0, 120) };
  }
  return { kind: null, label: candidates.find(Boolean)?.slice(0, 120) || '' };
}

// ─── application answers (Landed → Extension page) ─────────────────────────

function loadApplicationAnswers() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CA.ANSWERS_KEY, (res) => {
        void chrome.runtime.lastError;
        const stored = res && res[CA.ANSWERS_KEY];
        resolve(stored && stored.answers && typeof stored.answers === 'object' ? stored.answers : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** What a radio / checkbox option says: its own label (wrapping or
 *  for=), not the group's question, which getFieldLabel may return. */
function optionText(el) {
  const own = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent || '').join(' ') : '';
  return String(own.trim() || el.getAttribute('aria-label') || getFieldLabel(el) || el.value || '').replace(/\s+/g, ' ').trim();
}

/** The question a group of radios / checkboxes answers: its legend, its
 *  group's label, or the text around the group minus the options. */
function choiceGroupQuestion(inputs) {
  const first = inputs[0];
  const fieldset = first.closest('fieldset');
  if (fieldset && inputs.every((i) => fieldset.contains(i))) {
    const legend = fieldset.querySelector('legend');
    if (legend && legend.textContent.trim()) return legend.textContent.replace(/\s+/g, ' ').trim();
  }
  const group = first.closest('[role="radiogroup"], [role="group"]');
  if (group && inputs.every((i) => group.contains(i))) {
    const by = group.getAttribute('aria-labelledby');
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim() : '';
    if (labelled) return labelled.replace(/\s+/g, ' ');
    const aria = group.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
  }
  const optionTexts = inputs.map(optionText).filter(Boolean);
  let node = first.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    if (!inputs.every((i) => node.contains(i))) continue;
    let text = node.textContent || '';
    for (const t of optionTexts) text = text.replace(t, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length >= 3) return text.slice(0, 300);
  }
  return '';
}

/** Radios by name (or by their group), checkboxes one by one unless they
 *  share a group element. */
function groupChoices(inputs) {
  const groups = new Map();
  for (const el of inputs) {
    const container = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    const key = el.type === 'radio' && el.name
      ? `radio:${el.form ? Array.from(document.forms).indexOf(el.form) : -1}:${el.name}`
      : container ? container : el;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  return Array.from(groups.values());
}

function clickChoice(el) {
  if (el.checked) return;
  el.click();
  if (!el.checked) {
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ─── 年 / 月 select 检测 ─────────────────────────────────────────────────────

function isYearSelect(el) {
  if (el.tagName.toLowerCase() !== 'select') return false;
  const opts = Array.from(el.options).filter(o => o.value !== '' && o.value !== '0');
  if (opts.length < 4) return false;
  // 先剥掉非数字（兼容 "2020年"、"2020" 等格式）
  const yearCount = opts.filter(o => {
    const digits = (o.value || o.text || '').replace(/[^\d]/g, '');
    return /^(19|20)\d{2}$/.test(digits);
  }).length;
  return yearCount >= opts.length * 0.5;
}

function isMonthSelect(el) {
  if (el.tagName.toLowerCase() !== 'select') return false;
  const opts = Array.from(el.options).filter(o => o.value !== '' && o.value !== '0');
  // 月份通常恰好 12 个选项（或 13 个含占位）
  if (opts.length < 4 || opts.length > 13) return false;
  const monthCount = opts.filter(o => {
    const digits = (o.value || '').replace(/[^\d]/g, '');
    const n = parseInt(digits !== '' ? digits : o.text);
    return !isNaN(n) && n >= 1 && n <= 12;
  }).length;
  return monthCount >= opts.length * 0.7;
}

// 从 "YYYY-MM" 取年
function yearFromDate(dateStr) {
  return (dateStr || '').split('-')[0] || '';
}

// 从 "YYYY-MM" 取月（整数字符串，无前导零）
function monthFromDate(dateStr) {
  const parts = (dateStr || '').split('-');
  if (parts.length < 2) return '';
  return String(parseInt(parts[1]));
}

// ─── 专用年份 select 填值（精确数字比对，不用 includes 避免"2021"命中"2020"）──

function fillYearSelect(el, yearStr) {
  const target = (yearStr || '').trim();
  if (!target) return false;
  for (const opt of el.options) {
    const digits = (opt.value || opt.text || '').replace(/[^\d]/g, '');
    if (digits === target || opt.value.trim() === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

// ─── 专用月份 select 填值（整数比对，避免"10"命中"1"的 includes 污染）───────

function fillMonthSelect(el, monthStr) {
  const target = parseInt(monthStr);
  if (isNaN(target) || target < 1 || target > 12) return false;
  // 先按 option.value 的纯数字匹配
  for (const opt of el.options) {
    const digits = opt.value.replace(/[^\d]/g, '');
    if (digits !== '' && parseInt(digits) === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  // 再按 option.text 的纯数字匹配（兼容 "三月" 等中文月名）
  for (const opt of el.options) {
    const digits = opt.text.replace(/[^\d]/g, '');
    if (digits !== '' && parseInt(digits) === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

// ─── 自定义"年"/"月" picker 触发元素检测 ────────────────────────────────────
// 匹配 placeholder="年"/"月" 的 input，以及 div/span 类自定义 select

function findCustomDateTriggers(container) {
  const yearTriggers = [];
  const monthTriggers = [];

  function visRect(el) { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; }

  // 1. input[placeholder="年/月"] — 最常见形式
  for (const el of container.querySelectorAll(
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit])'
  )) {
    if (!visRect(el)) continue;
    const ph = (el.getAttribute('placeholder') || '').trim();
    if (ph === '年' || /^yyyy$/i.test(ph)) yearTriggers.push(el);
    else if (ph === '月' || /^mm$/i.test(ph)) monthTriggers.push(el);
  }

  // 2. div/span 自定义 select（文本节点直接是"年"或"月"）
  for (const el of container.querySelectorAll(
    '[role="combobox"],[tabindex="0"],div[class*="select"],div[class*="year"],div[class*="month"],' +
    'span[class*="select"],span[class*="year"],span[class*="month"]'
  )) {
    if (!visRect(el) || el.tagName.toLowerCase() === 'select') continue;
    // 只看直接文本节点或第一个 span/em 子元素，不递归全文（避免容器误匹配）
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim()).join('');
    const firstChildText = (el.querySelector('span,em,i,b')?.textContent || '').trim();
    const candidate = directText || firstChildText;
    if (candidate === '年') yearTriggers.push(el);
    else if (candidate === '月') monthTriggers.push(el);
  }

  return { yearTriggers, monthTriggers };
}

// ─── 点击自定义 picker 并选中目标值 ──────────────────────────────────────────

async function fillCustomComboOption(trigger, value) {
  if (!trigger || !value) return false;

  const OPT_SEL = [
    'li', '[role="option"]', '[role="listitem"]', '[role="menuitem"]',
    '[class*="year-item"]', '[class*="month-item"]', '[class*="date-item"]',
    '[class*="select-item"]', '[class*="picker-item"]', '[class*="cascader"]',
  ].join(',');

  const numVal = parseInt(value);

  // getBoundingClientRect 判断可见（offsetParent 对 position:fixed 元素不可靠）
  function isVis(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function matchOpt(list) {
    if (!isNaN(numVal)) {
      const m = list.find(el => {
        const d = (el.textContent || '').replace(/[^\d]/g, '');
        return d !== '' && parseInt(d) === numVal;
      });
      if (m) return m;
    }
    return list.find(el => (el.textContent || '').trim() === String(value).trim()) || null;
  }

  // 同时发 PointerEvent + MouseEvent（兼容只监听 pointer 的 Vue/React 组件）
  function doClick(el) {
    const init = { bubbles: true, cancelable: true };
    try { el.dispatchEvent(new PointerEvent('pointerover',  init)); } catch { /* PointerEvent unsupported */ }
    try { el.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false })); } catch { /* PointerEvent unsupported */ }
    try { el.dispatchEvent(new PointerEvent('pointerdown',  init)); } catch { /* PointerEvent unsupported */ }
    el.dispatchEvent(new MouseEvent('mousedown', init));
    try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch { /* PointerEvent unsupported */ }
    el.dispatchEvent(new MouseEvent('mouseup',  init));
    el.dispatchEvent(new MouseEvent('click',    init));
  }

  // 点击前快照，用于找出真正因此次点击新出现的 option 元素
  const beforeSet = new Set(Array.from(document.querySelectorAll(OPT_SEL)).filter(isVis));

  // 关闭其他已打开的下拉
  doClick(document.body);
  await new Promise(r => setTimeout(r, 80));

  // 点击 trigger 本身 + 向上最多 3 层 wrapper（覆盖 input 在 div 内部的情况）
  doClick(trigger);
  if (trigger.tagName.toLowerCase() === 'input') trigger.focus();
  let p = trigger.parentElement;
  for (let i = 0; i < 3 && p && p !== document.body; i++) {
    if (['DIV', 'SPAN', 'A'].includes(p.tagName)) doClick(p);
    p = p.parentElement;
  }

  await new Promise(r => setTimeout(r, 520));

  // 新出现的 option 优先（最精确），兜底用全部可见 option
  const afterAll = Array.from(document.querySelectorAll(OPT_SEL)).filter(isVis);
  const newEls   = afterAll.filter(el => !beforeSet.has(el));

  const match = matchOpt(newEls) || matchOpt(afterAll);

  if (match) {
    doClick(match);
    await new Promise(r => setTimeout(r, 200));
    return true;
  }

  doClick(document.body);
  return false;
}

// ─── 在一个 DOM 容器内填日期 select + 自定义picker + 至今 checkbox ──────────
//    startDate / endDate: "YYYY-MM" 格式；isCurrent: boolean

async function fillDateAndCurrentInContainer(container, startDate, endDate, isCurrent) {
  // ── 原生 <select> 年月 ───────────────────────────────────────────────────
  const yearSelects  = Array.from(container.querySelectorAll('select')).filter(isYearSelect);
  const monthSelects = Array.from(container.querySelectorAll('select')).filter(isMonthSelect);

  const isStartCtx = (el) => /开始|起始|入学|入职|start|from|begin/.test(normalize(getFieldLabel(el)));
  const isEndCtx   = (el) => /结束|截止|毕业|离职|end|to$|until/.test(normalize(getFieldLabel(el)));

  if (yearSelects.length || monthSelects.length) {
    let startYears  = yearSelects.filter(isStartCtx);
    let endYears    = yearSelects.filter(isEndCtx);
    let startMonths = monthSelects.filter(isStartCtx);
    let endMonths   = monthSelects.filter(isEndCtx);

    if (!startYears.length && !endYears.length) { startYears = yearSelects.slice(0,1); endYears = yearSelects.slice(1,2); }
    if (!startMonths.length && !endMonths.length) { startMonths = monthSelects.slice(0,1); endMonths = monthSelects.slice(1,2); }

    if (startDate) {
      startYears.forEach(el  => fillYearSelect(el,  yearFromDate(startDate)));
      startMonths.forEach(el => fillMonthSelect(el, monthFromDate(startDate)));
    }
    if (!isCurrent && endDate) {
      endYears.forEach(el  => fillYearSelect(el,  yearFromDate(endDate)));
      endMonths.forEach(el => fillMonthSelect(el, monthFromDate(endDate)));
    }
  }

  // ── 自定义 "年"/"月" picker（input placeholder="年" 或 div 自定义 select）──
  const { yearTriggers, monthTriggers } = findCustomDateTriggers(container);

  if (yearTriggers.length || monthTriggers.length) {
    let startYearT  = yearTriggers.filter(isStartCtx);
    let endYearT    = yearTriggers.filter(isEndCtx);
    let startMonthT = monthTriggers.filter(isStartCtx);
    let endMonthT   = monthTriggers.filter(isEndCtx);

    if (!startYearT.length && !endYearT.length) { startYearT = yearTriggers.slice(0,1); endYearT = yearTriggers.slice(1,2); }
    if (!startMonthT.length && !endMonthT.length) { startMonthT = monthTriggers.slice(0,1); endMonthT = monthTriggers.slice(1,2); }

    if (startDate) {
      for (const tr of startYearT)  await fillCustomComboOption(tr, yearFromDate(startDate));
      for (const tr of startMonthT) await fillCustomComboOption(tr, monthFromDate(startDate));
    }
    if (!isCurrent && endDate) {
      for (const tr of endYearT)  await fillCustomComboOption(tr, yearFromDate(endDate));
      for (const tr of endMonthT) await fillCustomComboOption(tr, monthFromDate(endDate));
    }
  }

  // ── 至今 checkbox ─────────────────────────────────────────────────────────
  if (isCurrent) {
    for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
      const lbl = (getFieldLabel(cb) || cb.parentElement?.textContent || '').trim();
      if (/至今|present|current|ongoing/i.test(lbl)) {
        if (!cb.checked) { cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
        break;
      }
    }
  }
}

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
    Array.from(document.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea'
    ))
  ).filter(el => (el.offsetParent || (el instanceof HTMLInputElement && el.type === 'email')) && !isComboboxInput(el));
}

// ─── 批量填 inputs ────────────────────────────────────────────────────────────

function fillInputBatch(inputs, flat, filled, manual, skipSet) {
  for (const el of inputs) {
    if (skipSet && skipSet.has(el)) continue;
    const label = getFieldLabel(el) || el.name || el.id || '';
    if (el instanceof HTMLInputElement && el.type === 'file') {
      addManual(manual, el, label || '文件上传', '文件上传', null);
      continue;
    }
    if (isSensitiveLabel(label)) {
      addManual(manual, el, label, '敏感信息', null);
      continue;
    }
    if (isDateField(el)) {
      addManual(manual, el, label || '日期字段', '日期', null);
      continue;
    }
    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const value = CL.maybeTranslate(key, flat[key], getFieldLabel(el));
      fillField(el, value);
      filled.push(key);
    } else {
      if (label && String(label).trim().length > 0) {
        const n = normalize(label);
        const boring = ['search', 'captcha', 'verify', 'code', 'password', 'username'].some(k => n.includes(k));
        if (!boring) {
          addManual(manual, el, label, '未匹配', null);
        }
      }
    }
  }
}

// ─── 找 section 的"添加"按钮 ─────────────────────────────────────────────────

function findAddButtonForSection(keywords) {
  const allEls = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('*'))
  ).filter(el => {
    if (!el.offsetParent) return false;
    const ownText = (el.childNodes[0]?.nodeValue || '').trim();
    if (!ownText) return false;
    return keywords.some(kw => normalize(ownText).includes(normalize(kw)));
  });
  for (const heading of allEls) {
    let container = heading.parentElement;
    for (let i = 0; i < 10 && container; i++) {
      const btn = findAddBtnInContainer(container);
      if (btn) return btn;
      container = container.parentElement;
    }
  }
  return null;
}

function findAddBtnInContainer(container) {
  return Array.from(container.querySelectorAll('button, [role="button"], a, span, div'))
    .find(el => {
      if (!el.offsetParent) return false;
      const text = (el.textContent || '').trim();
      if (text.length > 20) return false;
      return /^[+＋]$|添加|新增|增加|\+\s*(add|experience|education|project)/i.test(text);
    }) || null;
}

// ─── 等新 inputs 出现 ─────────────────────────────────────────────────────────

function waitForNewInputs(knownSet, timeout = 2500) {
  return new Promise(resolve => {
    const getNew = () => getVisibleInputs().filter(el => !knownSet.has(el));
    const immediate = getNew();
    if (immediate.length > 0) { resolve(immediate); return; }
    const timer = setTimeout(() => { observer.disconnect(); resolve(getNew()); }, timeout);
    const observer = new MutationObserver(() => {
      const found = getNew();
      if (found.length > 0) { clearTimeout(timer); observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// 找一组新 inputs 的最小公共祖先容器
function commonAncestor(els) {
  if (!els.length) return document.body;
  let ancestor = els[0].parentElement;
  while (ancestor) {
    if (els.every(el => ancestor.contains(el))) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return document.body;
}

// ─── 所有 section 的日期 + 多条目点"+"填写（合并 Phase 4 + Phase 6）──────────

async function fillAllSectionDates(resume, filled) {
  const allYearSels = Array.from(document.querySelectorAll('select'))
    .filter(el => el.offsetParent && isYearSelect(el));

  for (const section of MULTI_ENTRY_SECTIONS) {
    const entries = resume[section.resumeKey];
    if (!Array.isArray(entries) || entries.length === 0) continue;

    const addBtn = findAddButtonForSection(section.sectionKeywords);

    // ── 第一条：找 section 容器，填日期 select ───────────────────────────────
    const flatFirst = section.flatEntry(entries[0]);
    if (flatFirst._start_date || flatFirst._end_date || flatFirst._current) {
      let container = null;

      if (addBtn) {
        // 从 addBtn 向上找含年份 select（原生或自定义）的最小容器
        let p = addBtn.parentElement;
        for (let i = 0; i < 14 && p && p !== document.body; i++) {
          const hasNativeSel = Array.from(p.querySelectorAll('select')).some(isYearSelect);
          if (hasNativeSel) { container = p; break; }
          // 同时检测自定义年份 picker（input placeholder="年" 等）
          const { yearTriggers: customYears } = findCustomDateTriggers(p);
          if (customYears.length > 0) { container = p; break; }
          p = p.parentElement;
        }
      }

      // 找不到精确容器时：只有全页年份控件不多（≤4），才用 document.body
      // 避免多 section 页面乱填
      const allCustomYears = findCustomDateTriggers(document.body).yearTriggers;
      const totalYearControls = allYearSels.length + allCustomYears.length;
      if (!container && totalYearControls <= 4) container = document.body;

      if (container) {
        await fillDateAndCurrentInContainer(
          container,
          flatFirst._start_date,
          flatFirst._end_date,
          flatFirst._current
        );
      }
    }

    // ── 后续条目：点"+"并填写 ───────────────────────────────────────────────
    if (!addBtn || entries.length <= 1) continue;

    for (let i = 1; i < entries.length; i++) {
      const knownBefore = new Set(getVisibleInputs());
      addBtn.click();
      const newInputs = await waitForNewInputs(knownBefore);
      if (newInputs.length === 0) break;

      const entryFlat = section.flatEntry(entries[i]);
      fillInputBatch(newInputs, entryFlat, filled, [], null);

      const container = commonAncestor(newInputs);
      await fillDateAndCurrentInContainer(
        container,
        entryFlat._start_date,
        entryFlat._end_date,
        entryFlat._current
      );
    }
  }
}

// ─── 主消息处理 ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fill') {
    handleFill(msg.resume, msg.customFields || {}, { aiTakeover: !!msg.aiTakeover }).then(sendResponse);
    return true;
  }
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return true;
  }
  // SW-initiated portal poll (background.js → here). We run the
  // appropriate portal parser on the current page and return the event
  // (or null) synchronously — SW dedupes via snapshot-store.
  if (msg.action === 'parse-portal') {
    sendResponse(detectPortalEventForCurrentPage());
    return true;
  }
});

// ─── Portal detection (auto-fire + SW-initiated) ──────────────────────────
//
// Two paths converge here:
//   - Auto-fire: when content.js loads at document_idle on a known portal
//     host, we parse once and send the result up to the SW for ingest.
//     This is the user-visible fast path — the user submits a Greenhouse
//     application, the confirmation page loads, and within ~1s we've
//     staged the event for #35 to push.
//   - SW-initiated: the 6h alarm wakes the SW; SW sends `parse-portal`
//     to every open Greenhouse tab; we run the same parser and reply.
//     This catches tabs that were already open when the user installed
//     the extension, or sessions the user kept open between SW restarts.
//
// detectPortalEventForCurrentPage is the single source of truth — both
// paths route through it.

function detectPortalEventForCurrentPage() {
  try {
    const url = (typeof location !== 'undefined' && location.href) || '';
    const ns = window.LandedPortalParsers;
    if (!ns) return null;
    if (ns.greenhouse && ns.greenhouse.isGreenhouseUrl(url)) {
      return ns.greenhouse.parseGreenhousePage(document, url);
    }
    if (ns.lever && ns.lever.isLeverUrl(url)) {
      return ns.lever.parseLeverPage(document, url);
    }
    if (ns.workday && ns.workday.isWorkdayUrl(url)) {
      return ns.workday.parseWorkdayPage(document, url);
    }
    if (ns.ashby && ns.ashby.isAshbyUrl(url)) {
      return ns.ashby.parseAshbyPage(document, url);
    }
    return null;
  } catch {
    return null;
  }
}

// Auto-fire on first script load. Wrapped in try/catch + setTimeout so a
// parser bug never breaks the fill path that follows in the same file.
setTimeout(() => {
  try {
    const event = detectPortalEventForCurrentPage();
    if (!event) return;
    let portal = null;
    const ns = window.LandedPortalParsers;
    if (event.app_url && ns) {
      if (ns.greenhouse && ns.greenhouse.isGreenhouseUrl(event.app_url)) portal = 'greenhouse';
      else if (ns.lever && ns.lever.isLeverUrl(event.app_url)) portal = 'lever';
      else if (ns.workday && ns.workday.isWorkdayUrl(event.app_url)) portal = 'workday';
      else if (ns.ashby && ns.ashby.isAshbyUrl(event.app_url)) portal = 'ashby';
    }
    if (!portal) return;
    chrome.runtime.sendMessage({ action: 'portal-event', portal, event }, () => {
      // No-op on response. SW does its own logging; suppress lastError to
      // avoid the unchecked-runtime-error warning in DevTools.
      void chrome.runtime.lastError;
    });
  } catch {
    // Never let portal-detection failure break the rest of content.js.
  }
}, 0);

async function handleFill(resumeData, customFields, opts) {
  opts = opts || {};
  let flat;
  if (typeof window.flattenResumeForFill === 'function') {
    flat = window.flattenResumeForFill(resumeData);
  } else {
    flat = resumeData || {};
  }

  const filled = [];
  const manual = [];
  // Saved application answers (null when the user has none): names, address,
  // yes/no questions, EEO — see lib/choice-answers.js. Choice questions they
  // don't answer may go to the local model below.
  const answers = await loadApplicationAnswers();
  const aiChoices = [];

  // Upload fields: the saved resume / cover letter files go in; others (and
  // fields with nothing saved) stay yellow. Hidden inputs behind an
  // "Attach" button count too.
  const fileInputs = /** @type {HTMLInputElement[]} */ (Array.from(document.querySelectorAll('input[type="file"]')));
  const files = fileInputs.length ? await loadApplicationFiles() : {};
  const answered = /** @type {Set<Element>} */ (new Set(fileInputs));
  const missingFiles = new Set();
  for (const el of fileInputs) {
    const { kind, label } = fileInputKind(el);
    const file = kind && files[kind];
    if (file && acceptsFile(el, file) && attachFile(el, file)) {
      markField(el, 'filled');
      filled.push('file:' + kind);
      continue;
    }
    if (kind && !file) missingFiles.add(kind);
    if (el.offsetParent || label) addManual(manual, el, label || '文件上传', '文件上传', null);
  }

  // Phase 0: text fields the answers cover (legal names, address, date of
  // birth, signature, today's date…) — before the resume rules, which would
  // put a preferred name into "Legal first name".
  if (answers) {
    for (const el of getVisibleInputs()) {
      if (el instanceof HTMLInputElement && el.type === 'file') continue;
      const kind = CA.classify(getFieldLabel(el) || '');
      const isDate = el instanceof HTMLInputElement && el.type === 'date';
      const answer = kind && CA.answerFor(kind, answers, { dateInput: isDate });
      if (!answer) continue;
      const value = answer.type === 'text' ? answer.value : answer.type === 'yesno' ? (answer.value === 'yes' ? 'Yes' : 'No') : null;
      if (!value || (isDate && !/^\d{4}-\d{2}-\d{2}$/.test(value))) continue;
      fillField(el, value);
      filled.push('answer:' + kind);
      answered.add(el);
    }
  }

  // Phase 1：填所有可见 input / textarea
  fillInputBatch(getVisibleInputs(), flat, filled, manual, answered);

  // Phase 2：原生 <select> 匹配填值
  for (const el of document.querySelectorAll('select')) {
    if (!el.offsetParent) continue;
    const label = getFieldLabel(el) || el.name || el.id || '下拉选择';

    // 年/月 select 交给日期模块处理
    if (isYearSelect(el) || isMonthSelect(el)) continue;

    const options = Array.from(el.options);
    const kind = answers ? CA.classify(label) : null;
    const answer = kind && CA.answerFor(kind, answers);
    if (answer) {
      const index = CA.pickOption(answer, options.map((o) => o.text));
      if (index >= 0) {
        setSelectOption(el, options[index]);
        filled.push('answer:' + kind);
        continue;
      }
    }

    if (isSensitiveLabel(label)) {
      addManual(manual, el, label, '敏感信息', null);
      continue;
    }

    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const value = CL.maybeTranslate(key, flat[key], label);
      if (tryFillSelect(el, value)) {
        filled.push(key);
        continue;
      }
    }
    const hint = key ? flat[key] || '—' : '—';
    addManual(manual, el, label, '下拉框', hint);
    if (answers && kind !== 'consent') {
      aiChoices.push({ id: fieldId(el), question: label, options: options.map((o) => o.text), apply: (i) => setSelectOption(el, options[i]) });
    }
  }

  // Phase 3：combobox / 自定义下拉
  const comboboxes = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll(
      '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]'
    ))
  ).filter(el => el.offsetParent && el.tagName.toLowerCase() !== 'select');

  let peeked = 0;
  for (const el of comboboxes) {
    const label = getFieldLabel(el) || '下拉选择';
    const kind = answers ? CA.classify(label) : null;
    const answer = kind && CA.answerFor(kind, answers);
    const choose = answer && (kind === 'city' && answer.type === 'text' ? chooseCity(answer.value, answers.state) : (texts) => CA.pickOption(answer, texts));
    if (answer && await chooseInCombobox(el, choose, answer.type === 'text' ? answer.value : '')) {
      filled.push('answer:' + kind);
      continue;
    }
    if (isSensitiveLabel(label)) {
      addManual(manual, el, label, '敏感信息', null);
      continue;
    }
    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const value = CL.maybeTranslate(key, flat[key], label);
      const ok = await tryFillCombobox(el, value, { city: key === 'location' || /city|城市/i.test(label), state: answers && answers.state });
      if (ok) {
        filled.push(key);
        continue;
      }
      addManual(manual, el, label, '自定义下拉框', value);
    } else {
      addManual(manual, el, label, '自定义下拉框', null);
    }
    // No rule answer: the local model may pick from its options (searched
    // lists show none until typed in, so they stay with the user).
    if (answers && kind !== 'consent' && peeked < 12) {
      peeked++;
      const texts = await peekComboboxOptions(el);
      if (texts.length >= 2 && texts.length <= 40) {
        aiChoices.push({ id: fieldId(el), question: label, options: texts, apply: (i) => chooseInCombobox(el, (now) => now.indexOf(texts[i]), '') });
      }
    }
  }

  // Phase 4：富文本 / contenteditable
  for (const el of document.querySelectorAll('[contenteditable="true"], [role="textbox"]')) {
    const label = getFieldLabel(el) || '富文本编辑器';
    const match = matchResumeKey(el);
    const key = match && match.key;
    addManual(manual, el, label, '富文本', key && flat[key] ? flat[key] : null);
  }

  // Phase 5：日期 select + 多条目（合并处理，按 section 定位容器避免乱填）
  const resume = typeof window.normalizeResume === 'function'
    ? window.normalizeResume(resumeData)
    : null;
  if (resume) await fillAllSectionDates(resume, filled);

  // Phase 6: radio buttons and checkboxes. Answered only from the user's
  // saved application answers (never guessed); consent boxes only when they
  // turned on "Tick consent boxes for me". The rest stay yellow, and radio
  // groups without a rule answer may go to the local model below. Date
  // "current/present" boxes are handled above and omitted once selected.
  const choiceInputs = /** @type {HTMLInputElement[]} */ (
    Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
  ).filter((el) => el.offsetParent);
  for (const group of groupChoices(choiceInputs)) {
    const first = group[0];
    const firstText = optionText(first) || first.parentElement?.textContent?.trim() || first.name || '选择题';
    if (group.length === 1 && first.checked && /至今|present|current|ongoing/i.test(firstText)) continue;
    const question = choiceGroupQuestion(group) || firstText;
    const kind = answers ? CA.classify(question) : null;

    if (answers && first.type === 'radio') {
      const answer = kind && CA.answerFor(kind, answers);
      const index = answer ? CA.pickOption(answer, group.map(optionText)) : -1;
      if (index >= 0) {
        clickChoice(group[index]);
        group.forEach((el) => markField(el, 'filled'));
        filled.push('answer:' + kind);
        continue;
      }
    }
    if (answers && first.type === 'checkbox' && answers.agree_to_terms === true) {
      for (const box of group) {
        const text = optionText(box);
        const consent = CA.classify(text) === 'consent' || kind === 'consent';
        if (consent && CA.pickOption({ type: 'agree' }, [text]) === 0) {
          clickChoice(box);
          markField(box, 'filled');
          filled.push('answer:consent');
        }
      }
      if (group.every((box) => box.getAttribute('data-landed-status') === 'filled')) continue;
    }

    const open = group.filter((el) => el.getAttribute('data-landed-status') !== 'filled');
    const sensitive = isSensitiveLabel(question) || kind === 'consent';
    open.forEach((el) => markField(el, 'review'));
    addManual(manual, open[0], question, sensitive ? '敏感信息' : '选择题', null);
    if (answers && first.type === 'radio' && !sensitive) {
      aiChoices.push({ id: fieldId(first), question, options: group.map(optionText), apply: (i) => clickChoice(group[i]), group });
    }
  }

  // Phase 7：user-learned custom fields and label→resumeKey mappings.
  // customFields: { section: { label: literalValue } } — value is fixed.
  // labelMappings: { label: resumeKey } — value comes from the current
  // resume so it stays in sync as the user updates fields.
  const labelMappings = await new Promise((resolve) => {
    try {
      chrome.storage.local.get('labelMappings', (res) => resolve(res?.labelMappings || {}));
    } catch {
      resolve({});
    }
  });
  const allCustom = customFields && typeof customFields === 'object'
    ? Object.values(customFields).reduce(
      (acc, section) => (typeof section === 'object' ? Object.assign(acc, section) : acc),
      {}
    )
    : {};
  const customEntries = Object.entries(allCustom);
  const mappingEntries = Object.entries(labelMappings);
  if (customEntries.length > 0 || mappingEntries.length > 0) {
    for (const el of getVisibleInputs()) {
      const label = getFieldLabel(el);
      if (!label) continue;
      const norm = normalize(label);

      let matched = false;
      // Literal-value custom fields take priority — most explicit.
      for (const [cfLabel, cfValue] of customEntries) {
        if (normalize(cfLabel) === norm && cfValue) {
          fillField(el, String(cfValue));
          filled.push('custom:' + cfLabel);
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Then label→resumeKey mappings (#10): fill from current resume.
      for (const [lmLabel, lmKey] of mappingEntries) {
        if (normalize(lmLabel) === norm && flat[lmKey]) {
          fillField(el, String(flat[lmKey]));
          filled.push('mapped:' + lmLabel);
          break;
        }
      }
    }
  }

  // Explicit custom answers and learned mappings run after the generic scan.
  // If one resolved a field, do not keep its earlier review entry or send it
  // to either model fallback.
  for (let i = manual.length - 1; i >= 0; i--) {
    const target = document.querySelector(`[data-landed-field-id="${manual[i].id}"]`);
    if (target?.getAttribute('data-landed-status') === 'filled') manual.splice(i, 1);
  }

  // Phase 8 (optional, #9): typed local-model fallback for unmatched
  // labels. Failures degrade silently — the user sees the manual list.
  if (opts.aiTakeover) {
    const aiFilled = await runLLMFallback(manual, flat, answers ? CA.answerFlat(answers) : {});
    if (aiFilled.length > 0) {
      filled.push(...aiFilled);
      // Drop AI-filled entries from the manual list so the popup UI
      // doesn't ask the user to handle them again.
      const filledIdSet = new Set(aiFilled.map((s) => s.replace(/^ai:/, '')));
      for (let i = manual.length - 1; i >= 0; i--) {
        if (filledIdSet.has(manual[i].id)) manual.splice(i, 1);
      }
    }
    // Choice questions the saved answers don't cover by rule: the local
    // model picks an option from the user's answers, or leaves it.
    const chosen = await runChoiceFallback(aiChoices, answers, flat);
    if (chosen.length > 0) {
      filled.push(...chosen.map((id) => 'ai-choice:' + id));
      const done = new Set(chosen);
      for (let i = manual.length - 1; i >= 0; i--) {
        if (done.has(manual[i].id)) manual.splice(i, 1);
      }
    }
  }

  return { filled, manual, missing_files: Array.from(missingFiles) };
}

async function runChoiceFallback(choices, answers, flat) {
  const open = choices.filter((c) => c.options.length >= 2 && c.options.length <= 40 && c.question);
  if (!answers || open.length === 0) return [];
  const response = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        action: 'native-assist',
        request: {
          type: 'choose_options',
          questions: open.slice(0, 40).map((c) => ({ id: c.id, question: c.question, options: c.options })),
          facts: CA.answerFacts(answers, flat),
        },
      }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch {
      resolve(null);
    }
  });
  if (!response || !response.ok || !response.choices) return [];
  const done = [];
  for (const c of open) {
    const pick = response.choices[c.id];
    const index = pick && Number.isInteger(pick.option_index) ? pick.option_index : -1;
    if (index < 0 || index >= c.options.length) continue;
    if ((await c.apply(index)) === false) continue;
    (c.group || [document.querySelector(`[data-landed-field-id="${c.id}"]`)]).forEach((el) => el && markField(el, 'filled'));
    done.push(c.id);
  }
  return done;
}

async function runLLMFallback(manual, flat, answerKeys) {
  if (!manual || manual.length === 0) return [];
  const modelEligible = manual.filter(canAskModel);
  if (modelEligible.length === 0) return [];

  // Prefer the local Landed.app bridge. The model only selects an existing
  // resume key; native-host.ts validates that key and returns the original
  // value, so page text cannot persuade it to invent an application fact.
  const native = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        action: 'native-assist',
        request: {
          type: 'match_fields',
          fields: modelEligible.map((m) => ({ id: m.id, label: m.label, kind: m.hint })),
          // Saved answers join as extra keys for the local model only (it
          // sees key names, never values); the remote fallback below doesn't.
          resume: { ...flat, ...(answerKeys || {}) },
        },
      }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
  if (native && native.ok && native.values) {
    const filled = await applySuggestedValues(modelEligible, native.values, true);
    if (filled.length > 0) return filled;
  }

  // Existing remote-provider fallback remains available for people without
  // Landed.app/Ollama, but only when they explicitly enabled it in options.
  const LP = window.ResumeFillerLLMProviders;
  const LM = window.ResumeFillerLLMMatch;
  if (!LP || !LM) return [];

  const settings = await new Promise((resolve) => {
    try {
      chrome.storage.local.get('aiSettings', (res) => resolve(res?.aiSettings || null));
    } catch {
      resolve(null);
    }
  });
  if (!settings || !settings.enabled) return [];

  const labels = modelEligible.map((m) => m.label).filter(Boolean);
  if (labels.length === 0) return [];
  const domain = (typeof location !== 'undefined' && location.hostname) || '_';

  const values = await LM.matchWithCache(domain, labels, flat, settings);
  if (!values || Object.keys(values).length === 0) return [];

  const byId = {};
  for (const item of modelEligible) {
    const value = values[item.label];
    if (typeof value === 'string' && value.trim()) byId[item.id] = value;
  }
  return applySuggestedValues(manual, byId, false);
}

async function applySuggestedValues(manual, values, structured) {
  const aiFilled = [];
  for (const item of manual) {
    const raw = values[item.id];
    const value = structured ? raw && raw.value : raw;
    if (typeof value !== 'string' || !value.trim()) continue;
    const target = document.querySelector(`[data-landed-field-id="${item.id}"]`);
    if (!target) continue;
    const tag = target.tagName.toLowerCase();
    let ok = false;
    if (tag === 'select') {
      ok = tryFillSelect(target, value);
    } else if (target.getAttribute('role') === 'combobox' || target.getAttribute('aria-haspopup')) {
      ok = await tryFillCombobox(target, value);
    } else if (tag === 'input' || tag === 'textarea') {
      if (target instanceof HTMLInputElement && ['file', 'checkbox', 'radio'].includes(target.type)) {
        continue;
      }
      fillField(target, value);
      ok = true;
    }
    if (ok) aiFilled.push('ai:' + item.id);
  }
  return aiFilled;
}
