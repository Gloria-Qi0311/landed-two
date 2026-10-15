-- 0020 application_files — the user's own resume file and cover letter that
-- the browser extension uploads into application forms. One per kind per
-- account. The bytes are stored as base64 text (≤ 3 MB of file) so they
-- travel unchanged in JSON snapshots; packages/schema/src/application-files.ts
-- validates them.
--
-- Like every data table this holds Cloud data only; sync-off accounts keep
-- their files in the browser database.

create table application_files (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('resume', 'cover_letter')),
  name text not null,
  mime text not null,
  size integer not null check (size > 0 and size <= 3145728),
  data text not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind),
  unique (id, user_id)
);
