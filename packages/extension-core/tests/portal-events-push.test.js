// Tests for portal-events-push:
//   - mapEventToRow shape correctness across kinds
//   - pushEvents response classification (200/204 ok, 401 needsAuth,
//     5xx retryable, 4xx fatal, network error retryable)
//   - service_role guard refuses to push
import { describe, test, expect, vi } from 'vitest'
import { mapEventToRow, pushEvents } from '../src/portal-events-push.js'

const USER = 'user-uuid-1234'
const ANON = 'eyJhbGciOiJIUzI1NiIs.fake-anon-payload.signature'
const SR   = 'eyJhbGciOiJIUzI1NiIs.role-is-service_role-here.x'
const URL_ = 'https://abc.supabase.co'
const TOKEN = 'access-token-xyz'

function applied(extra = {}) {
  return {
    kind: 'applied',
    company: 'Acme',
    role: 'Engineer',
    applied_at: '2026-05-17T12:00:00.000Z',
    app_url: 'https://boards.greenhouse.io/acme/applications/abc',
    detected_via: 'url',
    ...extra,
  }
}

describe('mapEventToRow', () => {
  test('maps applied → status-change row with payload', () => {
    const row = mapEventToRow(applied(), USER)
    expect(row).toMatchObject({
      user_id: USER,
      type: 'status-change',
      payload_json: {
        source: 'greenhouse',
        company: 'Acme',
        role: 'Engineer',
        app_url: 'https://boards.greenhouse.io/acme/applications/abc',
        detected_via: 'url',
        raw_kind: 'applied',
        from: null,
        to: 'applied',
        applied_at: '2026-05-17T12:00:00.000Z',
      },
    })
    // No company_id / connection_id / application_id at the row level —
    // reconciliation back-fills those later. NULLs satisfied by schema.
    expect(row.company_id).toBeUndefined()
    expect(row.connection_id).toBeUndefined()
    expect(row.application_id).toBeUndefined()
  })

  test('maps already_applied → status-change (same destination)', () => {
    const row = mapEventToRow(applied({ kind: 'already_applied' }), USER)
    expect(row.type).toBe('status-change')
    expect(row.payload_json.raw_kind).toBe('already_applied')
    expect(row.payload_json.to).toBe('applied')
  })

  test('maps rejection → rejection (no from/to)', () => {
    const row = mapEventToRow(applied({ kind: 'rejection' }), USER)
    expect(row.type).toBe('rejection')
    expect(row.payload_json.from).toBeUndefined()
  })

  test('unknown kind falls through to new-event', () => {
    const row = mapEventToRow(applied({ kind: 'spam-i-made-up' }), USER)
    expect(row.type).toBe('new-event')
  })

  test('returns null for missing event or userId', () => {
    expect(mapEventToRow(null, USER)).toBeNull()
    expect(mapEventToRow(applied(), null)).toBeNull()
    expect(mapEventToRow(applied(), '')).toBeNull()
  })

  test('omits applied_at when absent (no synthetic value)', () => {
    const ev = applied()
    delete ev.applied_at
    const row = mapEventToRow(ev, USER)
    expect(row.payload_json.applied_at).toBeUndefined()
  })
})

describe('pushEvents', () => {
  function fakeFetch(status, body = '') {
    return vi.fn(async () => ({
      status,
      async text() { return body },
    }))
  }

  test('returns ok:true on 201', async () => {
    const fetch_ = fakeFetch(201)
    const rows = [mapEventToRow(applied(), USER)]
    const res = await pushEvents(fetch_, URL_, ANON, TOKEN, rows)
    expect(res).toEqual({ ok: true, inserted: 1 })
    expect(fetch_).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetch_.mock.calls[0]
    expect(calledUrl).toBe('https://abc.supabase.co/rest/v1/portal_events')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe(ANON)
    expect(init.headers.Authorization).toBe('Bearer ' + TOKEN)
    expect(init.headers.Prefer).toBe('return=minimal')
    expect(JSON.parse(init.body)).toHaveLength(1)
  })

  test('returns ok:true on 204', async () => {
    const res = await pushEvents(fakeFetch(204), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res.ok).toBe(true)
  })

  test('empty batch is a no-op success', async () => {
    const fetch_ = vi.fn()
    const res = await pushEvents(fetch_, URL_, ANON, TOKEN, [])
    expect(res).toEqual({ ok: true, inserted: 0 })
    expect(fetch_).not.toHaveBeenCalled()
  })

  test('returns needsAuth on 401 (queue stays for retry)', async () => {
    const res = await pushEvents(fakeFetch(401), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res).toEqual({ ok: false, needsAuth: true })
  })

  test('returns needsAuth on 403', async () => {
    const res = await pushEvents(fakeFetch(403), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res).toEqual({ ok: false, needsAuth: true })
  })

  test('returns needsAuth (without a token) — does not fetch', async () => {
    const fetch_ = vi.fn()
    const res = await pushEvents(fetch_, URL_, ANON, '', [mapEventToRow(applied(), USER)])
    expect(res).toEqual({ ok: false, needsAuth: true })
    expect(fetch_).not.toHaveBeenCalled()
  })

  test('returns retryable on 500', async () => {
    const res = await pushEvents(fakeFetch(500), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res.ok).toBe(false)
    expect(res.retryable).toBe(true)
  })

  test('returns retryable on 503', async () => {
    const res = await pushEvents(fakeFetch(503), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res.retryable).toBe(true)
  })

  test('returns retryable on network throw', async () => {
    const fetch_ = vi.fn(async () => { throw new Error('connection reset') })
    const res = await pushEvents(fetch_, URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res.ok).toBe(false)
    expect(res.retryable).toBe(true)
    expect(res.error).toMatch(/connection reset/)
  })

  test('returns fatal on 400 (schema mismatch — do not silently retry)', async () => {
    const res = await pushEvents(
      fakeFetch(400, '{"message":"column foo does not exist"}'),
      URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)],
    )
    expect(res.ok).toBe(false)
    expect(res.fatal).toBe(true)
    expect(res.error).toMatch(/column foo/)
  })

  test('returns fatal on 422', async () => {
    const res = await pushEvents(fakeFetch(422, ''), URL_, ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res.fatal).toBe(true)
  })

  test('REFUSES to push when given a service_role-shaped key', async () => {
    // Defense in depth: even if the caller accidentally passed a
    // service_role JWT, we hard-fail before the network. CLAUDE.md +
    // extension threat model: anon-only ever.
    const fetch_ = vi.fn()
    const res = await pushEvents(fetch_, URL_, SR, TOKEN, [mapEventToRow(applied(), USER)])
    expect(res).toEqual({ ok: false, fatal: true, error: 'service_role refused; anon-key only' })
    expect(fetch_).not.toHaveBeenCalled()
  })

  test('handles trailing slash on supabaseUrl', async () => {
    const fetch_ = fakeFetch(201)
    await pushEvents(fetch_, 'https://abc.supabase.co/', ANON, TOKEN, [mapEventToRow(applied(), USER)])
    expect(fetch_.mock.calls[0][0]).toBe('https://abc.supabase.co/rest/v1/portal_events')
  })
})
