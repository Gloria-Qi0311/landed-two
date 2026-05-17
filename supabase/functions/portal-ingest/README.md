# portal-ingest

Edge Function that the MV3 browser extension (Sprint 4) POSTs to whenever it detects a portal event — a stage change scraped from Greenhouse/Lever/Workday, an expired login cookie, a sync run completing, etc.

## Endpoint

```
POST  /functions/v1/portal-ingest
```

## Auth

`Authorization: Bearer <user JWT>` — the extension reads this from the user's Landed session. The function uses the **anon key + forwards the Authorization header**, so every DB write goes through Postgres RLS scoped to that user. Service_role is never used here.

## Body

```jsonc
{
  // required
  "provider":   "greenhouse",          // greenhouse | lever | workday | ashby | bamboohr | boss | smartrecruiters | other
  "event_type": "status-change",       // status-change | new-event | expired | sync | rejection

  // optional — if company_id is present, the function upserts a portal_connections
  // row for (company_id, provider) and links the event to it.
  "company_id":      "f47ac10b-...",   // uuid of a public.companies row owned by the user
  "portal_host":     "boards.greenhouse.io",
  "status":          "active",         // active | syncing | expired | disconnected
  "failure_reason":  "session cookie expired",

  // optional — link the event to a specific application row
  "application_id":  "9a3b...-uuid",

  // optional — arbitrary jsonb payload (the extension's diff, raw HTML excerpt,
  // detected interview time, etc.)
  "payload": {
    "from": "applied",
    "to":   "phone",
    "detail": "Interviewer set up final round for Apr 23"
  }
}
```

## Response

```json
{ "event_id": "ev-uuid", "connection_id": "conn-uuid-or-null" }
```

- `201 Created` on success.
- `400` on validation failure (`{ error, fields: { provider: '...', ... } }`).
- `401` if Authorization is missing/invalid or the JWT is expired.
- `405` for non-POST methods.
- `500` for DB errors (with `detail` from the Postgres error).

## Deploy

The function is checked into `supabase/functions/portal-ingest/` but **not auto-deployed by CI**. Deploy manually:

```bash
# from repo root, after `supabase login`
supabase functions deploy portal-ingest --no-verify-jwt --project-ref pkwhsgdvosghdjsacomj
```

`--no-verify-jwt` is used because the function does its own auth check (so it can return a clean 401 with CORS headers; the built-in JWT verification returns a 401 without CORS, which breaks preflighted browser calls from the extension).

## Smoke test (curl)

```bash
# Replace <jwt> with a real session token; copy from the Network tab in the web
# app's devtools (any Supabase request → Authorization header).
JWT=...
PROJECT=pkwhsgdvosghdjsacomj

curl -i -X POST "https://${PROJECT}.supabase.co/functions/v1/portal-ingest" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "greenhouse",
    "event_type": "sync",
    "payload": { "detected": 0, "source": "manual-test" }
  }'
```

Expect `201 Created` + `{ event_id, connection_id: null }`. Verify in the dashboard:

```sql
select id, type, created_at from portal_events order by created_at desc limit 5;
```

## Race / idempotency caveats

- The `(company_id, provider)` upsert is client-side SELECT-then-UPDATE-or-INSERT. Two concurrent requests for the same key can both miss the SELECT and double-insert. **Mitigation (future migration)**: add `unique (user_id, company_id, provider)` to `portal_connections` and swap to a single `.upsert()` call. The extension service worker will likely batch its writes so this race is unlikely in practice — but worth fixing before opening this endpoint to a non-trusted client.
- `portal_events` is append-only by design — re-sending the same event creates duplicates. The extension is expected to dedupe client-side using its own `last_seen_event_id` cursor.

## Related

- `supabase/functions/_shared/cors.ts` — CORS preflight + JSON response helpers.
- `supabase/migrations/20260516235333_initial_schema.sql` — `portal_connections` + `portal_events` tables and their enums.
- `apps/web/src/hooks/sync.ts` — client-side equivalent (used today by the DEV seed); will be deprecated once the extension is wired up.
