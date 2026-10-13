-- 0012 resume_kinds — My Resume becomes: uploaded resumes (sources) → one
-- master resume (the most complete record, merged by the user's own agent,
-- every phrasing of every bullet kept) → tailored versions for different
-- roles. See packages/schema/src/master-resume.ts.
--
--   kind         source (uploaded) | master | version
--   master_json  the master's structure (kind master); parsed_json holds its
--                flattened form so auto-fill works on any resume
--   target_json  what a version is aimed at + why it picked what it did

alter table resumes
  add column kind text not null default 'source' check (kind in ('source', 'master', 'version')),
  add column master_json jsonb,
  add column target_json jsonb;

create unique index resumes_one_master_per_user_idx on resumes (user_id) where kind = 'master';
