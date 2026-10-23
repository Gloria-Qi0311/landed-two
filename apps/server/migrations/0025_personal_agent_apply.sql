-- 0025 personal-agent auto apply — an approved application can be handed to
-- one connected personal agent (Muse, Today, …). The browser deliberately
-- copies the one job's context and resume here even for a local-first account;
-- only that connection can read the task. Results are acknowledged after the
-- browser stores them, then the copied file/context are erased.

create table agent_apply_tasks (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null,
  application_id uuid not null,
  lead_id uuid,
  job jsonb not null check (jsonb_typeof(job) = 'object'),
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  resume_name text,
  resume_mime text,
  resume_data text,
  resume_key uuid unique default gen_random_uuid(),
  submit_authorized boolean not null check (submit_authorized),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'blocked', 'error')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  acknowledged_at timestamptz,
  foreign key (connection_id, user_id)
    references agent_connections (id, user_id) on delete cascade
);

create index agent_apply_tasks_connection_pending_idx
  on agent_apply_tasks (connection_id, created_at)
  where acknowledged_at is null;

-- Retry delivery is idempotent while a task is active, but an acknowledged
-- historical attempt must not prevent the user from approving the same
-- application again later.
create unique index agent_apply_tasks_active_application_idx
  on agent_apply_tasks (user_id, application_id)
  where acknowledged_at is null;

