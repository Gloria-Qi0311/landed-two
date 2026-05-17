// portal-events-push — service-worker / content-script edition.
//
// Hand-mirrors packages/extension-core/src/portal-events-push.js. The
// ESM version is canonical (vitest lives alongside it). Loaded via
// `importScripts('lib/portal-events-push.js')` from background.js;
// registers on globalThis as `LandedPortalEventsPush`.
(function () {
  'use strict'

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

  function mapEventToRow(event, userId) {
    if (!event || !userId) return null
    const type = TYPE_FOR_KIND[event.kind] || 'new-event'
    const payload = {
      source: 'greenhouse',
      company: event.company || '',
      role: event.role || '',
      app_url: event.app_url || '',
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

  async function pushEvents(httpAdapter, supabaseUrl, anonKey, accessToken, rows) {
    if (!rows || rows.length === 0) return { ok: true, inserted: 0 }
    if (!accessToken) return { ok: false, needsAuth: true }
    if (!anonKey || /service_role/i.test(anonKey)) {
      return { ok: false, fatal: true, error: 'service_role refused; anon-key only' }
    }
    const url = supabaseUrl.replace(/\/+$/, '') + '/rest/v1/portal_events'
    let response
    try {
      response = await httpAdapter(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: 'Bearer ' + accessToken,
          Prefer: 'return=minimal',
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
    if (response.status >= 500) {
      return { ok: false, retryable: true, error: 'http ' + response.status }
    }
    let body = ''
    try { body = await response.text() } catch { /* ignore */ }
    return { ok: false, fatal: true, error: 'http ' + response.status + ': ' + body.slice(0, 200) }
  }

  const api = { mapEventToRow, pushEvents, nextBackoffMs }
  if (typeof globalThis !== 'undefined') globalThis.LandedPortalEventsPush = api
  else if (typeof self !== 'undefined') self.LandedPortalEventsPush = api
})()
