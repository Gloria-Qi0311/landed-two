-- 0016 cloud_agents — cloud agents (ChatGPT, Claude.ai, Gemini, Manus…)
-- connect to Landed as a remote MCP server (/mcp), authorized with OAuth 2.1:
-- dynamic client registration + authorization code with PKCE + rotating
-- refresh tokens. Each authorization is an agent connection like the
-- token-based ones, so it is listed, used and revoked the same way, and what
-- it reports goes through the same observation relay.

-- Clients that registered themselves (RFC 7591). Public clients (PKCE only)
-- have no secret; confidential ones get one, stored hashed.
create table oauth_clients (
  id text primary key,
  name text not null,
  redirect_uris text[] not null,
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash text,
  created_at timestamptz not null default now()
);

-- One-time authorization codes (10 minutes), stored hashed.
create table oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index oauth_codes_expiry_idx on oauth_codes (expires_at);

alter table agent_connections
  add column oauth_client_id text references oauth_clients (id) on delete set null,
  add column refresh_hash text unique,
  add column token_expires_at timestamptz;

-- What cloud agents read through `get_tasks`: the confirmed search brief and
-- the application list (company, role, stage). Cloud agents run in the
-- cloud by definition, so for accounts with Cloud sync off this is the one
-- thing the browser deliberately shares with the server — only while the
-- account has a connected cloud agent (the consent screen says so). It is
-- deleted when the last cloud agent connection is revoked.
create table agent_briefings (
  user_id uuid primary key references users (id) on delete cascade,
  context jsonb not null,
  updated_at timestamptz not null default now()
);

-- When a cloud agent last finished each task, so the next email check
-- starts where the last one stopped. Timestamps only.
create table agent_task_runs (
  user_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('job_search', 'email_check')),
  last_done_at timestamptz not null,
  primary key (user_id, kind)
);
