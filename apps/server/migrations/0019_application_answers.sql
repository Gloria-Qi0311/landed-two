-- 0019 application_answers — the questions application forms ask that a
-- resume doesn't answer (work authorization, sponsorship, start date,
-- relocation, preferred name, voluntary EEO answers…). One row per account;
-- the answers are one jsonb object validated by packages/schema/src/
-- application-answers.ts. The browser extension uses them to answer choice
-- questions when it fills a form.
--
-- Like every data table this holds Cloud data only; sync-off accounts keep
-- their answers in the browser database.

create table application_answers (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id),
  unique (id, user_id)
);
