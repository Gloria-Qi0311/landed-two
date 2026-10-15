-- Offline password recovery. Raw codes are shown once; only their hashes
-- survive in the database. Codes have no expiry but each one can be used once.
create table account_recovery_codes (
  code_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index account_recovery_codes_user_id_idx on account_recovery_codes (user_id);
