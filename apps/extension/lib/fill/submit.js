// @ts-check
// lib/fill/submit.js — the final, deliberately narrow submission step.
//
// This module does not decide whether submission is authorized. The service
// worker owns that per-tab capability and sends `submit-application` only for
// an application created from a lead the user approved. Here we re-check the
// page itself, refuse blockers / yellow fields / missing required fields, and
// click exactly one unambiguous final-submit control. "Next", "Continue",
// "Review" and generic "Apply now" controls are intentionally not candidates.

(function (global) {
const F = global.LandedFill || (global.LandedFill = {});

const FINAL_SUBMIT = /^(submit(?: (?:my|this|your))? application|submit|send application|complete application|finish application|提交申请|提交)$/i;

function buttonText(el) {
  const value = el instanceof HTMLInputElement ? el.value : '';
  return String(value || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function enabled(el) {
  return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && (!F.isRendered || F.isRendered(el));
}

function isEmptyRequired(el) {
  if (!enabled(el)) return false;
  if (!(el.required || el.getAttribute('aria-required') === 'true')) return false;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'radio') {
      const name = el.name;
      const root = /** @type {Document | ShadowRoot | HTMLFormElement} */ (el.form || el.getRootNode());
      const radios = name
        ? Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
        : [el];
      return !radios.some((radio) => radio instanceof HTMLInputElement && radio.checked);
    }
    if (el.type === 'checkbox') return !el.checked;
    if (el.type === 'file') return !el.files || el.files.length === 0;
  }
  return !String(el.value || '').trim();
}

/** Inspect again immediately before the click. Values never leave the page. */
function inspectApplicationSubmit() {
  const blocker = F.detectApplyBlocker && F.detectApplyBlocker();
  if (blocker) return { ok: false, blocker };
  const all = F.deepAll || ((selector) => Array.from(document.querySelectorAll(selector)));
  if (all('[data-landed-status="review"]').some(enabled)) {
    return { ok: false, blocker: { kind: 'review', message: 'Landed or its reviewer flagged a field to check' } };
  }
  const missing = all('input[required], select[required], textarea[required], [aria-required="true"]').filter(isEmptyRequired);
  if (missing.length) {
    return { ok: false, blocker: { kind: 'answers', message: `${missing.length} required field${missing.length === 1 ? '' : 's'} still need an answer` } };
  }
  const candidates = all('button, input[type="submit"], input[type="button"], [role="button"]')
    .filter(enabled)
    .filter((el) => FINAL_SUBMIT.test(buttonText(el)));
  if (candidates.length !== 1) {
    return {
      ok: false,
      blocker: {
        kind: 'submit',
        message: candidates.length ? 'More than one final submit control is visible' : 'No unambiguous final submit control is visible',
      },
    };
  }
  return { ok: true, button: candidates[0], label: buttonText(candidates[0]) };
}

/** Return before clicking so the service worker can persist `submitting`.
 * The zero-delay click still happens in the same page and uses the portal's
 * own handler; confirmation is observed separately after navigation. */
function submitApplication() {
  const inspected = inspectApplicationSubmit();
  if (!inspected.ok) return inspected;
  setTimeout(() => inspected.button.click(), 0);
  return { ok: true, submitted: true, label: inspected.label };
}

Object.assign(F, { inspectApplicationSubmit, submitApplication });
})(typeof window !== 'undefined' ? window : globalThis);
