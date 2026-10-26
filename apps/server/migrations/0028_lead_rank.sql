-- 0028 rank — the user's own agent's score for a lead (#147): {score 0–1,
-- reasons (1–3), by, at, search_id}. It counts only while its search is
-- active and Rank is set to the agent: the queue then orders by 0.4 × the
-- rules' fit + 0.6 × this (packages/supply → rankedFit). A lead queue field:
-- packages/schema/src/lead-queue.ts parseRank validates it. Each batch asked
-- is kept in ai_runs (task rank_leads: the leads, the scores, the tokens).
--
-- Cloud data only; sync-off accounts keep theirs in the browser database.

alter table job_leads add column rank jsonb;
alter type ai_task add value if not exists 'rank_leads';
