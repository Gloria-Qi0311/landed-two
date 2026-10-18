// @ts-check
// lib/fill/frames.js — frames that hold a form tell the service worker, so a fill
// reaches forms embedded in iframes.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { deepAll, isRendered } = F;

// ─── frames that hold a form ──────────────────────────────────────────────
// Application forms often live in an iframe — an ATS embedded in a company's
// careers site, or its "Complete your profile" dialog. This script runs in
// every frame; one that shows a form (3+ fields, so not a chat box or a
// newsletter signup), now or after the user opens it, tells the service
// worker, which fills it along with the page (background.js → fillTab).
if (window.top !== window) {
  let reported = null;
  let timer = null;
  const report = () => {
    const fields = deepAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea, [role="combobox"]')
      .filter((el) => isRendered(el)).length;
    const hasForm = fields >= 3;
    if (hasForm === reported) return;
    reported = hasForm;
    try {
      chrome.runtime.sendMessage({ action: 'frame-form', hasForm }, () => void chrome.runtime.lastError);
    } catch { /* extension reloaded */ }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(report, 600); };
  later();
  try {
    new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* no DOM to watch */ }
}

})(typeof window !== 'undefined' ? window : globalThis);
