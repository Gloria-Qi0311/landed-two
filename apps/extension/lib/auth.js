// lib/auth.js — Landed API auth surface for the extension.
//
// Email + password sign-in against apps/server (`mode: 'token'`), which
// returns an opaque session token. The session { token, user } persists in
// chrome.storage.local via lib/storage-adapter.js, so it survives MV3
// service-worker restarts and is shared by popup / options / background.
// The server slides the token's expiry on use; there is nothing to refresh
// client-side. A 401 from any call means the session is gone — we drop it
// locally so every surface flips to signed-out.
//
// Public surface:
//   getSession()                 → Promise<{ token, user } | null>
//   getUser()                    → Promise<{ id, email } | null>
//   signIn(email, password)      → Promise<{ data, error }>
//   signOut()                    → Promise<{ error }>
//   onAuthChange(callback)       → unsubscribe()
//   apiFetch(path, init?)        → Promise<parsed JSON>  (throws on !ok; the
//                                  error carries .status and the server's .code)
//
// No manifest host_permissions needed: the server answers extension
// origins with permissive CORS and auth is the Bearer header, not cookies.

(function (global) {
  const { API_URL, SESSION_STORAGE_KEY } = require('./config.js');
  const { chromeStorageAdapter } = require('./storage-adapter.js');

  function isSession(v) {
    return !!(v && typeof v === 'object' && typeof v.token === 'string' && v.user && v.user.id);
  }

  async function getSession() {
    const raw = await chromeStorageAdapter.getItem(SESSION_STORAGE_KEY);
    return isSession(raw) ? raw : null;
  }

  async function getUser() {
    const session = await getSession();
    return session ? session.user : null;
  }

  async function readError(res, fallback) {
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* non-JSON body */ }
    return fallback + ' (' + res.status + ')';
  }

  async function signIn(email, password) {
    let res;
    try {
      res = await fetch(API_URL + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, mode: 'token' }),
      });
    } catch {
      return { data: null, error: { message: 'Could not reach the Landed server at ' + API_URL } };
    }
    if (!res.ok) return { data: null, error: { message: await readError(res, 'Sign-in failed') } };
    const body = await res.json();
    const session = { token: body.token, user: body.user };
    await chromeStorageAdapter.setItem(SESSION_STORAGE_KEY, session);
    return { data: { session }, error: null };
  }

  async function signOut() {
    const session = await getSession();
    await chromeStorageAdapter.removeItem(SESSION_STORAGE_KEY);
    if (session) {
      // Best-effort server-side revoke; the local session is already gone.
      try {
        await fetch(API_URL + '/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + session.token },
        });
      } catch { /* offline — token expires on its own */ }
    }
    return { error: null };
  }

  function onAuthChange(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return () => {};
    const listener = (changes, area) => {
      if (area !== 'local' || !(SESSION_STORAGE_KEY in changes)) return;
      const next = changes[SESSION_STORAGE_KEY].newValue;
      callback(isSession(next) ? 'SIGNED_IN' : 'SIGNED_OUT', isSession(next) ? next : null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  async function apiFetch(path, init) {
    const session = await getSession();
    if (!session) throw new Error('Not signed in');
    const opts = init || {};
    const res = await fetch(API_URL + '/api' + path, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
        Authorization: 'Bearer ' + session.token,
      },
    });
    if (res.status === 401) {
      await chromeStorageAdapter.removeItem(SESSION_STORAGE_KEY);
      throw Object.assign(new Error('Session expired — sign in again'), { status: 401 });
    }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      const message = (body && typeof body.error === 'string') ? body.error : 'Request failed (' + res.status + ')';
      // `code` lets callers tell e.g. 'cloud_off' (account keeps data on-device) from real failures.
      throw Object.assign(new Error(message), { status: res.status, code: body && body.code });
    }
    return res.status === 204 ? null : res.json();
  }

  global.LandedAuth = { getSession, getUser, signIn, signOut, onAuthChange, apiFetch };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.LandedAuth;
  }
})(typeof window !== 'undefined' ? window : globalThis);
