-- 0024 open_answers — the open-ended answers an application was sent with
-- ("Why us?", "Tell us about a project…"): question, answer, when, and
-- whether the user edited it. The user's own agent writes them on an approved
-- application; the drawer shows them; edited ones are the agent's examples
-- next time. packages/schema/src/open-answers.ts validates them.
--
-- Cloud data only; sync-off accounts keep theirs in the browser database.

alter table applications add column open_answers jsonb;
