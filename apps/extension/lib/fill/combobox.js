// @ts-check
// lib/fill/combobox.js — custom dropdowns and search boxes (react-select, Workday
// prompts, place autocompletes): open, search, click a real option.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { automationId, comparable, deepAll, isRendered, markField, sleep } = F;
const VM = global.ResumeFillerValueMatch;
const CA = global.LandedChoiceAnswers;

function isShown(el) {
  if (!isRendered(el)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Options rendered for one combobox are often portalled to <body>. Remember
// the options that existed before opening each control so we never borrow an
// option list from another open Workday widget.
const comboboxBaselines = new WeakMap();
const comboboxScopes = new WeakMap();

function ownedOptionRoots(el) {
  return ['aria-controls', 'aria-owns']
    .map((a) => el.getAttribute(a)).filter(Boolean)
    .flatMap((id) => id.split(/\s+/))
    .map((id) => document.getElementById(id)).filter(Boolean);
}

function optionsIn(root) {
  return Array.from(root.querySelectorAll('[role="option"], [id*="-option-"]')).filter(isShown);
}

function allVisibleOptions() {
  return deepAll('[role="option"], [id*="-option-"]').filter(isShown);
}

/** The options belonging to this dropdown. There is intentionally no global
 *  `li` / menu-item fallback: on Workday that includes navigation, Settings,
 *  and options belonging to a different question. */
function visibleOptions(el) {
  const owned = ownedOptionRoots(el);
  for (const list of owned) {
    const inList = optionsIn(list);
    if (inList.length) return inList;
  }

  const remembered = comboboxScopes.get(el);
  if (remembered && isShown(remembered)) {
    const inList = optionsIn(remembered);
    if (inList.length) return inList;
  }

  const baseline = comboboxBaselines.get(el) || new Set();
  const newlyVisible = allVisibleOptions().filter((option) => !baseline.has(option));
  if (newlyVisible.length) {
    const roots = [...new Set(newlyVisible.map((option) => option.closest('[role="listbox"]')).filter(Boolean))];
    if (roots.length === 1) comboboxScopes.set(el, roots[0]);
    return newlyVisible;
  }

  // A listbox may already exist in the DOM and merely become visible. Only
  // accept it when this control says it is expanded and exactly one listbox
  // is visible, otherwise abstain instead of selecting from the wrong field.
  if (el.getAttribute('aria-expanded') === 'true') {
    const lists = deepAll('[role="listbox"]').filter(isShown);
    if (lists.length === 1) {
      comboboxScopes.set(el, lists[0]);
      return optionsIn(lists[0]);
    }
  }
  return [];
}

async function openComboboxOptions(el) {
  comboboxBaselines.set(el, new Set(allVisibleOptions()));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.click();
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
function isCustomComboboxTrigger(el) {
  if (!el || el.tagName.toLowerCase() === 'select') return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-hidden') === 'true') return false;
  const aid = automationId(el);
  // Workday's global Settings and language controls also declare themselves
  // as comboboxes/listboxes. Exclude page chrome before accepting the ARIA
  // role; the previous order made them look like already-filled application
  // questions in traces and agent review.
  if (/(setting|navigation|navmenu|profile|language|help|account)/.test(aid)
    || (el.closest && el.closest('nav, header, [role="navigation"]'))) return false;
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return true;
  if (!aid) return false;
  return /(dropdown|select|prompt|picker|country|region|source|location)/.test(aid)
    && ['BUTTON', 'INPUT', 'DIV'].includes(el.tagName);
}

/** Stable Workday automation ids are more reliable than wrapper text. These
 *  mappings are deliberately limited to facts the user explicitly saved. */

function existingComboboxTexts(el, label) {
  const values = [];
  if ('value' in el && typeof el.value === 'string' && el.value.trim()) values.push(el.value.trim());
  const own = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  if (own) values.push(own);
  let parent = el.parentElement;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
    if (parent.tagName === 'FORM' || parent.tagName === 'BODY') break;
    const controls = parent.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]');
    if (controls.length > 1) break;
    for (const selected of parent.querySelectorAll('[aria-selected="true"], [role="list"], [data-automation-id*="selected"]')) {
      const text = String(selected.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) values.push(text);
    }
  }
  const labelNorm = comparable(label);
  return [...new Set(values)].filter((text) => {
    let n = comparable(text);
    if (labelNorm && n.startsWith(labelNorm)) n = n.slice(labelNorm.length).trim();
    n = n.replace(/\brequired\b/g, '').trim();
    return !!n && !/^(search|select one|please select|choose)$/.test(n);
  });
}

/** Undo the deterministic bad values produced by older Landed builds. This
 *  only clears a field when its value exactly matches another, incompatible
 *  profile fact, so real user-entered data is preserved. */

Object.assign(F, { isShown, comboboxBaselines, comboboxScopes, ownedOptionRoots, optionsIn, allVisibleOptions, visibleOptions, openComboboxOptions, typeInto, waitForOptions, clickOption, closeCombobox, peekComboboxOptions, chooseInCombobox, chooseCity, tryFillCombobox, isCustomComboboxTrigger, existingComboboxTexts });
})(typeof window !== 'undefined' ? window : globalThis);
