-- 0002 rls_policies
--
-- Enable RLS on every user-owned table in the public schema (the supabase
-- skill checklist: public is exposed via the Data API; tables without RLS
-- are world-readable). Policy template: `user_id = auth.uid()` for all four
-- verbs. SELECT must be present for UPDATE to work -- Postgres needs to read
-- the row before it can update it; without SELECT the UPDATE silently
-- returns 0 rows.
--
-- public.users is special: its id IS auth.uid(), not user_id. Same idea,
-- different column.

-- ============================================================================
-- public.users -- id = auth.uid()
-- ============================================================================

alter table public.users enable row level security;

create policy "Users can read own profile"
  on public.users for select
  using (id = auth.uid());

create policy "Users can update own profile"
  on public.users for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- INSERT is via the on_auth_user_created trigger (security definer), so no
-- public INSERT policy needed. DELETE cascades from auth.users delete, also
-- no public policy.

-- ============================================================================
-- companies / applications / portal_connections / portal_events / ai_runs / resumes
--
-- All follow the same pattern. Using FOR ALL is shorthand for SELECT + INSERT
-- + UPDATE + DELETE with the same predicate.
-- ============================================================================

alter table public.companies enable row level security;
create policy "Users manage own companies"
  on public.companies for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.applications enable row level security;
create policy "Users manage own applications"
  on public.applications for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.portal_connections enable row level security;
create policy "Users manage own portal connections"
  on public.portal_connections for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.portal_events enable row level security;
create policy "Users manage own portal events"
  on public.portal_events for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.ai_runs enable row level security;
create policy "Users manage own ai runs"
  on public.ai_runs for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.resumes enable row level security;
create policy "Users manage own resumes"
  on public.resumes for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- Grants -- anon / authenticated need explicit grants in addition to RLS,
-- because Supabase exposes tables to the Data API via role grants and the
-- newly-created tables aren't auto-granted. RLS then filters which rows
-- each user sees.
--
-- anon: only the auth-trigger flow happens before authentication; rest is
-- locked. We grant nothing to anon for these tables.
--
-- authenticated: full CRUD, filtered by RLS.
-- ============================================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.users to authenticated;
grant select, insert, update, delete on public.companies to authenticated;
grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, update, delete on public.portal_connections to authenticated;
grant select, insert, update, delete on public.portal_events to authenticated;
grant select, insert, update, delete on public.ai_runs to authenticated;
grant select, insert, update, delete on public.resumes to authenticated;
