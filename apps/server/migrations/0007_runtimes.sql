-- 0007 runtimes — the user's own computers running the Landed daemon
-- (apps/daemon). Like Multica: the daemon finds agent CLIs installed on the
-- machine (Claude Code, Codex, Gemini CLI) and runs Landed's tasks with them,
-- on the user's existing subscriptions — no API cost. The server only relays
-- tasks and their output (in memory, never stored), so conversations stay
-- between the browser and the user's machine.

create table runtimes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  -- what the daemon found on PATH, e.g. [{"id":"claude","label":"Claude Code","version":"2.1.284"}]
  agents jsonb not null default '[]'::jsonb,
  daemon_version text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index runtimes_user_created_idx on runtimes (user_id, created_at desc);
