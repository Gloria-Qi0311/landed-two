-- ai_provider_keys — per-user LLM API keys, encrypted via Supabase Vault.
--
-- Design (#68.1):
--   - Each row holds metadata + a foreign-key pointer to a vault.secrets row.
--   - The plaintext API key is NEVER stored in this table or read by the
--     web client. The two helper RPCs below are SECURITY DEFINER and gate
--     all Vault access through auth.uid() ownership checks.
--   - Edge Function `llm-proxy` (#68.3) uses service_role to read
--     vault.decrypted_secrets — that path bypasses RLS but is server-side
--     only and validates the caller's JWT before dereferencing.
--
-- Provider enum (existing `public.ai_provider`):
--     'chatgpt' | 'claude' | 'gemini' | 'other'
-- Reusing it keeps key↔run joining simple (`ai_runs.provider` matches).

create extension if not exists supabase_vault;

create table public.ai_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.ai_provider not null,
  vault_secret_id uuid not null,           -- references vault.secrets(id); no FK because vault is a separate schema
  label text,                              -- optional user-given name ("my work claude key")
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  -- One key per provider per user. Rotating = updating the row in place
  -- via create_ai_provider_key (which deletes the old vault entry first).
  unique (user_id, provider)
);

create index ai_provider_keys_user_id_idx on public.ai_provider_keys (user_id);

-- ============================================================================
-- RLS — users can read/delete their own rows. Insert/update goes through
-- the SECURITY DEFINER RPCs below (which handle the Vault round-trip).
-- ============================================================================

alter table public.ai_provider_keys enable row level security;

create policy "Users read own keys"
  on public.ai_provider_keys for select
  using (user_id = auth.uid());

create policy "Users delete own keys"
  on public.ai_provider_keys for delete
  using (user_id = auth.uid());

-- NO insert/update policy: forces all writes through create_ai_provider_key /
-- rotate_ai_provider_key, which manage the Vault round-trip atomically.

grant select, delete on public.ai_provider_keys to authenticated;

-- ============================================================================
-- Helper RPCs — SECURITY DEFINER, callable from the web client via
-- supabase.rpc(). They handle the Vault create/update/delete because
-- vault.secrets is not directly accessible to the authenticated role.
-- ============================================================================

-- Create or rotate a key for (auth.uid(), provider).
--   - On first save for this (user, provider): inserts new row + creates
--     new vault secret.
--   - On re-save: updates the existing vault secret in place + bumps
--     created_at to track rotation time. The vault_secret_id stays the
--     same so any reference held by an in-flight Edge Function still
--     resolves to the new value.
--
-- Returns the row id (NOT the plaintext key — once saved, the key is
-- write-only from the client's perspective).
--
-- Edge Function (#68.3) contract: if the row's vault_secret_id points to
-- a deleted vault.secrets entry (e.g. partial-failure during delete —
-- see delete_ai_provider_key below), the Edge Function MUST return a
-- clean "key needs re-saving" error rather than expose internal state.
create or replace function public.create_ai_provider_key(
  p_provider public.ai_provider,
  p_secret text,
  p_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, vault   -- 'extensions' intentionally omitted (least privilege)
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_secret_id uuid;
  v_new_secret_id uuid;
  v_row_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  -- Reject the catch-all 'other' provider: users would be silently
  -- confused saving an unusable key (llm-proxy in #68.3 has no endpoint
  -- to route 'other' to). The enum value still makes sense in ai_runs
  -- for recording past round-trips, just not for stored keys.
  if p_provider = 'other' then
    raise exception 'provider "other" not supported for stored keys';
  end if;
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'secret must not be empty';
  end if;
  -- Length caps: real API keys are <300 chars (OpenAI ~56, Anthropic
  -- ~108, Google ~40). Cap at 4096 with margin. Without this, an
  -- authenticated user can repeatedly call with multi-MB strings to
  -- DoS-fill vault.secrets (pgsodium encryption is CPU-bound).
  if length(p_secret) > 4096 then
    raise exception 'secret too long (max 4096 chars)';
  end if;
  if p_label is not null and length(p_label) > 256 then
    raise exception 'label too long (max 256 chars)';
  end if;

  -- Per-(user, provider) advisory lock prevents the concurrent-first-save
  -- race that would otherwise orphan a vault.secrets row: two tabs both
  -- see no existing row, both call vault.create_secret (creating TWO
  -- vault entries), one's INSERT wins on UNIQUE(user_id, provider), the
  -- other's INSERT fails and its vault entry is now orphan. Lock
  -- auto-releases at transaction end. Hash key is stable per (user,
  -- provider) so unrelated saves don't block each other.
  perform pg_advisory_xact_lock(hashtext('landed:ai-provider-keys:' || v_user_id::text || ':' || p_provider::text));

  -- If a key already exists for this (user, provider), rotate the
  -- vault secret in place instead of orphaning the old one.
  select vault_secret_id, id into v_existing_secret_id, v_row_id
    from public.ai_provider_keys
    where user_id = v_user_id and provider = p_provider;

  if v_existing_secret_id is not null then
    perform vault.update_secret(
      v_existing_secret_id,
      p_secret,
      coalesce(p_label, 'landed:ai-key:' || p_provider::text || ':' || v_user_id::text),
      'Landed AI provider key for ' || p_provider::text
    );
    update public.ai_provider_keys
      set label = p_label, created_at = now()
      where id = v_row_id;
    return v_row_id;
  end if;

  -- New key: create the vault secret first, then the row.
  v_new_secret_id := vault.create_secret(
    p_secret,
    coalesce(p_label, 'landed:ai-key:' || p_provider::text || ':' || v_user_id::text),
    'Landed AI provider key for ' || p_provider::text
  );

  insert into public.ai_provider_keys (user_id, provider, vault_secret_id, label)
    values (v_user_id, p_provider, v_new_secret_id, p_label)
    returning id into v_row_id;

  return v_row_id;
end;
$$;

revoke all on function public.create_ai_provider_key(public.ai_provider, text, text) from public;
grant execute on function public.create_ai_provider_key(public.ai_provider, text, text) to authenticated;

-- Defense against `log_min_duration_statement` capturing the plaintext
-- secret in Postgres logs: pin this function to NEVER log slow-statement
-- output regardless of the role/database default. Deploy note: if
-- pgaudit is enabled, ALSO set `pgaudit.log_parameter = off` at the
-- role or database level so plaintext doesn't reach the audit log.
alter function public.create_ai_provider_key(public.ai_provider, text, text)
  set log_min_duration_statement = -1;

-- Delete a key + its vault secret. Owner-only.
create or replace function public.delete_ai_provider_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault   -- 'extensions' intentionally omitted
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select vault_secret_id into v_secret_id
    from public.ai_provider_keys
    where id = p_id and user_id = v_user_id;

  if v_secret_id is null then
    -- Either doesn't exist or not owned by caller — same error either
    -- way (don't leak existence).
    raise exception 'key not found';
  end if;

  -- Delete vault first; if this fails, the row stays + caller can retry.
  -- If we deleted the row first and vault delete failed, we'd orphan a
  -- secret that no one can refer to anymore.
  delete from vault.secrets where id = v_secret_id;
  delete from public.ai_provider_keys where id = p_id;
end;
$$;

revoke all on function public.delete_ai_provider_key(uuid) from public;
grant execute on function public.delete_ai_provider_key(uuid) to authenticated;

-- ============================================================================
-- Touch helper: Edge Function calls this on successful LLM round-trip so
-- the user can see "last used: 2 minutes ago" in Settings. SECURITY DEFINER
-- because the call comes from server-side (service_role) but the
-- functional intent is "the user's own key was used."
--
-- Defense-in-depth: takes BOTH user_id AND id so a compromised
-- service_role can't tamper with arbitrary rows' timestamps. Edge
-- Function has both values from the JWT + the key lookup.
-- ============================================================================

create or replace function public.touch_ai_provider_key(p_user_id uuid, p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_provider_keys
    set last_used_at = now()
    where id = p_id and user_id = p_user_id;
$$;

revoke all on function public.touch_ai_provider_key(uuid, uuid) from public;
grant execute on function public.touch_ai_provider_key(uuid, uuid) to service_role;
