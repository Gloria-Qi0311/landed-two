// lib/config.js — Landed API server config for the extension.
//
// API_URL is the public origin of apps/server (in production, the
// Cloudflare Tunnel hostname). It is not a secret — the per-user session
// token from lib/auth.js is what authenticates every call.
//
// To point this extension at a different server, edit API_URL and rebuild.
//
// Loaded by background.js via importScripts and by lib/auth.js via require().

(function (global) {
  const API_URL = 'http://localhost:8787';
  // chrome.storage.local key holding { token, user: { id, email } }.
  const SESSION_STORAGE_KEY = 'landed:session';

  global.LandedConfig = { API_URL, SESSION_STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
