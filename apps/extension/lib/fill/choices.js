// @ts-check
// lib/fill/choices.js — radio buttons and checkboxes answered from the saved application
// answers.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

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
    const scope = group.getRootNode && group.getRootNode().getElementById ? group.getRootNode() : document;
    const labelled = by ? by.split(/\s+/).map((id) => scope.getElementById(id)?.textContent || '').join(' ').trim() : '';
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

Object.assign(F, { loadApplicationAnswers, optionText, choiceGroupQuestion, groupChoices, clickChoice });
})(typeof window !== 'undefined' ? window : globalThis);
