// @ts-check
// lib/fill/portal.js — candidate-portal pages ("thanks for applying", "applied") →
// events the service worker stores (lib/portal-parsers).
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});

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

Object.assign(F, { detectPortalEventForCurrentPage });
})(typeof window !== 'undefined' ? window : globalThis);
