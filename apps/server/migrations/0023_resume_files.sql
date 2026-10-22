-- 0023 resume_files — each uploaded resume's own file (PDF or Word), so an
-- application gets the file of the resume it was filled from, never another
-- one's. application_files keeps the account's default resume file and cover
-- letter as before. Bytes as base64 text (≤ 3 MB of file), like
-- application_files; packages/schema/src/application-files.ts validates them.
--
-- Cloud data only; sync-off accounts keep theirs in the browser database.
--
-- Also resumes.directions: what an uploaded resume is for, as role names
-- ("Product Manager", "Data Analyst"), the user's or Landed's guess at upload;
-- Landed picks the resume of a job's direction. And applications.resume_choice:
-- which resume an application was filled from and why, for its drawer.

alter table resumes add constraint resumes_id_user_id_key unique (id, user_id);

create table resume_files (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  resume_id uuid not null,
  name text not null,
  mime text not null,
  size integer not null check (size > 0 and size <= 3145728),
  data text not null,
  created_at timestamptz not null default now(),
  unique (user_id, resume_id),
  unique (id, user_id),
  foreign key (resume_id, user_id) references resumes (id, user_id) on delete cascade
);

alter table resumes add column directions text[] not null default '{}';
alter table applications add column resume_choice jsonb;
