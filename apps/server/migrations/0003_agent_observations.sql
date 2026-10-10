-- Agent connections are narrowly scoped credentials for external personal
-- agents. They are intentionally separate from browser/extension sessions:
-- an agent may submit observations, but cannot act as the user elsewhere in
-- the Landed API.
create table agent_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  display_name text not null,
  token_hash text not null unique,
  scopes text[] not null default array['observations:write']::text[],
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create index agent_connections_user_created_idx
  on agent_connections (user_id, created_at desc);

-- Raw, append-only facts reported by an agent. A later processor may match
-- these to canonical opportunities/applications; ingestion never mutates the
-- user's pipeline directly.
create table agent_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null,
  idempotency_key text not null,
  schema_version text not null,
  run_id text not null,
  observation_type text not null,
  payload_json jsonb not null,
  observed_at timestamptz not null,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processed', 'needs-review', 'rejected')),
  created_at timestamptz not null default now(),
  foreign key (connection_id, user_id)
    references agent_connections (id, user_id) on delete cascade,
  constraint agent_observations_connection_idempotency_unique
    unique (connection_id, idempotency_key)
);

create index agent_observations_user_created_idx
  on agent_observations (user_id, created_at desc);

create index agent_observations_pending_idx
  on agent_observations (user_id, created_at)
  where processing_status = 'pending';
