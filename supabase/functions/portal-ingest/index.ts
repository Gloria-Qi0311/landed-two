// portal-ingest — Supabase Edge Function (Deno runtime).
//
// The MV3 browser extension (Sprint 4) POSTs portal events here. Each request:
//
//   1. Authenticates the user via their JWT in the Authorization header.
//      The function uses the ANON key + forwards the Authorization header
//      so every DB write goes through Postgres RLS — we never escalate to
//      service_role. If the extension's JWT is expired/invalid, the
//      Supabase client's auth call below returns no user and we 401.
//
//   2. Validates the JSON body against PortalEventIngestSchema (hand-rolled
//      to keep zero deps). Bad payloads → 400 with a per-field error map.
//
//   3. If company_id is present, upserts a portal_connections row keyed by
//      (user_id, company_id, provider) — same SELECT-then-UPDATE-or-INSERT
//      pattern as the client hook in apps/web/src/hooks/sync.ts. (Race-prone
//      across concurrent requests; the schema has no unique constraint on
//      that triple yet — see migration TODO in the README.)
//
//   4. Inserts a portal_events row tying the new event to the connection
//      (if upserted) and an optional application_id.
//
//   5. Returns { event_id, connection_id }.
//
// Deploy: `supabase functions deploy portal-ingest --no-verify-jwt`
//   — we use --no-verify-jwt because we do our own auth check (so we can
//     return a clean 401 with CORS headers; the built-in JWT verification
//     returns a 401 without CORS, which breaks preflighted browser calls).

// @ts-nocheck — Deno globals (Deno, fetch, Request) aren't visible to the
// repo's node-tsc; the function is typechecked at deploy time by the Supabase
// CLI / `deno check`. The file is still hand-typed; this only suppresses the
// "Cannot find name 'Deno'" noise when running tsc from the monorepo root.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { handlePreflight, jsonResponse } from '../_shared/cors.ts'

// ── DB enums (mirror supabase/migrations/20260516235333_initial_schema.sql)
const PROVIDERS = ['greenhouse', 'lever', 'workday', 'ashby', 'bamboohr', 'boss', 'smartrecruiters', 'other'] as const
const STATUSES = ['active', 'syncing', 'expired', 'disconnected'] as const
const EVENT_TYPES = ['status-change', 'new-event', 'expired', 'sync', 'rejection'] as const

type Provider = typeof PROVIDERS[number]
type Status = typeof STATUSES[number]
type EventType = typeof EVENT_TYPES[number]

type IngestBody = {
  provider: Provider
  event_type: EventType
  company_id?: string
  portal_host?: string
  status?: Status
  failure_reason?: string
  application_id?: string
  payload?: Record<string, unknown>
}

// ── Hand-rolled validator. Returns the parsed body or a per-field error map.
function validate(input: unknown): { ok: true; body: IngestBody } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: { _: 'body must be a JSON object' } }
  }
  const raw = input as Record<string, unknown>

  if (typeof raw.provider !== 'string' || !PROVIDERS.includes(raw.provider as Provider)) {
    errors.provider = `must be one of: ${PROVIDERS.join(', ')}`
  }
  if (typeof raw.event_type !== 'string' || !EVENT_TYPES.includes(raw.event_type as EventType)) {
    errors.event_type = `must be one of: ${EVENT_TYPES.join(', ')}`
  }
  if (raw.company_id !== undefined && (typeof raw.company_id !== 'string' || raw.company_id.length === 0)) {
    errors.company_id = 'must be a non-empty string (uuid)'
  }
  if (raw.status !== undefined && (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as Status))) {
    errors.status = `must be one of: ${STATUSES.join(', ')}`
  }
  if (raw.portal_host !== undefined && typeof raw.portal_host !== 'string') {
    errors.portal_host = 'must be a string'
  }
  if (raw.failure_reason !== undefined && typeof raw.failure_reason !== 'string') {
    errors.failure_reason = 'must be a string'
  }
  if (raw.application_id !== undefined && (typeof raw.application_id !== 'string' || raw.application_id.length === 0)) {
    errors.application_id = 'must be a non-empty string (uuid)'
  }
  if (raw.payload !== undefined && (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload))) {
    errors.payload = 'must be a JSON object'
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    body: {
      provider: raw.provider as Provider,
      event_type: raw.event_type as EventType,
      company_id: raw.company_id as string | undefined,
      portal_host: raw.portal_host as string | undefined,
      status: raw.status as Status | undefined,
      failure_reason: raw.failure_reason as string | undefined,
      application_id: raw.application_id as string | undefined,
      payload: (raw.payload as Record<string, unknown> | undefined),
    },
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed; POST only' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'missing or invalid Authorization header (expected: Bearer <jwt>)' }, 401)
  }

  // Anon key + forwarded Authorization so RLS scopes every write to the
  // authenticated user. Never use SERVICE_ROLE here.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'server misconfigured: missing SUPABASE_URL or SUPABASE_ANON_KEY env' }, 500)
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Resolve the user from the JWT — this is the real authn check.
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  if (userErr || !userData?.user?.id) {
    return jsonResponse({ error: 'invalid or expired token' }, 401)
  }
  const userId = userData.user.id

  // Parse + validate body.
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  const v = validate(raw)
  if (!v.ok) {
    return jsonResponse({ error: 'validation failed', fields: v.errors }, 400)
  }
  const body = v.body

  // ── Step 1: upsert portal_connections (only if company_id provided) ─────
  let connectionId: string | null = null
  if (body.company_id) {
    // Look up an existing row for (company_id, provider). RLS auto-scopes to
    // user_id = auth.uid(). If a future migration adds `unique (user_id,
    // company_id, provider)`, this round-trip becomes redundant — swap to a
    // single .upsert().
    const { data: existing, error: lookupErr } = await supabase
      .from('portal_connections')
      .select('id')
      .eq('company_id', body.company_id)
      .eq('provider', body.provider)
      .maybeSingle()
    if (lookupErr) {
      return jsonResponse({ error: 'portal_connections lookup failed', detail: lookupErr.message }, 500)
    }

    const connPatch = {
      portal_host: body.portal_host ?? null,
      status: body.status ?? 'active',
      last_sync_at: new Date().toISOString(),
      failure_reason: body.failure_reason ?? null,
    }

    if (existing?.id) {
      const { data, error } = await supabase
        .from('portal_connections')
        .update(connPatch)
        .eq('id', existing.id)
        .select('id')
        .single()
      if (error) {
        return jsonResponse({ error: 'portal_connections update failed', detail: error.message }, 500)
      }
      connectionId = data.id
    } else {
      const { data, error } = await supabase
        .from('portal_connections')
        .insert({
          user_id: userId,
          company_id: body.company_id,
          provider: body.provider,
          ...connPatch,
        })
        .select('id')
        .single()
      if (error) {
        return jsonResponse({ error: 'portal_connections insert failed', detail: error.message }, 500)
      }
      connectionId = data.id
    }
  }

  // ── Step 2: insert portal_events ────────────────────────────────────────
  const { data: eventRow, error: eventErr } = await supabase
    .from('portal_events')
    .insert({
      user_id: userId,
      connection_id: connectionId,
      application_id: body.application_id ?? null,
      type: body.event_type,
      payload_json: body.payload ?? {},
    })
    .select('id')
    .single()
  if (eventErr) {
    return jsonResponse({ error: 'portal_events insert failed', detail: eventErr.message }, 500)
  }

  return jsonResponse({
    event_id: eventRow.id,
    connection_id: connectionId,
  }, 201)
})
