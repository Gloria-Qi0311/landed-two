# CLAUDE.md

Project-specific instructions for Claude Code in this repository. Read this on session start; respect these conventions in all subsequent work.

## Commit attribution

Commit messages **MUST NOT** include any `Co-Authored-By: Claude …` trailer. All commits in this repository are authored solely by the project owner (AntaresYuan / chenjy4@uw.edu).

The git config on this machine is already set to that identity — no overrides needed. Just omit the trailer.

This applies to:
- Direct commits made by Claude Code in this repo
- Commits made via PR branches
- Squash-merge commit messages (use the PR title + a clean body; no trailer)

## Per-user state lives server-side, not localStorage

Anything tied to user identity (onboarding completion, preferences, anything that should survive sign-out and sync across devices) goes in `public.users` — read/write via `apps/web/src/hooks/profile.ts` (`useOnboardedAt` / `useMarkOnboarded` / `useResetOnboarded` pattern). RLS auto-scopes to `auth.uid()`.

`localStorage` is reserved for genuinely client-local UI state: `landed:theme`, URL filter preferences. **Never** use it for user-attached state — the localStorage `landed:onboarded_at` flag was removed because it broke on sign-out and leaked across accounts (commit `3d5a489`).

## portal_connections uses real `.upsert()`

Since migration `20260517070000_portal_connections_unique.sql`, `portal_connections` has a `unique (user_id, company_id, provider)` constraint. Both the client hook (`apps/web/src/hooks/sync.ts`) and the Edge Function (`supabase/functions/portal-ingest/index.ts`) use a single atomic call:

```ts
supabase.from('portal_connections').upsert(row, {
  onConflict: 'user_id,company_id,provider',
})
```

**Do not re-introduce SELECT-then-UPDATE-or-INSERT** — that was the racey pattern the constraint was added to prevent.

## (more conventions land here as they're established)
