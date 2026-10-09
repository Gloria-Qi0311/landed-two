// lib/config.js — Landed API server config for the extension.
//
// API_URL is the public origin of apps/server (in production, the
// Cloudflare Tunnel hostname). It is not a secret — the per-user session
// token from lib/auth.js is what authenticates every call.
//
// To point this extension at a different server, edit API_URL and rebuild.
//
// WEB_ORIGINS are the Landed web app origins allowed to talk to the
// extension over the page bridge (lib/web-bridge.js → background.js). Keep
// the production origin here in sync with manifest.json's web-bridge
// content_scripts matches.
//
// Loaded by background.js via importScripts and by lib/auth.js via require().

(function (global) {
  const API_URL = 'http://localhost:8787';
  const WEB_ORIGINS = [
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:8787', 'http://127.0.0.1:8787',
  ];
  // chrome.storage.local key holding { token, user: { id, email } }.
  const SESSION_STORAGE_KEY = 'landed:session';
  // chrome.storage.local key holding { resumes, synced_at } handed over by
  // the web app in local mode (no Cloud account needed for autofill).
  const LOCAL_RESUMES_KEY = 'landed:local-resumes';

  global.LandedConfig = { API_URL, WEB_ORIGINS, SESSION_STORAGE_KEY, LOCAL_RESUMES_KEY };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
