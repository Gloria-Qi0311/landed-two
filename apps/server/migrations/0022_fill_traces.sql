-- 0022 fill_traces — what one autofill did, step by step: each phase, each
-- model call, every field with its value's source or why it was left
-- (docs/apply-assist.md, "Fill traces"). The extension uploads one per page it
-- fills; the popup shows its short ref, and the user's paired computer reads
-- it by that ref (`landed fill-trace <ref>`). Validated by
-- packages/schema/src/fill-trace.ts: sensitive questions carry no value.
--
-- Cloud accounts only, like every data table; the extension keeps the last
-- few locally either way. Not part of the snapshot: traces are debugging
-- records, not job-hunt data. Kept 30 days.

create table fill_traces (
  user_id uuid not null references users(id) on delete cascade,
  ref text not null check (ref ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
  trace jsonb not null check (jsonb_typeof(trace) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, ref)
);

create index fill_traces_by_age on fill_traces (user_id, created_at);
