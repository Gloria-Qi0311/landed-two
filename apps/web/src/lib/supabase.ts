// Single Supabase client for the web app. Auth state is persisted in
// localStorage (Supabase JS SDK default) under sb-<ref>-auth-token; the SDK
// auto-refreshes tokens and emits onAuthStateChange events that App.tsx
// subscribes to.
//
// Env vars are read from apps/web/.env.local (gitignored). The .env.example
// committed alongside documents the expected keys.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in apps/web/.env.local. ' +
    'Copy apps/web/.env.example and fill from https://supabase.com/dashboard/project/<ref>/settings/api.',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // handles ?code= callback after OAuth round-trip
  },
});
