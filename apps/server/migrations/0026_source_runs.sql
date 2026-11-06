-- 0026 source_runs — each public source's last check of a search (#145):
-- the job lists and the company boards each run on their own schedule in the
-- browser, so the schedule needs when each last ran, and Workflow shows what
-- it found ("last found N new"). {job_lists?, company_boards?}, each
-- {at, found, added, merged, closed, checked, failed};
-- packages/schema/src/automation.ts parseSourceRuns validates them.
--
-- Cloud data only; sync-off accounts keep theirs in the browser database.

alter table job_searches add column source_runs jsonb;
