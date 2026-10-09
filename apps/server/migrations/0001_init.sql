-- 0001 init — self-hosted schema (replaces supabase/migrations/*).
--
-- Same tables, enums and indexes as the former Supabase project, minus the
-- Supabase-only pieces:
--   - auth.users  → users is now the auth table itself (password_hash)
--   - RLS         → the API scopes every query by the session's user_id
--   - Vault       → ai_provider_keys.secret_ciphertext, AES-256-GCM in the API
--   - Realtime    → portal_events INSERT trigger → pg_notify → SSE
--
-- Cross-tenant integrity lives in the schema rather than in RLS: every
-- parent table exposes unique (id, user_id) and children reference it via a
-- composite FK, so a row can only point at a parent owned by the same user.
-- Nullable composite FKs (portal_events.connection_id etc.) use MATCH SIMPLE:
-- a null id skips the check, a non-null id must match the same user_id.
--
-- Conventions (unchanged): timestamptz everywhere, gen_random_uuid() PKs,
-- ON DELETE CASCADE where a child makes no sense without its parent.

create extension if not exists citext;

-- ============================================================================
-- users + sessions
-- ============================================================================

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  onboarded_at timestamptz,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  current_resume_id uuid, -- FK added after resumes exists
  created_at timestamptz not null default now()
);

-- Opaque session tokens. Only the SHA-256 of the token is stored, so a DB
-- dump can't be replayed as live sessions.
create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('cookie', 'token')),
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

-- ============================================================================
-- companies
-- ============================================================================

create table companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  hue int check (hue >= 0 and hue <= 360),
  logo_chars varchar(2),
  sector text,
  loc text,
  portal_url text,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create index companies_user_id_idx on companies (user_id);

-- ============================================================================
-- applications
-- ============================================================================

create type application_stage as enum (
  'saved', 'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted'
);

create type application_remote as enum ('Remote', 'Hybrid', 'On-site');

create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid not null,
  role text not null,
  team text,
  stage application_stage not null default 'saved',
  salary text,
  location text,
  remote application_remote,
  applied_at timestamptz, -- null for 'saved' stage
  next_step text,
  referral boolean not null default false,
  source text,
  job_id text,
  portal_application_url text,
  notes text,
  starred boolean not null default false,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (company_id, user_id) references companies (id, user_id) on delete cascade
);

create index applications_user_id_idx on applications (user_id);
create index applications_company_id_idx on applications (company_id);
create index applications_stage_idx on applications (user_id, stage);
create index applications_last_activity_idx on applications (user_id, last_activity_at desc);

-- ============================================================================
-- portal_connections — one per (company, portal vendor) login
-- ============================================================================

create type portal_provider as enum (
  'greenhouse', 'lever', 'workday', 'ashby', 'bamboohr', 'boss', 'smartrecruiters', 'other'
);

create type portal_status as enum ('active', 'syncing', 'expired', 'disconnected');

create table portal_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid not null,
  provider portal_provider not null,
  portal_host text,
  status portal_status not null default 'active',
  last_sync_at timestamptz,
  last_seen_login_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  -- Upsert target: INSERT ... ON CONFLICT (user_id, company_id, provider).
  constraint portal_connections_user_company_provider_unique
    unique (user_id, company_id, provider),
  foreign key (company_id, user_id) references companies (id, user_id) on delete cascade
);

create index portal_connections_company_id_idx on portal_connections (company_id);

-- ============================================================================
-- portal_events — append-only stream from the extension
-- ============================================================================

create type portal_event_type as enum (
  'status-change', 'new-event', 'expired', 'sync', 'rejection'
);

create table portal_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  connection_id uuid,
  application_id uuid,
  type portal_event_type not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (connection_id, user_id) references portal_connections (id, user_id) on delete cascade,
  foreign key (application_id, user_id) references applications (id, user_id) on delete cascade
);

create index portal_events_user_created_idx on portal_events (user_id, created_at desc);
create index portal_events_connection_idx on portal_events (connection_id) where connection_id is not null;
create index portal_events_application_idx on portal_events (application_id) where application_id is not null;

-- Realtime: the API server LISTENs on this channel and fans each insert out
-- to the owning user's SSE subscribers. Payload stays tiny (ids only) to
-- respect pg_notify's 8 kB cap; the server re-reads the row.
create function notify_portal_event() returns trigger
language plpgsql as $$
begin
  perform pg_notify(
    'portal_events',
    json_build_object('id', new.id, 'user_id', new.user_id)::text
  );
  return new;
end;
$$;

create trigger portal_events_notify
  after insert on portal_events
  for each row execute function notify_portal_event();

-- ============================================================================
-- ai_runs — every AI round-trip the user completes
-- ============================================================================

create type ai_task as enum ('resume_match', 'jd_breakdown', 'resume_tailor');
create type ai_provider as enum ('chatgpt', 'claude', 'gemini', 'other');
create type ai_parse_format as enum ('json', 'markdown', 'heuristic', 'failed');

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task ai_task not null,
  provider ai_provider not null,
  prompt_text text not null,
  response_text text,
  parsed_json jsonb,
  parse_format ai_parse_format,
  created_at timestamptz not null default now()
);

create index ai_runs_user_task_idx on ai_runs (user_id, task, created_at desc);

-- ============================================================================
-- ai_provider_keys — per-user LLM API keys, encrypted by the API server
-- (AES-256-GCM, key from SECRETS_KEY env). The plaintext never reaches the
-- browser after it is saved; the API only returns metadata.
-- ============================================================================

create table ai_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider ai_provider not null check (provider <> 'other'),
  secret_ciphertext text not null, -- base64(iv | tag | ciphertext)
  label text check (length(label) <= 256),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- ============================================================================
-- resumes — parsed JSON in ApplyMint schema.js shape
-- ============================================================================

create table resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  file_path text,
  parsed_json jsonb,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);

create index resumes_user_id_idx on resumes (user_id);

-- Only one current resume per user
create unique index resumes_one_current_per_user_idx
  on resumes (user_id) where is_current = true;

alter table users
  add constraint users_current_resume_id_fkey
  foreign key (current_resume_id) references resumes(id) on delete set null;
