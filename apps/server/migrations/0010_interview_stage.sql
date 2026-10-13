-- 0010 interview_stage — the pipeline becomes Leads → Applied → OA / Test →
-- Interview → Offer → Rejected (acceptance feedback). One `interview` stage
-- replaces phone + onsite; each application carries its interview rounds
-- (0011). Postgres can't drop enum values, so phone/onsite stay in the type
-- but are no longer written (the API normalizes them to interview).
--
-- On its own because a new enum value can't be used in the transaction that
-- adds it.

alter type application_stage add value if not exists 'interview' after 'oa';
