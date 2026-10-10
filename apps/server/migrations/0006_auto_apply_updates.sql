-- 0006 auto_apply_updates — email updates apply automatically by default.
--
-- Product decision after acceptance review: a separate Review queue was one
-- step too many. Confident updates read from email (stage changes, new
-- applications, recruiter notes) now apply on their own and can be undone;
-- only ambiguous / low-confidence ones ask. This single switch replaces
-- auto_add_applications (0005), which covered only the "new application" case.

alter table users add column auto_apply_updates boolean not null default true;
alter table users drop column auto_add_applications;
