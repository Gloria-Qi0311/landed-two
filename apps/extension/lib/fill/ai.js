// @ts-check
// lib/fill/ai.js — the local-model fallbacks: unknown text fields → a resume key,
// unanswered choice questions → an option. The model never invents values.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { canAskModel, deepAll, fillField, markField, tryFillCombobox, tryFillSelect } = F;
const CA = global.LandedChoiceAnswers;

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
    (c.group || [deepAll(`[data-landed-field-id="${c.id}"]`)[0]]).forEach((el) => el && markField(el, 'filled'));
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
    const target = deepAll(`[data-landed-field-id="${item.id}"]`)[0];
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

Object.assign(F, { runChoiceFallback, runLLMFallback, applySuggestedValues });
})(typeof window !== 'undefined' ? window : globalThis);
