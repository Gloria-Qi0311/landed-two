// Push staged portal events to the Landed API.
//
// Drains the pending-event queue (see snapshot-store.js) by POSTing each
// event as a `portal_events` row via PostgREST. Pure logic — takes a
// fetch-shaped httpAdapter so vitest can stub the network entirely.
//
// ── Schema reality check (the wake-prompt asked about company_id) ────────
//
// `portal_events` (from migrations/20260516235333_initial_schema.sql) has:
//
//   user_id        not null   → must be set explicitly (no default)
//   connection_id  nullable   → FK to portal_connections (the user may
//                                 not have a matching row — fine, null)
//   application_id nullable   → FK to applications (the matching applica-
//                                 tion may not exist yet — fine, null)
//   type           enum       → 'status-change' | 'new-event' | 'expired'
//                                | 'sync' | 'rejection'
//   payload_json   jsonb      → arbitrary metadata
//
// No `company_id` column. So we don't have to upsert into companies at
// push time (avoiding the SELECT-then-INSERT race the CLAUDE.md warns
// about). Company name + role + app_url + applied_at all ride in
// payload_json. A future reconciliation step (#36+ or a server-side job)
// can match payload_json.company → companies row and back-fill
// connection_id / application_id.
//
// ── Event-kind mapping ───────────────────────────────────────────────────
//
// snapshot-store events → portal_events.type:
//   'applied'           → 'status-change' (payload: from=null, to='applied')
//   'already_applied'   → 'status-change' (payload: from=null, to='applied')
//   'status-change'     → 'status-change' (passthrough)
//   'rejection'         → 'rejection'
//   other / unknown     → 'new-event'    (preserved as raw signal)
//
// Both 'applied' and 'already_applied' map to status-change because they
// both represent "we now know the user has submitted this application."
// The detected_via field distinguishes them in payload_json for debugging.

// ── Exponential backoff schedule for retryable failures ─────────────────
//
// Without backoff, drainPendingEvents fires every 1min — on a sustained
// outage that's 60 pointless requests/hour against a server that's
// already failing. The schedule below stretches retries during outages
// while staying fast enough on transient blips that a single 5xx
// doesn't cost the user a meaningful delay.
//
// Index 0 = after 1st failure (1min), capped at index 4 (60min).
// On `ok` outcome, caller resets `consecutiveFailures` to 0.
// On `needsAuth`, caller skips backoff entirely (user re-auth unblocks).
// On `fatal`, caller drops the queue + skips backoff.
const BACKOFF_SCHEDULE_MS = [
  60_000,      // 1 minute  (1st retry)
  120_000,     // 2 minutes (2nd)
  300_000,     // 5 minutes (3rd)
  900_000,     // 15 minutes (4th)
  3_600_000,   // 60 minutes (5th+ — cap)
]

/** Backoff delay for the Nth consecutive retryable failure (0-indexed
 *  here, but the typical caller passes `consecutive_failures` from
 *  chrome.storage which counts from 1). Treats any value ≥ schedule
 *  length as the cap. Returns ms.
 *  @param {number} consecutiveFailures  count of consecutive retryable
 *    failures since last success. After the FIRST failure, pass 1.
 */
export function nextBackoffMs(consecutiveFailures) {
  const n = Math.max(0, (consecutiveFailures | 0) - 1)
  const idx = Math.min(n, BACKOFF_SCHEDULE_MS.length - 1)
  return BACKOFF_SCHEDULE_MS[idx]
}

// ── PII sanitization for app_url (#34.2) ────────────────────────────────
//
// Portal application URLs occasionally surface PII via query params:
// candidate emails on Greenhouse referral links, signed access tokens
// on Lever guest-apply flows, session ids on Workday SAML callbacks.
// Those land in `payload_json.app_url` and are stored server-side in the
// user's portal_events rows. Strip the well-known offenders before writing.
//
// Conservative allow-removal list — only params we KNOW carry PII. We
// don't strip unknown params (some are load-bearing for the URL: gh_jid,
// gh_src, lever-source — they identify the listing, not the candidate).

const PII_QUERY_PARAMS = new Set([
  // Email-shaped
  'email', 'candidate_email', 'applicant_email', 'user_email', 'contact_email',
  // Token-shaped — bearer credentials in URLs are always a bad sign
  'token', 'access_token', 'auth_token', 'session_token', 'session_id',
  'sessionId', 'sessionid', 'oauth_token', 'id_token',
  // OAuth code/state — short-lived but still credentials in URLs.
  // Also: `continue=...` carries Google SSO redirect-back URLs, often
  // with the user email — strip even though it occasionally smashes a
  // portal's post-apply redirect target (acceptable trade for PII).
  'code', 'state',
  // Candidate-identity IDs — these are PII (the user IS the candidate);
  // a back-end with one can correlate across listings.
  'candidate_id', 'applicant_id', 'user_id',
  // Tracking params that often carry an email
  'continue', 'redirect', 'return_to', 'returnto', 'returnTo',
  // Phone-shaped
  'phone', 'phone_number',
])

