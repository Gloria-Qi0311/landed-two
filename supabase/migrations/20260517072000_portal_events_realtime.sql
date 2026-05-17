-- Enable Realtime postgres_changes broadcasts for portal_events.
--
-- Without explicit membership in `supabase_realtime`, Supabase's Realtime
-- server silently drops postgres_changes subscriptions for the table —
-- the channel subscribes successfully but no events arrive. Adding the
-- table here lets apps/web/src/components/sync-page.tsx (#38) react to
-- inserts from the extension push path (#35) in real time.
--
-- RLS is still enforced: Realtime broadcasts each change through the
-- per-user "Users manage own portal_events" policy, so subscribers only
-- see their own user_id's events. No leakage across users.
--
-- portal_connections is NOT added because the extension never inserts
-- into it directly — the web app's seed flow does, and that already
-- invalidates the query through TanStack mutation.onSuccess. If a future
-- flow needs live connection updates, add it here.

alter publication supabase_realtime add table public.portal_events;
