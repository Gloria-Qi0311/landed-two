-- ============================================================================
-- portal_connections: dedupe + unique (user_id, company_id, provider)
-- ============================================================================
--
-- Background: the initial schema (20260516235333_initial_schema.sql) didn't
-- enforce a unique key on (user_id, company_id, provider). The client hook
-- apps/web/src/hooks/sync.ts (useUpsertPortalConnection) and the Edge
-- Function supabase/functions/portal-ingest/index.ts both did client-side
-- SELECT-then-UPDATE-or-INSERT, which races: two concurrent writes for the
-- same triple could miss the SELECT and double-insert.
--
-- This migration:
--   1. removes any duplicate rows that may have accumulated during the racey
--      window — keeps the most recently created row per triple
--   2. adds the unique constraint
--
-- After this lands, both call sites swap to a single
-- supabase.from('portal_connections').upsert(row, { onConflict: 'user_id,company_id,provider' }).

-- Step 1: dedupe — keep the most recent created_at row per (user, company, provider).
-- Tiebreak on id to make the deterministic in the event of identical created_at values.
delete from public.portal_connections
where id in (
  select id from (
    select id, row_number() over (
      partition by user_id, company_id, provider
      order by created_at desc, id desc
    ) as rn
    from public.portal_connections
  ) ranked
  where rn > 1
);

-- Step 2: add the unique constraint. Postgres auto-creates a unique index
-- backing the constraint, so no separate create-index needed.
alter table public.portal_connections
  add constraint portal_connections_user_company_provider_unique
  unique (user_id, company_id, provider);
