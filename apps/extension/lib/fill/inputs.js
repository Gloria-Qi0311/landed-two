// @ts-check
// lib/fill/inputs.js — text fields filled from the resume.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { addManual, fillField, isDateField, isSensitiveLabel, resumeValueForElement, workdayOptionalBlank } = F;
const { normalize, getFieldLabel, matchResumeKey } = global.ResumeFillerFieldDetect;
const CL = global.ResumeFillerCrossLingual;

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
    if (workdayOptionalBlank(el, label)) continue;
    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const raw = CL.maybeTranslate(key, flat[key], getFieldLabel(el));
      const value = resumeValueForElement(el, key, raw, label);
      if (value) {
        fillField(el, value);
        filled.push(key);
      }
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

Object.assign(F, { fillInputBatch });
})(typeof window !== 'undefined' ? window : globalThis);
