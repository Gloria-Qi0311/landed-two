# CLAUDE.md

Project-specific instructions for Claude Code in this repository. Read this on session start; respect these conventions in all subsequent work.

## Commit attribution

Commit messages **MUST NOT** include any `Co-Authored-By: Claude …` trailer. All commits in this repository are authored solely by the project owner (AntaresYuan / chenjy4@uw.edu).

The git config on this machine is already set to that identity — no overrides needed. Just omit the trailer.

This applies to:
- Direct commits made by Claude Code in this repo
- Commits made via PR branches
- Squash-merge commit messages (use the PR title + a clean body; no trailer)

## Backend is self-hosted: `apps/server` + Postgres (no Supabase)

Supabase was removed. The API server (`apps/server`, Hono + postgres.js) owns auth, every table, realtime, and portal-ingest; it also serves the built web app. See `apps/server/README.md` for setup and deployment.

- **Every query is scoped by the session's user id** (`c.get('user').id`) — there is no RLS behind you. A route that forgets `where user_id = …` leaks data across accounts.
- **Cross-user references are blocked in the schema**: parent tables expose `unique (id, user_id)` and children use composite FKs `(parent_id, user_id) references parent (id, user_id)`. New child tables must follow the same pattern.
- **Migrations are append-only**: add `apps/server/migrations/NNNN_name.sql`; never edit one that has been applied. The server applies pending migrations on start (`pnpm migrate` to run them alone).
- The web app talks to the API only through `apps/web/src/lib/api.ts` (same-origin, httpOnly session cookie). The extension uses `lib/auth.js` (Bearer token in `chrome.storage.local`).

## Per-user state lives server-side, not localStorage

Anything tied to user identity (onboarding completion, preferences, anything that should survive sign-out and sync across devices) goes in the `users` table — read/write via `apps/web/src/hooks/profile.ts` (`useOnboardedAt` / `useMarkOnboarded` / `useResetOnboarded` pattern), backed by `GET/PATCH /api/me`.

`localStorage` is reserved for genuinely client-local UI state: `landed:theme`, `landed:last-email`, URL filter preferences. **Never** use it for user-attached state — the localStorage `landed:onboarded_at` flag was removed because it broke on sign-out and leaked across accounts (commit `3d5a489`).

## portal_connections uses a real upsert

`portal_connections` has a `unique (user_id, company_id, provider)` constraint. Both write paths (`PUT /api/portal-connections` and `POST /api/portal-ingest`) go through `upsertConnection()` in `apps/server/src/routes/portal.ts`, a single atomic statement:

```sql
insert into portal_connections (...) values (...)
on conflict (user_id, company_id, provider) do update set ...
```

**Do not re-introduce SELECT-then-UPDATE-or-INSERT** — that was the racey pattern the constraint was added to prevent.

## (more conventions land here as they're established)
