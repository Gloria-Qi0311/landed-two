// Pins the centralized sentinel constants + guards against drift with
// snapshot-store's internal PENDING_KEY (which is the producer side of
// the same key namespace). If snapshot-store ever changes its key, this
// test fails loudly so we don't silently desync the popup's readers.
const sentinels = require('../lib/portal-sentinels')
const { PENDING_KEY } = require('../lib/snapshot-store')

describe('portal-sentinels', () => {
  test('exports the documented keys (strict shape)', () => {
    // Strict shape — adding a sentinel here is a deliberate choice and
    // requires updating this test. Catches accidental additions that
    // would otherwise drift past the documented header.
    expect(sentinels).toEqual({
      NEEDS_AUTH_KEY: 'landed:portal-push-needs-auth',
      PENDING_QUEUE_KEY: 'landed:pending-portal-events',
      BACKOFF_STATE_KEY: 'landed:portal-push-backoff-state',
      FATAL_STATE_KEY: 'landed:portal-push-fatal',
    })
  })

  test('PENDING_QUEUE_KEY matches snapshot-store internal PENDING_KEY', () => {
    // snapshot-store.js predates this module and keeps its own PENDING_KEY
    // constant for self-contained-ness. They MUST stay in sync or the
    // popup will read an empty queue while the SW writes to a different key.
    expect(sentinels.PENDING_QUEUE_KEY).toBe(PENDING_KEY)
  })

  test('also exposes on globalThis (for content-script / SW importScripts)', () => {
    expect(globalThis.LandedPortalSentinels).toBe(sentinels)
  })
})
