-- 0015 automations — the schedule for Landed's recurring agent work
-- (email checks, job searches), account-level like email_watch, which it
-- replaces: {email_check: {enabled, schedule}, job_search: {...}}
-- (packages/schema/src/automation.ts). The daemon on the user's computer
-- runs it; results never pass through the server's storage.

alter table users add column automations jsonb not null default '{}'::jsonb;

update users
set automations = jsonb_build_object('email_check', jsonb_build_object(
  'enabled', true, 'schedule', jsonb_build_object('kind', 'interval', 'hours', 4)))
where email_watch;