/** Strip known PII query params from a URL while preserving everything
 *  else (path, host, listing-identifying params). Returns the cleaned
 *  URL string. On parse failure, returns the input unchanged — we'd
 *  rather emit a slightly-leaky `app_url` than no `app_url` at all,
 *  since the latter breaks dedup in snapshot-store.
 *
 *  @param {string} url
 *  @returns {string}
 */
export function sanitizeAppUrl(url) {
  if (!url || typeof url !== 'string') return url
  let parsed
  try { parsed = new URL(url) }
  catch { return url }
  // URL.searchParams is mutable; build a clean copy so we don't mangle
  // the order of preserved params.
  const stripped = []
  for (const [key] of parsed.searchParams) {
    if (PII_QUERY_PARAMS.has(key)) stripped.push(key)
  }
  for (const key of stripped) parsed.searchParams.delete(key)
  // Also strip URL fragments — those routinely carry session-restore
  // state in SPAs (Workday in particular).
  parsed.hash = ''
  return parsed.toString()
}

const TYPE_FOR_KIND = {
  applied: 'status-change',
  already_applied: 'status-change',
  'status-change': 'status-change',
  rejection: 'rejection',
}

/** Translate a snapshot-store event into a portal_events row.
 *  payload_json captures the source signal so reconciliation can match
 *  back to applications / companies later.
 *
 *  @param {object} event   shape per snapshot-store.js
 *  @param {string} userId  auth.uid() — required by NOT NULL constraint
 *  @returns {object}       a row ready to POST to /api/portal-events
 */
export function mapEventToRow(event, userId) {
  if (!event || !userId) return null
  const type = TYPE_FOR_KIND[event.kind] || 'new-event'
  const payload = {
    source: 'greenhouse',  // hard-coded for now; #33.1+ adds Lever / etc.
    company: event.company || '',
    role: event.role || '',
    app_url: sanitizeAppUrl(event.app_url || ''),
    detected_via: event.detected_via || 'unknown',
    raw_kind: event.kind,
  }
  if (type === 'status-change') {
    payload.from = null
    payload.to = 'applied'
  }
  if (event.applied_at) payload.applied_at = event.applied_at
  return {
    user_id: userId,
    type,
    payload_json: payload,
  }
}

/** POST a batch of events to the Landed API (/api/portal-events).
 *
 *  Outcomes:
 *    - `{ ok: true,  inserted: N }`          — all rows landed; caller drops queue
 *    - `{ ok: false, needsAuth: true }`      — 401/403; queue stays for retry
 *    - `{ ok: false, retryable: true }`      — 5xx / network; queue stays
 *    - `{ ok: false, fatal: true,  error }`  — 400 (schema mismatch); queue
 *                                                stays but log loudly — needs
 *                                                a code fix, not a retry
 *
 *  Caller decides whether to clear the pending queue based on `ok`.
 *
 *  @param {Function} httpAdapter  fetch-shaped function (url, init) → Response
 *  @param {string}   apiUrl       Landed API origin, e.g. https://landed.example.com
 *  @param {string}   accessToken  the user's session token from lib/auth.js
 *  @param {object[]} rows         already mapped via mapEventToRow
 */
export async function pushEvents(httpAdapter, apiUrl, accessToken, rows) {
  if (!rows || rows.length === 0) return { ok: true, inserted: 0 }
  if (!accessToken) return { ok: false, needsAuth: true }
  const url = apiUrl.replace(/\/+$/, '') + '/api/portal-events'
  let response
  try {
    response = await httpAdapter(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + accessToken,
      },
      body: JSON.stringify(rows),
    })
  } catch (err) {
    // network error / fetch threw
    return { ok: false, retryable: true, error: String(err) }
  }
  if (response.status === 201 || response.status === 200 || response.status === 204) {
    return { ok: true, inserted: rows.length }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, needsAuth: true }
  }
  if (response.status >= 500) {
    return { ok: false, retryable: true, error: `http ${response.status}` }
  }
  // 4xx that isn't auth — schema mismatch, ownership rejection, etc. Don't
  // retry blindly (the next push would fail the same way + grow the
  // queue forever).
  let body = ''
  try { body = await response.text() } catch { /* ignore */ }
  return { ok: false, fatal: true, error: `http ${response.status}: ${body.slice(0, 200)}` }
}
