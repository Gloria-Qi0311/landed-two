// lib/storage-adapter.js — chrome.storage.local as a small async KV store.
//
// Used for the auth session (lib/auth.js). window.localStorage doesn't
// exist in an MV3 service worker, and in-memory state evaporates every time
// the worker is parked (≤30s of idle). chrome.storage.local persists across
// worker restarts AND is shared by popup / options / background contexts.
//
// Interface:
//   getItem(key)    → value | null    (Promise)
//   setItem(key,v)  → void            (Promise)
//   removeItem(key) → void            (Promise)
//
// In tests, callers stub `chrome.storage.local` on globalThis before
// requiring this module. The defensive `typeof chrome` check makes the
// module safe to load in any context (jsdom, node, MV3).

(function (global) {
  function getStorage() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  }

  const chromeStorageAdapter = {
    async getItem(key) {
      const s = getStorage();
      if (!s) return null;
      const result = await s.get(key);
      const v = result && result[key];
      return v == null ? null : v;
    },
    async setItem(key, value) {
      const s = getStorage();
      if (!s) return;
      await s.set({ [key]: value });
    },
    async removeItem(key) {
      const s = getStorage();
      if (!s) return;
      await s.remove(key);
    },
  };

  global.LandedStorageAdapter = { chromeStorageAdapter };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedStorageAdapter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
