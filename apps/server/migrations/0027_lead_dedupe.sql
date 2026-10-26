-- 0027 dedupe — a duplicate lead the rules couldn't decide, as the user's own
-- agent judged it (#146): {same_as, checked, by, at, reason}. `same_as` hides
-- the lead under the one it's the same job as (Split clears it; never
-- deleted); `checked` keeps a pair from being asked twice. A lead queue
-- field: packages/schema/src/lead-queue.ts parseDedupe validates it. Each
-- batch asked is kept in ai_runs (task same_job: the pairs, the answers, the
-- tokens).
--
-- Cloud data only; sync-off accounts keep theirs in the browser database.

alter table job_leads add column dedupe jsonb;
alter type ai_task add value if not exists 'same_job';
