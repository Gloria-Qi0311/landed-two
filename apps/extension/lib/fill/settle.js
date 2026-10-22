// @ts-check
// lib/fill/settle.js — after a fill, make sure every field Landed marked filled
// really holds its value, the way a person checks a form.
//
//  1. Text fields Landed wrote into: some are "type, then pick from the list"
//     boxes that don't say so in their markup (Lever's Current location looks
//     like a plain input; its options are plain divs). Retype the value key by
//     key, and if suggestions appear by the field, pick the one that matches.
//     Recognized by what the page does, not by roles or ids.
//  2. Then every field marked filled is read again after the page's own
//     scripts ran. One that's empty now (cleared on blur, never taken) turns
//     yellow with the reason. Green means the value is there.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { addManual, chooseCity, clickOption, deepAll, existingComboboxTexts, isCustomComboboxTrigger, isShown, sleep } = F;
const { getFieldLabel } = global.ResumeFillerFieldDetect;

/** What Landed meant to put in each text field (fillField records it). */
const intended = F.intendedValues;

const TYPED = new Set(['', 'text', 'search']);
/** Text fields worth retyping: short single-line values Landed put there. */
function retypable(el) {
  return el instanceof HTMLInputElement && TYPED.has((el.getAttribute('type') || '').toLowerCase())
    && el.getAttribute('data-landed-status') === 'filled' && !isCustomComboboxTrigger(el)
    && typeof intended.get(el) === 'string' && intended.get(el).length <= 80;
}

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const words = (t) => clean(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

function setValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
}

/** Type `text` the way a keyboard does: key events and an input event per
 *  character (some widgets only search on keyup). */
function typeLikeAPerson(el, text) {
  const key = (type, ch) => el.dispatchEvent(new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true }));
  if (typeof el.focus === 'function') el.focus();
  setValue(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  let typed = '';
  for (const ch of text) {
    key('keydown', ch);
    key('keypress', ch);
    typed += ch;
    setValue(el, typed);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    key('keyup', ch);
  }
}

/** Elements the page added or showed while we typed. */
function watchPage() {
  const touched = new Set();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => { if (n.nodeType === 1) touched.add(/** @type {Element} */ (n)); });
      else if (r.target.nodeType === 1) touched.add(/** @type {Element} */ (r.target));
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded'] });
  return { touched, stop: () => observer.disconnect() };
}

/** Never a candidate: a control that does something when clicked. A submit
 *  never, even inside a list (a <button> in a form submits unless its type
 *  says "button"); a link or button unless it's a list option. */
function clickable(node) {
  const submitter = node.closest('button, input[type="submit"], input[type="image"]');
  if (submitter && ['submit', 'image'].includes(/** @type {HTMLButtonElement} */ (submitter).type)) return true;
  if (node.closest('[role="option"]')) return false;
  // Not a <label>: Lever's whole question, suggestion list and all, sits in one.
  return !!node.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"]');
}

/** Is `node` by the field: from its top down to a list's height below it,
 *  roughly as wide. */
function byField(box, node) {
  const r = node.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return r.top >= box.top - 4 && r.top <= box.bottom + 420 && r.left < box.right + 40 && r.right > box.left - 40;
}

/** Suggestions for `typed`: things that appeared by the field, are shown,
 *  read as one short line, and share a word with what was typed. Leaf-most,
 *  so a list's wrapper isn't taken for one of its items. Never a button,
 *  link or submit (clickable). */
