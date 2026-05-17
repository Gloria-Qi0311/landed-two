// lib/auth.js — Supabase auth surface for the Landed extension.
//
// Exposes a thin singleton client + the same OTP flow the web app uses
// (signInWithOtp(email) → email arrives via Resend → verifyOtp(email, code)
// → session). The session persists via lib/storage-adapter.js to
// chrome.storage.local so it survives MV3 service-worker restarts.
//
// Consumed by the bundled popup (#29) + options (#30) + portal-sync
// background worker (#34–#38). Not loaded by manifest.json yet — bundler
// in #29 will pull it in via ES import. For now lib/auth.js is exercised
// only by Jest tests + the existing CommonJS require() path.
//
// Public surface (mirrors the web app's apps/web/src/lib/supabase.ts +
// the OTP helpers in apps/web/src/components/auth.jsx):
//   getSupabase()                     → singleton SupabaseClient
//   getSession()                      → Promise<Session | null>
//   getUser()                         → Promise<User | null>
//   signInWithOtp(email)              → Promise<{ error: AuthError | null }>
//   verifyOtp(email, token)           → Promise<{ data, error }>
//   signOut()                         → Promise<{ error: AuthError | null }>
//   onAuthChange(callback)            → unsubscribe()
//
// Tests mock chrome.storage.local on globalThis + stub fetch on the
// Supabase client's internal http layer.
//
// No manifest.json host_permissions change needed: cross-origin fetch()
// from extension contexts (popup / options / service worker) is governed
// by the target server's CORS headers, not by host_permissions. Supabase's
// public Auth + REST endpoints return permissive CORS for the anon role,
// so signInWithOtp / verifyOtp / from-table queries all "just work" from
// the extension without manifest changes. host_permissions would only be
// needed if we ever start using chrome.cookies / chrome.webRequest against
// the Supabase domain — not the case today.

(function (global) {
  const { createClient } = require('@supabase/supabase-js');
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./config.js');
  const { chromeStorageAdapter } = require('./storage-adapter.js');

  let _client = null;
  function getSupabase() {
    if (_client) return _client;
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // chrome.storage.local — survives service-worker eviction
        storage: chromeStorageAdapter,
        persistSession: true,
        // TODO(#29): autoRefreshToken uses setTimeout under the hood, which
        // does NOT survive MV3 service-worker eviction. When the worker is
        // parked and the scheduled refresh fires later, no one runs the
        // timer; the next API call hits a stale-token 401. Fix in #29 by
        // scheduling a chrome.alarms.create('sb-refresh', { when: expires_at - 60s })
        // that wakes the worker + calls supabase.auth.refreshSession().
        autoRefreshToken: true,
        // Extension popup/options have no URL to parse callbacks from
        detectSessionInUrl: false,
      },
    });
    return _client;
  }

  async function getSession() {
    const { data: { session } } = await getSupabase().auth.getSession();
    return session;
  }

  async function getUser() {
    const { data: { user } } = await getSupabase().auth.getUser();
    return user;
  }

  async function signInWithOtp(email) {
    // shouldCreateUser defaults to true — same as web flow; new emails get
    // a public.users row via the on_auth_user_created trigger.
    return getSupabase().auth.signInWithOtp({ email });
  }

  async function verifyOtp(email, token) {
    return getSupabase().auth.verifyOtp({ email, token, type: 'email' });
  }

  async function signOut() {
    return getSupabase().auth.signOut();
  }

  function onAuthChange(callback) {
    const { data } = getSupabase().auth.onAuthStateChange(callback);
    return () => data.subscription.unsubscribe();
  }

  // Test-only: drop the cached client. Lets a test exercise a fresh init.
  function __resetForTests() {
    _client = null;
  }

  global.LandedAuth = {
    getSupabase, getSession, getUser, signInWithOtp, verifyOtp, signOut,
    onAuthChange, __resetForTests,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedAuth;
  }
})(typeof window !== 'undefined' ? window : globalThis);
