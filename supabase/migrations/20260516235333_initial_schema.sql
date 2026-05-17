-- 0001 initial_schema
--
-- Tables per spec.md §3. `users` extends Supabase's auth.users via a 1:1 row
-- in public.users (id matches auth.users.id). All app-owned tables carry a
-- user_id that anchors RLS in 0002.
--
-- Conventions:
--   - timestamptz everywhere (UTC at rest, render in user TZ on client)
--   - gen_random_uuid() for surrogate PKs
--   - ON DELETE CASCADE wherever a child row makes no sense without its parent
--   - indexes on user_id (RLS predicate) + on FK columns
--
-- Resume schema lives in `resumes.parsed_json` (jsonb). Validated client-side
-- by packages/schema (issue #17), which mirrors AntaresYuan/resume-filler's
-- schema.js so the extension can consume it raw.

-- ============================================================================
-- public.users -- 1:1 extension of auth.users
-- ============================================================================

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  onboarded_at timestamptz,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  current_resume_id uuid, -- FK added after resumes table exists
  created_at timestamptz not null default now()
);

comment on table public.users is 'App-managed user profile; 1:1 with auth.users via id';

-- Auto-create public.users on auth.users insert (Supabase signup hook pattern)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- companies -- per-user, auto-coloring via hue + logo_chars
-- ============================================================================

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  hue int check (hue >= 0 and hue <= 360),
  logo_chars varchar(2),
  sector text,
  loc text,
  portal_url text,
  created_at timestamptz not null default now()
);

create index companies_user_id_idx on public.companies (user_id);

-- ============================================================================
-- applications -- the core entity
-- ============================================================================

create type public.application_stage as enum (
  'saved', 'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted'
);

create type public.application_remote as enum ('Remote', 'Hybrid', 'On-site');

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null,
  team text,
  stage public.application_stage not null default 'saved',
  salary text,
  location text,
  remote public.application_remote,
  applied_at timestamptz, -- null for 'saved' stage
  next_step text,
  referral boolean not null default false,
  source text,
  job_id text,
  portal_application_url text,
  notes text,
  starred boolean not null default false,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index applications_user_id_idx on public.applications (user_id);
create index applications_company_id_idx on public.applications (company_id);
create index applications_stage_idx on public.applications (user_id, stage);
create index applications_last_activity_idx on public.applications (user_id, last_activity_at desc);

-- ============================================================================
-- portal_connections -- one per portal-vendor login
-- ============================================================================

create type public.portal_provider as enum (
  'greenhouse', 'lever', 'workday', 'ashby', 'bamboohr', 'boss', 'smartrecruiters', 'other'
);

create type public.portal_status as enum (
  'active', 'syncing', 'expired', 'disconnected'
);

create table public.portal_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  provider public.portal_provider not null,
  portal_host text,
  status public.portal_status not null default 'active',
  last_sync_at timestamptz,
  last_seen_login_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index portal_connections_user_id_idx on public.portal_connections (user_id);
create index portal_connections_company_id_idx on public.portal_connections (company_id);

-- ============================================================================
-- portal_events -- append-only stream from the extension
-- ============================================================================

create type public.portal_event_type as enum (
  'status-change', 'new-event', 'expired', 'sync', 'rejection'
);

create table public.portal_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.portal_connections(id) on delete cascade,
  application_id uuid references public.applications(id) on delete cascade,
  type public.portal_event_type not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index portal_events_user_id_idx on public.portal_events (user_id);
create index portal_events_user_created_idx on public.portal_events (user_id, created_at desc);
create index portal_events_application_idx on public.portal_events (application_id) where application_id is not null;

-- ============================================================================
-- ai_runs -- every AI round-trip the user completes
-- ============================================================================

create type public.ai_task as enum ('resume_match', 'jd_breakdown', 'resume_tailor');
create type public.ai_provider as enum ('chatgpt', 'claude', 'gemini', 'other');
create type public.ai_parse_format as enum ('json', 'markdown', 'heuristic', 'failed');

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task public.ai_task not null,
  provider public.ai_provider not null,
  prompt_text text not null,
  response_text text,
  parsed_json jsonb,
  parse_format public.ai_parse_format,
  created_at timestamptz not null default now()
);

create index ai_runs_user_id_idx on public.ai_runs (user_id);
create index ai_runs_user_task_idx on public.ai_runs (user_id, task, created_at desc);

-- ============================================================================
-- resumes -- user's PDFs + parsed JSON (ApplyMint schema.js shape)
-- ============================================================================

create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  file_path text, -- Supabase Storage path, e.g. 'resumes/<user_id>/<uuid>.pdf'
  parsed_json jsonb, -- ApplyMint schema (basic/intent/education/experience/...)
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);

create index resumes_user_id_idx on public.resumes (user_id);

-- Only one current resume per user (partial unique index)
create unique index resumes_one_current_per_user_idx
  on public.resumes (user_id) where is_current = true;

-- Now add the FK from public.users.current_resume_id -> resumes(id).
-- Done AFTER both tables exist to avoid circular create-order.
alter table public.users
  add constraint users_current_resume_id_fkey
  foreign key (current_resume_id) references public.resumes(id) on delete set null;
