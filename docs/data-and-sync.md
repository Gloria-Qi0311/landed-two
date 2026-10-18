# Data, Cloud sync and the server

## Local-first: everyone signs in, data stays in the browser

Every user signs in (email and password, `apps/server`). An account's data lives
in **its own** IndexedDB database in the browser (`landed-<userId>`,
`apps/web/src/lib/store/local.ts`, Dexie) unless the account turns on **Landed
Cloud sync** (`users.cloud_sync`). With sync on, the app uses
`apps/web/src/lib/store/cloud.ts`, which calls `apps/server`.

- **Turning sync on** uploads the device data and clears it from the device
  (`POST /api/cloud/enable`).
- **Turning sync off** copies Cloud data to the device, then deletes it
  server-side but keeps the account (`POST /api/cloud/disable`). The flows are in
  `apps/web/src/lib/cloud.ts`.

### The server enforces it

Every data route sits behind `requireCloud` and answers
`409 { code: 'cloud_off' }` for accounts with sync off. Only account-level routes
(`/auth/*`, `/me`, `/cloud/*`) work for everyone. Never add a data route outside
the `requireCloud` group, and never store user data server-side for a sync-off
account. The one exception is the cloud-agent briefing ([agents.md](agents.md#the-briefing)).

The signed-in account (`{id, email, cloud_sync}`, no secrets) is cached in
`localStorage['landed:account']`, so a sync-off account keeps working offline when
the server is unreachable. It's cleared on sign-out.

### The DataStore contract

Hooks and components only use `useStore()` for data. They never call `api`
directly for it. A new data operation goes on the `DataStore` interface
(`lib/store/types.ts`) and must be implemented in **both** `local.ts` and
`cloud.ts` (plus the server route), with the same defaults and validation, so
local data always uploads cleanly.

### Snapshots

The snapshot format (`landed-backup` v1) is shared by backup files,
`GET /api/export` and `POST /api/sync/upload`. Adding a table or column means
updating `SNAPSHOT_TABLES` and the types on the web side, and `COLUMNS` in
`apps/server/src/routes/sync.ts`. Bump `BACKUP_VERSION` if old files can't be read
as they are. Rows carry client-generated UUIDs, which is what makes upload
idempotent.

`POST /api/cloud/disable` deletes every data table for the account. A new table
must be added there too (`job_searches` and `agent_conversations` once stayed
behind).

### Local schema changes

Local schema changes go in a new Dexie `this.version(n)` block in `local.ts`.
Never edit an existing version. Two people adding a version at once will collide,
so put the number you take in the PR title and pull `main` first.

### Extension ↔ page bridge

In local mode the extension can't reach a server, so the open Landed tab pulls
queued portal events and pushes resumes, answers and files over
`window.postMessage` (`apps/web/src/hooks/extension-bridge.ts` ↔
`apps/extension/lib/web-bridge.js` + `lib/bridge-handler.js`). Every
read-modify-write of the extension's pending queue goes through `withQueueLock`
in `background.js`. Landed web origins are listed in both `lib/config.js`
(`WEB_ORIGINS`) and `manifest.json`. Keep them in sync when adding a production
origin.

## The server: `apps/server` + Postgres (no Supabase)

Supabase was removed. The API server (`apps/server`, Hono + postgres.js) owns
Cloud auth, every table, realtime and portal-ingest. It also serves the built
web app. Setup and deployment: [apps/server/README.md](../apps/server/README.md).

- **Every query is scoped by the session's user id** (`c.get('user').id`). There
  is no RLS behind you. A route that forgets `where user_id = …` leaks data across
  accounts.
- **Cross-user references are blocked in the schema.** Parent tables expose
  `unique (id, user_id)` and children use composite FKs
  `(parent_id, user_id) references parent (id, user_id)`. New child tables follow
  the same pattern.
- **Migrations are append-only.** Add `apps/server/migrations/NNNN_name.sql` and
  never edit one that has been applied. The server applies pending migrations on
  start (`pnpm migrate` runs them alone). Claim the number in the PR title.
- In Cloud mode the web app talks to the API only through
  `apps/web/src/lib/api.ts` (same-origin, httpOnly session cookie). The extension
  uses `lib/auth.js` (Bearer token in `chrome.storage.local`).
- **Realtime**: an insert on `portal_events` fires `pg_notify`, and
  `src/realtime.ts` fans it out to that user's SSE streams.

### `portal_connections` uses a real upsert

`portal_connections` has a `unique (user_id, company_id, provider)` constraint.
Both server write paths (`PUT /api/portal-connections` and
`POST /api/portal-ingest`) go through `upsertConnection()` in
`apps/server/src/routes/portal.ts`, one atomic statement. The local store does
the same inside one Dexie transaction on its `[company_id+provider]` index.

```sql
insert into portal_connections (...) values (...)
on conflict (user_id, company_id, provider) do update set ...
```

Do not re-introduce SELECT-then-UPDATE-or-INSERT. That was the racy pattern the
constraint was added to prevent.

## Per-user state lives in the data store, not localStorage

Account-level state (onboarding completion, preferences: things that should
follow the person to any device regardless of Cloud sync) goes in the `users` row
via `GET/PATCH /api/me`, read and written through `apps/web/src/hooks/profile.ts`
(the `useOnboardedAt` / `useMarkOnboarded` / `useResetOnboarded` pattern).
Job-hunt data never goes there. It belongs in the data store.

`localStorage` is only for client-local UI state: `landed:theme`,
`landed:last-email`, `landed:account` (the offline session cache above), URL
filter preferences. **Never** use it for state attached to a user. The
localStorage `landed:onboarded_at` flag was removed because it broke on sign-out
and leaked across accounts (commit `3d5a489`).