function suggestionsNear(el, touched, typed) {
  const box = el.getBoundingClientRect();
  const want = words(typed);
  const seen = new Set();
  /** @type {{ node: HTMLElement, text: string }[]} */
  const found = [];
  for (const root of touched) {
    if (!root.isConnected) continue;
    for (const node of [root, ...Array.from(root.querySelectorAll('*')).slice(0, 300)]) {
      if (seen.has(node) || node === el || node.contains(el) || !(node instanceof HTMLElement)) continue;
      seen.add(node);
      if (!isShown(node) || ['INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'SCRIPT', 'STYLE'].includes(node.tagName) || clickable(node)) continue;
      const text = clean(node.innerText ?? node.textContent);
      if (!text || text.length > 120 || text.includes('\n')) continue;
      if (Array.from(node.children).some((c) => clean(/** @type {HTMLElement} */ (c).innerText ?? c.textContent) === text)) continue;
      if (!byField(box, node)) continue;
      const have = words(text);
      if (!want.some((w) => have.includes(w))) continue;
      found.push({ node, text });
    }
  }
  return found;
}

/** Did anything by the field change? Pages that restyle on every keystroke
 *  (React forms toggling classes) change elsewhere; that isn't a list. */
function changedByField(el, touched) {
  const box = el.getBoundingClientRect();
  for (const node of touched) {
    if (node.isConnected && node !== el && !node.contains(el) && node instanceof HTMLElement && isShown(node) && byField(box, node)) return true;
  }
  return false;
}

/** Wait for suggestions: nothing changes on the page within ~0.4 s → a
 *  plain field; the page changes, but nothing by the field within ~1.2 s
 *  (results can take that long from the site's server: Lever's location
 *  search) → a plain field too; something appears by it → up to ~2 s for the
 *  list to settle. Pages that restyle on every keystroke no longer hold each
 *  plain field the full 2 s. */
async function waitForSuggestions(el, watch, typed) {
  let last = '';
  for (let waited = 0; waited < 2100; waited += 150) {
    await sleep(150);
    if (waited >= 300 && watch.touched.size === 0) return [];
    if (waited >= 1200 && !changedByField(el, watch.touched)) return [];
    const found = suggestionsNear(el, watch.touched, typed);
    const key = found.map((f) => f.text).join('|');
    if (found.length && key === last) return found;
    last = key;
  }
  return suggestionsNear(el, watch.touched, typed);
}

/** A company or school name without punctuation, case or a legal suffix. */
const LEGAL = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh)\b/g;
const bare = (t) => clean(t).toLowerCase().replace(/[.,'’]/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

/** Which suggestion is `value`: a place picks the result whose name is the
 *  city (in the right state); anything else only the same name, maybe with a
 *  qualifier after a separator ("University of Washington - Seattle",
 *  "Google LLC"), never a different one ("Google" is not "Google Cloud"):
 *  better left for the user than wrong. */
function pickSuggestion(value, texts, isPlace) {
  if (isPlace) return chooseCity(value)(texts);
  const want = bare(value);
  if (!want) return -1;
  const exact = texts.findIndex((t) => bare(t) === want);
  if (exact >= 0) return exact;
  return texts.findIndex((t) => {
    const lower = clean(t).toLowerCase();
    const start = clean(value).toLowerCase();
    return lower.startsWith(start) && /^\s*[-–—,(|·]/.test(lower.slice(start.length));
  });
}

const PLACE = /location|city|town|where.*(live|based)|所在地|城市|地点|居住/i;

/** Retype one field; pick from its suggestions if it shows any. True when
 *  it was a pick-from-list box (whatever the outcome). */
async function typeAndPick(el) {
  const value = String(intended.get(el) || '');
  const label = getFieldLabel(el) || el.name || '';
  const isPlace = PLACE.test(label) || PLACE.test(el.name || '') || PLACE.test(el.id || '');
  // A place box searches by city: "Seattle", then match "Seattle, WA, USA".
  const query = isPlace ? value.split(',')[0].trim() : value;
  const watch = watchPage();
  typeLikeAPerson(el, query);
  const found = await waitForSuggestions(el, watch, query);
  watch.stop();
  if (found.length === 0) {
    // A plain field: put the whole value back as Landed meant it.
    if (el.value !== value) { setValue(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return false;
  }
  const index = pickSuggestion(value, found.map((f) => f.text), isPlace);
  if (index >= 0) {
    clickOption(found[index].node);
    await sleep(150);
  }
  return true;
}

const PLACEHOLDER = /^(search|select( one)?|select\s*(\.\.\.|…)|please select|choose( one)?|--|—)?$/i;

/** A dropdown holds a choice when a person sees one in it: its own value or
 *  text, a selected item, or the chosen option shown as text in its control
 *  (react-select keeps its search input empty and shows the choice beside
 *  it). Placeholders like "Select…" don't count. */
function showsChoice(el) {
  const label = getFieldLabel(el) || '';
  if (existingComboboxTexts(el, label).length) return true;
  let parent = el.parentElement;
  for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
    if (['FORM', 'BODY', 'LABEL', 'FIELDSET'].includes(parent.tagName)) break;
    // Up to the control, not the question around it with other fields in it.
    if (parent.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], select, textarea, input:not([type="hidden"])').length > 1) break;
    let text = clean(parent.innerText ?? parent.textContent);
    if (label && text.toLowerCase().startsWith(clean(label).toLowerCase())) text = text.slice(clean(label).length).trim();
    if (text && !PLACEHOLDER.test(text.replace(/[*✱]/g, '').trim())) return true;
  }
  return false;
}

const isDropdown = (el) => isCustomComboboxTrigger(el) || el.getAttribute('role') === 'combobox'
  || ['list', 'both'].includes(el.getAttribute('aria-autocomplete') || '');

/** Does the field still hold what Landed put there? */
function holds(el) {
  if (isDropdown(el)) return showsChoice(el);
  if (el instanceof HTMLSelectElement) {
    const option = el.options[el.selectedIndex];
    return !!option && !!el.value && !/^\s*(select|please select|choose|--|—)/i.test(option.text || '');
  }
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    if (el.checked) return true;
    const scope = el.form || el.getRootNode();
    return !!el.name && !!(/** @type {ParentNode} */ (scope)).querySelector?.(`input[type="radio"][name="${el.name.replace(/["\\]/g, '\\$&')}"]:checked`);
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  // Upload fields aren't checked: sites send the file at once and empty the
  // input, then show it by name ("Success!").
  if (el instanceof HTMLInputElement && el.type === 'file') return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim() !== '';
  return true;
}

/** Settle the fill: retype text fields (picking from suggestion lists), let
 *  the page's scripts run, then turn every filled field that's empty now
 *  yellow. Returns the labels of fields that didn't keep their value. */
async function settleFill(manual) {
  const fields = /** @type {HTMLInputElement[]} */ (deepAll('[data-landed-status="filled"]')).filter((el) => retypable(el) && isShown(el)).slice(0, 25);
  for (const el of fields) {
    try {
      await typeAndPick(el);
    } catch {
      // the check below still runs
    }
    if (typeof el.blur === 'function') el.blur();
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  if (active && active !== document.body && typeof active.blur === 'function') active.blur();
  await sleep(300);
  /** @type {string[]} */
  const lost = [];
  for (const el of deepAll('[data-landed-status="filled"]')) {
    // A field the page hid since (replaced, collapsed) isn't the user's to fix.
    if (!(el instanceof HTMLInputElement && el.type === 'radio') && !isShown(el)) continue;
    if (holds(el)) continue;
    const label = getFieldLabel(el) || /** @type {HTMLInputElement} */ (el).name || 'A field';
    el.setAttribute('data-landed-note', "didn't keep the value: the page cleared it. Pick it from the list or type it.");
    if (!el.getAttribute('title')) el.setAttribute('title', "Landed: this didn't keep the value. Pick it from the list or type it.");
    addManual(manual, el, label, '没留住', intended.get(el) ?? null);
    lost.push(clean(label).slice(0, 120));
  }
  return lost;
}

Object.assign(F, { typeLikeAPerson, suggestionsNear, pickSuggestion, typeAndPick, holds, settleFill });
})(typeof window !== 'undefined' ? window : globalThis);
