// lib/config.js — public Supabase project config for the Landed extension.
//
// These values are baked into the extension bundle and accessible to anyone
// with the extension installed — that's fine, they are meant to be public.
// The anon key has no special powers; ALL security gates are at the
// Postgres RLS layer (auth.uid() = user_id). Same values are inlined into
// every web-app build at apps/web/.env.local → Vite → bundle.
//
// To point this extension at a different Supabase project, edit these
// constants and reinstall.
//
// Not loaded by manifest.json yet — consumed by lib/auth.js, which the
// bundled popup (#29) and options (#30) will import once the build pipeline
// lands.

(function (global) {
  const SUPABASE_URL = 'https://pkwhsgdvosghdjsacomj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrd2hzZ2R2b3NnaGRqc2Fjb21qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzE2MTIsImV4cCI6MjA5NDU0NzYxMn0.hzFmqeVzIUuR1okoUDMszvpaOLKpB6nEcvddISMECG4';

  global.LandedConfig = { SUPABASE_URL, SUPABASE_ANON_KEY };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
