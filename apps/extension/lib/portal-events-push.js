// portal-events-push — service-worker / content-script edition.
//
// Hand-mirrors packages/extension-core/src/portal-events-push.js. The
// ESM version is canonical (vitest lives alongside it). Loaded via
// `importScripts('lib/portal-events-push.js')` from background.js;
// registers on globalThis as `LandedPortalEventsPush`.
(function () {
  'use strict'

  const PII_QUERY_PARAMS = new Set([
    'email', 'candidate_email', 'applicant_email', 'user_email', 'contact_email',
    'token', 'access_token', 'auth_token', 'session_token', 'session_id',
    'sessionId', 'sessionid', 'oauth_token', 'id_token',
    'code', 'state',
    'candidate_id', 'applicant_id', 'user_id',
    'continue', 'redirect', 'return_to', 'returnto', 'returnTo',
    'phone', 'phone_number',
  ])

  function sanitizeAppUrl(url) {
    if (!url || typeof url !== 'string') return url
    let parsed
    try { parsed = new URL(url) } catch { return url }
    const stripped = []
    for (const [key] of parsed.searchParams) {
      if (PII_QUERY_PARAMS.has(key)) stripped.push(key)
    }
    for (const key of stripped) parsed.searchParams.delete(key)
    parsed.hash = ''
    return parsed.toString()
  }

  const BACKOFF_SCHEDULE_MS = [60_000, 120_000, 300_000, 900_000, 3_600_000]

  function nextBackoffMs(consecutiveFailures) {
    const n = Math.max(0, (consecutiveFailures | 0) - 1)
    const idx = Math.min(n, BACKOFF_SCHEDULE_MS.length - 1)
    return BACKOFF_SCHEDULE_MS[idx]
  }

  const TYPE_FOR_KIND = {
    applied: 'status-change',
    already_applied: 'status-change',
    'status-change': 'status-change',
    rejection: 'rejection',
  }

  const LANDED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isLandedId = (v) => typeof v === 'string' && LANDED_ID.test(v)

  function mapEventToRow(event, userId) {
    if (!event || !userId) return null
    const type = TYPE_FOR_KIND[event.kind] || 'new-event'
    const payload = {
      source: 'greenhouse',
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
    // Set when the tab was opened from Landed with Apply Assist: which
    // application / lead the submission belongs to, whatever the page calls it.
    if (isLandedId(event.application_id)) payload.application_id = event.application_id
    if (isLandedId(event.lead_id)) payload.lead_id = event.lead_id
    return {
      user_id: userId,
      type,
      payload_json: payload,
    }
  }

  async function pushEvents(httpAdapter, apiUrl, accessToken, rows) {
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
      return { ok: false, retryable: true, error: String(err) }
    }
    if (response.status === 201 || response.status === 200 || response.status === 204) {
      return { ok: true, inserted: rows.length }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, needsAuth: true }
    }
    if (response.status === 409) {
      return { ok: false, cloudOff: true }
    }
    if (response.status >= 500) {
      return { ok: false, retryable: true, error: 'http ' + response.status }
    }
    let body = ''
    try { body = await response.text() } catch { /* ignore */ }
    return { ok: false, fatal: true, error: 'http ' + response.status + ': ' + body.slice(0, 200) }
  }

  const api = { mapEventToRow, pushEvents, nextBackoffMs, sanitizeAppUrl }
  if (typeof globalThis !== 'undefined') globalThis.LandedPortalEventsPush = api
  else if (typeof self !== 'undefined') self.LandedPortalEventsPush = api
})()
