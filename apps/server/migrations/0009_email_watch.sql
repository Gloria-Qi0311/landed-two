-- 0009 email_watch — let the user's own agent check their mailbox for
-- application updates (task kind `email_check`, apps/daemon). Account-level
-- like auto_apply_updates: off until the user turns it on in Ask Agent, and
-- when it last ran (the next check reads mail since then). The mail itself
-- never reaches the server; findings are relayed in memory to the browser.

alter table users
  add column email_watch boolean not null default false,
  add column email_checked_at timestamptz;
