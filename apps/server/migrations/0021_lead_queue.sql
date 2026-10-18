-- 0021 lead queue — what the supply track knows about each candidate job
-- (docs/leads-model.md). All optional; written in the browser, validated by
-- @landed/schema/lead-queue on every write path:
--   posted_at  "YYYY-MM-DD"        when the source says the job was posted
--   closed_at                      when the posting disappeared from its source
--   screen     {pass, reasons[]}   hard filters (graduation, sponsorship, clearance)
--   fit        {score 0–1, reasons[]}  match against the master resume
-- Priority is computed when shown, never stored.

alter table job_leads
  add column posted_at text check (posted_at ~ '^\d{4}-\d{2}-\d{2}$'),
  add column closed_at timestamptz,
  add column screen jsonb check (screen is null or jsonb_typeof(screen) = 'object'),
  add column fit jsonb check (fit is null or jsonb_typeof(fit) = 'object');
