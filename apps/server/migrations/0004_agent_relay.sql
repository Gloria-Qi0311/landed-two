-- 0004 agent_relay — agent observations respect local-first.
--
-- Agents (Muse, Claude, Codex…) run in the cloud, so their observations
-- always pass through this server. What the server keeps depends on the
-- owning account:
--
--   sync on   "cloud":   payload kept (expires_at null), like any Cloud data
--   sync off  "held":    payload kept only until the user's browser pulls it
--                        into its local database (or 7 days, expires_at)
--             "receipt": after delivery/expiry the payload is purged; the row
--                        keeps only ids, the idempotency key and payload_sha256
--                        so agent retries are still recognised. Receipts are
--                        deleted after 30 days.
--
-- payload_sha256 is the hash of the canonical (jsonb) text of the request
-- body; it replaces comparing full payloads for idempotency conflicts.

alter table agent_observations
  alter column payload_json drop not null,
  add column payload_sha256 text,
  add column expires_at timestamptz,
  add column delivered_at timestamptz;

update agent_observations
  set payload_sha256 = encode(sha256(convert_to(payload_json::text, 'UTF8')), 'hex');

alter table agent_observations alter column payload_sha256 set not null;

-- Pull queue for sync-off accounts: held rows, oldest first.
create index agent_observations_held_idx
  on agent_observations (user_id, created_at)
  where payload_json is not null and expires_at is not null;

create index agent_observations_expiry_idx
  on agent_observations (expires_at)
  where payload_json is not null and expires_at is not null;
