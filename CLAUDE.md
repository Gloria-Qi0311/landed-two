# CLAUDE.md

Project-specific instructions for Claude Code in this repository. Read this on session start; respect these conventions in all subsequent work.

## Commit attribution

Commit messages **MUST NOT** include any `Co-Authored-By: Claude …` trailer. All commits in this repository are authored solely by the project owner (AntaresYuan / chenjy4@uw.edu).

The git config on this machine is already set to that identity — no overrides needed. Just omit the trailer.

This applies to:
- Direct commits made by Claude Code in this repo
- Commits made via PR branches
- Squash-merge commit messages (use the PR title + a clean body; no trailer)

## Local-first: data lives in the browser unless the user turns on Landed Cloud

By default every row lives in the browser's IndexedDB (`apps/web/src/lib/store/local.ts`, Dexie) — no account, nothing sent to a server. **Landed Cloud** is opt-in: signing in switches the app to `apps/web/src/lib/store/cloud.ts`, which talks to `apps/server`. Turning Cloud on uploads the device snapshot and clears the device; leaving Cloud downloads it back and deletes the account (`apps/web/src/lib/cloud.ts`).

- **Hooks and components only use `useStore()`** — never call `api` directly for data. A new data operation goes on the `DataStore` interface (`lib/store/types.ts`) and must be implemented in **both** `local.ts` and `cloud.ts` (+ the server route), with the same defaults and validation, so local data always uploads cleanly.
- **Snapshot format** (`landed-backup` v1) is shared by backup files, `GET /api/export` and `POST /api/sync/upload`. Adding a table or column means updating `SNAPSHOT_TABLES` / types on the web side and `COLUMNS` in `apps/server/src/routes/sync.ts`; bump `BACKUP_VERSION` if old files can't be read as-is. Rows carry client-generated UUIDs, which is what makes upload idempotent.
- Local schema changes go in a new Dexie `this.version(n)` block in `local.ts`; never edit an existing version.
- **Extension ↔ page bridge**: in local mode the extension can't reach a server, so the open Landed tab pulls queued portal events and pushes resumes over `window.postMessage` (`apps/web/src/hooks/extension-bridge.ts` ↔ `apps/extension/lib/web-bridge.js` + `lib/bridge-handler.js`). Every read-modify-write of the extension's pending queue goes through `withQueueLock` in `background.js`. Landed web origins are listed in both `lib/config.js` (`WEB_ORIGINS`) and `manifest.json` — keep them in sync when adding a production origin.

## Landed Cloud backend: `apps/server` + Postgres (no Supabase)

Supabase was removed. The API server (`apps/server`, Hono + postgres.js) owns Cloud auth, every table, realtime, and portal-ingest; it also serves the built web app. See `apps/server/README.md` for setup and deployment.

- **Every query is scoped by the session's user id** (`c.get('user').id`) — there is no RLS behind you. A route that forgets `where user_id = …` leaks data across accounts.
- **Cross-user references are blocked in the schema**: parent tables expose `unique (id, user_id)` and children use composite FKs `(parent_id, user_id) references parent (id, user_id)`. New child tables must follow the same pattern.
- **Migrations are append-only**: add `apps/server/migrations/NNNN_name.sql`; never edit one that has been applied. The server applies pending migrations on start (`pnpm migrate` to run them alone).
- In Cloud mode the web app talks to the API only through `apps/web/src/lib/api.ts` (same-origin, httpOnly session cookie). The extension uses `lib/auth.js` (Bearer token in `chrome.storage.local`).

## Per-user state lives in the data store, not localStorage

Anything tied to the user (onboarding completion, preferences, anything that should move with their data to and from Cloud) goes through the store's profile — `apps/web/src/hooks/profile.ts` (`useOnboardedAt` / `useMarkOnboarded` / `useResetOnboarded` pattern), backed by the local `meta` table or `users` via `GET/PATCH /api/me`.

`localStorage` is reserved for genuinely client-local UI state: `landed:theme`, `landed:last-email`, `landed:mode` (which store this device last used), URL filter preferences. **Never** use it for user-attached state — the localStorage `landed:onboarded_at` flag was removed because it broke on sign-out and leaked across accounts (commit `3d5a489`).

## portal_connections uses a real upsert

`portal_connections` has a `unique (user_id, company_id, provider)` constraint. Both server write paths (`PUT /api/portal-connections` and `POST /api/portal-ingest`) go through `upsertConnection()` in `apps/server/src/routes/portal.ts`, a single atomic statement (the local store does the same inside one Dexie transaction on its `[company_id+provider]` index):

```sql
insert into portal_connections (...) values (...)
on conflict (user_id, company_id, provider) do update set ...
```

**Do not re-introduce SELECT-then-UPDATE-or-INSERT** — that was the racey pattern the constraint was added to prevent.

## (more conventions land here as they're established)
