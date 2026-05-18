// Cross-context constants for the portal-sync pipeline.
//
// These are the chrome.storage.local keys that multiple parts of the
// extension read/write to coordinate state. Each has at least three
// callers now, which is the threshold at which we centralize per
// Run-4 retro lessons (cross-ref comments stop scaling past 2 callers).
//
// NEEDS_AUTH_KEY callers:
//   - apps/extension/background.js (producer — set on 401/403, removed on
//     successful push)
//   - apps/extension/src/popup/App.tsx (consumer — useNeedsAuth hook;
//     surfaces the re-auth banner; clears optimistically on user re-auth)
//   - apps/extension/src/popup/* (#36.1 badge counter — also reads this)
//
// PENDING_QUEUE_KEY callers:
//   - apps/extension/lib/snapshot-store.js (producer — internal PENDING_KEY
//     export; kept as-is for backward-compat with existing tests)
//   - apps/extension/background.js (producer/consumer — drain path reads
//     + clears the queue)
//   - apps/extension/src/popup/* (#36.1 badge counter — reads the queue
//     length for the toolbar badge)
//
// snapshot-store.js does NOT import from here — it predates this module
// and keeps its own PENDING_KEY for self-contained-ness. Equality is
// guarded by a test in tests/portal-sentinels.test.js.
//
// Load shape: classic IIFE that registers on globalThis AND exposes
// module.exports (for jest). Vite-bundled popup imports the same file
// via the `@lib` alias — the module.exports branch makes the import
// work; otherwise it would fall back to the global registration.
(function (global) {
  'use strict'

  const NEEDS_AUTH_KEY = 'landed:portal-push-needs-auth'
  const PENDING_QUEUE_KEY = 'landed:pending-portal-events'
  // BACKOFF_STATE_KEY callers (#35.2):
  //   - apps/extension/background.js — drainPendingEvents reads to skip
  //     when next_retry_at > now; writes on retryable; clears on ok.
  // Shape: { consecutive_failures: number, next_retry_at: ISO string }.
  const BACKOFF_STATE_KEY = 'landed:portal-push-backoff-state'
  // FATAL_STATE_KEY callers (#35.4):
  //   - apps/extension/background.js (producer — set on pushEvents fatal:
  //     schema mismatch / RLS rejection; cleared on next ok push)
  //   - apps/extension/src/popup/App.tsx (consumer — useFatalState hook;
  //     surfaces a "Sync is misconfigured" banner so the user knows to
  //     check for an extension update rather than wonder why nothing's
  //     syncing).
  // Shape: { error: string, at: ISO string }.
  const FATAL_STATE_KEY = 'landed:portal-push-fatal'

  const api = { NEEDS_AUTH_KEY, PENDING_QUEUE_KEY, BACKOFF_STATE_KEY, FATAL_STATE_KEY }

  global.LandedPortalSentinels = api
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
