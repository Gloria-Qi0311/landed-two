-- 0002 cloud_sync — Landed is local-first.
--
-- Every user signs in, but their data lives in their browser unless they
-- turn on Landed Cloud sync. While cloud_sync is false the API refuses all
-- data reads/writes for the account (409 cloud_off), so "your data stays on
-- your device" holds server-side too — e.g. a signed-in extension can't push
-- portal events into an account that hasn't opted in.

alter table users add column cloud_sync boolean not null default false;

-- Accounts that already keep data here (created before local-first) are, in
-- effect, already synced.
update users u set cloud_sync = true
where exists (select 1 from companies where user_id = u.id)
   or exists (select 1 from resumes where user_id = u.id)
   or exists (select 1 from ai_runs where user_id = u.id)
   or exists (select 1 from portal_events where user_id = u.id);
