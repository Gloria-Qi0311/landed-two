-- 0013 deadlines — when applications close, for what's not applied to yet:
-- job leads (from agents' searches, or set by hand) and applications in the
-- Leads column (stage `saved`). "YYYY-MM-DD", normalized by
-- packages/schema/src/pipeline.ts (parseDeadline). Interview times live on
-- each round in applications.interviews (`at`).

alter table job_leads add column deadline text check (deadline ~ '^\d{4}-\d{2}-\d{2}$');
alter table applications add column deadline text check (deadline ~ '^\d{4}-\d{2}-\d{2}$');
