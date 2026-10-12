-- 0008 job_searches — the job search direction the user agreed with their
-- agent in the Ask Agent chat (a "brief": roles, seniority, locations, visa,
-- …), confirmed with one click, plus how its last search run went. Search
-- runs themselves happen on the user's computer (apps/daemon, task kind
-- `job_search`); what they find becomes job leads.
--
-- Like every data table this holds Cloud data only; sync-off accounts keep
-- their searches in the browser database.

create table job_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- packages/schema/src/search-brief.ts (SearchBrief), validated on write
  brief jsonb not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  last_run_at timestamptz,
  -- {found, added, merged, already_applied, agents: [...]}
  last_run_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index job_searches_user_created_idx on job_searches (user_id, created_at desc);
-- One current direction per account; confirming a new one archives the old.
create unique index job_searches_one_active_idx on job_searches (user_id) where status = 'active';
