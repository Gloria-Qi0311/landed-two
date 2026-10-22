// @ts-check
// lib/fill/learn.js — the user corrects a form Landed filled: Landed
// remembers it. A change the user makes (a trusted event, never one of
// Landed's own) on a page Landed filled, to a question that's a fact holding
// for every application (where they live, when they can start, their links,
// a yes/no like sponsorship or relocating), goes to the open Landed tab
// (background 'answer-corrected' → bridge 'take-corrections'), which saves it
// as the answer, marked on the Extension page with Undo
// (packages/schema/src/application-answers.ts, learnAnswers).
//
// Never date of birth, street address, EEO, consent, "worked here before?"
// (one company's) or open-ended text: those aren't in LEARNABLE. Nor a
// question about one place or amount ("relocate to Austin, TX?", "onsite 5
// days a week in our New York office?", "travel up to 75%?"): the answer to
// it isn't the answer for every application (CA.namesPlaceOrAmount; the page
// checks again).
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { answerKindForElement, choiceGroupQuestion, deepAll, groupChoices, loadApplicationAnswers, neverSent, optionText } = F;
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

/** The same list as LEARNABLE in packages/schema/src/application-answers.ts. */
const LEARNABLE = new Set([
  'city', 'state', 'country', 'earliest_start', 'linkedin', 'github', 'website', 'heard_from',
  'adult', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'onsite', 'open_to_other_locations', 'non_compete', 'talent_network',
]);
const YES_NO = new Set(['adult', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'onsite', 'open_to_other_locations', 'non_compete', 'talent_network']);
const PLACEHOLDER = /^(select|please select|choose|--|—|select\s*(\.\.\.|…))?$/i;

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** "Yes, I will…" → yes, "No, I do not…" → no; anything else → null. */
function yesNoOf(text) {
  const t = clean(text).toLowerCase();
  if (/^yes\b/.test(t) || /^(是|有|需要|愿意)/.test(t)) return 'yes';
  // Not "Not sure", "None of these" or "不确定".
  if (/^no\b/.test(t) || /^(否|没有|不需要|不愿意|不是|无)/.test(t)) return 'no';
  return null;
}

/** What the user now says, in the form a saved answer takes; null when it
 *  isn't a fact Landed keeps. */
function correctionOf(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return null;
  const type = el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : '';
  if (['password', 'file', 'hidden', 'checkbox'].includes(type)) return null;
  let question;
  let shown;
  if (type === 'radio') {
    if (!(/** @type {HTMLInputElement} */ (el)).checked || !el.name) return null;
    const scope = el.form || el.getRootNode();
    const group = groupChoices(Array.from(/** @type {ParentNode} */ (scope).querySelectorAll(`input[type="radio"][name="${el.name.replace(/["\\]/g, '\\$&')}"]`)))
      .find((g) => g.includes(el)) || [el];
    question = clean(choiceGroupQuestion(group));
    shown = optionText(el);
  } else {
    question = clean(getFieldLabel(el) || el.getAttribute('aria-label') || '');
    shown = el instanceof HTMLSelectElement ? (el.options[el.selectedIndex]?.text || '') : el.value;
  }
  question = question.replace(/\s*[*✱]\s*$/, '');
  if (!question || question.length > 300 || neverSent(question) || CA.namesPlaceOrAmount(question)) return null;
  const key = type === 'radio' ? CA.classify(question) : answerKindForElement(el, question);
  if (!key || !LEARNABLE.has(key)) return null;
  shown = clean(shown);
  if (!shown || PLACEHOLDER.test(shown)) return null;
  if (YES_NO.has(key)) {
    const yn = yesNoOf(shown);
    return yn ? { key, value: yn, question } : null;
  }
  // A location box shows "Bellevue, Washington, United States": the city.
  const value = key === 'city' ? shown.split(',')[0].trim() : shown;
  return value && value.length <= 300 ? { key, value, question } : null;
}

/** Only on pages Landed filled, only what the user did. */
async function onChange(event) {
  if (!event.isTrusted || !deepAll('[data-landed-status]').length) return;
  const found = correctionOf(event.target);
  if (!found) return;
  const answers = await loadApplicationAnswers();
  const saved = answers && answers[found.key];
  if (typeof saved === 'string' && saved.toLowerCase() === found.value.toLowerCase()) return;
  try {
    chrome.runtime.sendMessage({ action: 'answer-corrected', key: found.key, value: found.value, question: found.question, site: location.hostname }, () => { void chrome.runtime.lastError; });
  } catch {
    // the extension was reloaded: nothing to tell
  }
}

if (typeof document !== 'undefined') document.addEventListener('change', (e) => { void onChange(e); }, true);

Object.assign(F, { correctionOf });
})(typeof window !== 'undefined' ? window : globalThis);
