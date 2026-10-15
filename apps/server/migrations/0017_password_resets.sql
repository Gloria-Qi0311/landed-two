-- One-time password reset links. The raw token only appears in the email;
-- a database leak cannot turn these hashes back into working reset links.
create table password_reset_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index password_reset_tokens_user_id_idx on password_reset_tokens (user_id);
create index password_reset_tokens_expires_at_idx on password_reset_tokens (expires_at);
