-- 0011 interview_rounds — interview rounds per application, and phone/onsite
-- applications moved to `interview` with the round they stood for.
--
--   interviews: [{ round, format: onsite|remote, interviewers: [peer|teammate|leader|hr], at, note }]
--   (validated by packages/schema/src/pipeline.ts)

alter table applications add column interviews jsonb not null default '[]'::jsonb;

update applications
set interviews = jsonb_build_array(jsonb_build_object(
      'round', null,
      'format', case when stage = 'phone' then 'remote' else 'onsite' end,
      'interviewers', '[]'::jsonb, 'at', null, 'note', null)),
    stage = 'interview'
where stage in ('phone', 'onsite');

update status_suggestions set proposed_stage = 'interview' where proposed_stage in ('phone', 'onsite');
update status_suggestions set previous_stage = 'interview' where previous_stage in ('phone', 'onsite');
