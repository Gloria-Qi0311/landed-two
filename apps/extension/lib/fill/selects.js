// @ts-check
// lib/fill/selects.js — native <select> dropdowns.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { markField } = F;
const VM = global.ResumeFillerValueMatch;

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

function setSelectOption(el, option) {
  el.value = option.value;
  option.selected = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  markField(el, 'filled');
}

Object.assign(F, { tryFillSelect, setSelectOption });
})(typeof window !== 'undefined' ? window : globalThis);
