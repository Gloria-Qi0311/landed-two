-- 0005 observation_processing — what the observation processor produces
-- (packages/observation-processor, docs/observation-processor.md).
--
--   job_leads           the "to apply" list: deduplicated jobs agents found
--   status_suggestions  status changes read from email, waiting for the user
--                       (or auto-applied and kept for audit/undo)
--
-- Like every data table these hold Cloud data only; sync-off accounts keep
-- the same records in their browser database.

create table job_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  fingerprint text not null,
  ats_key text,
  canonical_url text,
  company_key text not null,
  title_key text not null,
  company_name text not null,
  title text not null,
  job_url text,
  location text,
  description text,
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'new'
    check (status in ('new', 'saved', 'dismissed', 'already_applied')),
  application_id uuid,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Two tabs processing at once can't create the same lead twice.
  unique (user_id, fingerprint),
  foreign key (application_id, user_id)
    references applications (id, user_id) on delete set null (application_id)
);

create index job_leads_user_status_idx on job_leads (user_id, status, last_seen_at desc);

create table status_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- one per (email, reading of it); see processStatus()
  dedupe_key text not null,
  kind text not null check (kind in ('stage_change', 'new_application', 'ambiguous', 'note')),
  state text not null default 'pending'
    check (state in ('pending', 'accepted', 'rejected', 'auto_applied', 'undone')),
  application_id uuid,
  candidate_ids jsonb not null default '[]'::jsonb,
  company_name text not null,
  role text,
  status text not null,
  proposed_stage application_stage,
  previous_stage application_stage,
  confidence real check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  observation_ids jsonb not null default '[]'::jsonb,
  provider text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, dedupe_key),
  foreign key (application_id, user_id)
    references applications (id, user_id) on delete set null (application_id)
);

create index status_suggestions_user_state_idx on status_suggestions (user_id, state, created_at desc);

-- What processing did with an observation (lead id, suggestion id, …).
alter table agent_observations add column processing_result jsonb;

-- Account preference (docs/observation-processor.md §10.3): add an
-- application automatically for a confident "applied" email that matches
-- nothing in the pipeline. Off by default.
alter table users add column auto_add_applications boolean not null default false;
