// Tests for the extension's Landed API auth wrapper (lib/auth.js).
//
// Doesn't hit the network: globalThis.fetch is a jest.fn per test and
// chrome.storage.local is an in-memory stub, so each helper is checked for
// the request it makes and the session it stores / clears.

const { API_URL, SESSION_STORAGE_KEY } = require('../lib/config.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

let store;
let changeListeners;

beforeEach(() => {
  store = new Map();
  changeListeners = new Set();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            const oldValue = store.get(k);
            store.set(k, v);
            for (const l of changeListeners) l({ [k]: { oldValue, newValue: v } }, 'local');
          }
        },
        async remove(key) {
          const oldValue = store.get(key);
          store.delete(key);
          for (const l of changeListeners) l({ [key]: { oldValue, newValue: undefined } }, 'local');
        },
      },
      onChanged: {
        addListener: (l) => changeListeners.add(l),
        removeListener: (l) => changeListeners.delete(l),
      },
    },
  };
  globalThis.fetch = jest.fn();
  jest.resetModules();
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

const SESSION = { token: 'tok-123', user: { id: 'u1', email: 'a@b.co' } };

describe('signIn', () => {
  test('POSTs email + password in token mode and stores the session', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { token: SESSION.token, user: SESSION.user }));
    const auth = require('../lib/auth.js');
    const result = await auth.signIn('a@b.co', 'hunter2hunter2');

    expect(result).toEqual({ data: { session: SESSION }, error: null });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(API_URL + '/api/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.co', password: 'hunter2hunter2', mode: 'token' });
    expect(store.get(SESSION_STORAGE_KEY)).toEqual(SESSION);
  });

  test('surfaces the server error message and stores nothing', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(401, { error: 'wrong email or password' }));
    const auth = require('../lib/auth.js');
    const result = await auth.signIn('a@b.co', 'nope');
    expect(result).toEqual({ data: null, error: { message: 'wrong email or password' } });
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  test('network failure → readable error', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const auth = require('../lib/auth.js');
    const result = await auth.signIn('a@b.co', 'pw');
    expect(result.error.message).toMatch(/Could not reach the Landed server/);
  });
});

describe('session accessors', () => {
  test('getSession / getUser read the stored session', async () => {
    store.set(SESSION_STORAGE_KEY, SESSION);
    const auth = require('../lib/auth.js');
    expect(await auth.getSession()).toEqual(SESSION);
    expect(await auth.getUser()).toEqual(SESSION.user);
  });

  test('null when signed out or the stored value is malformed', async () => {
    const auth = require('../lib/auth.js');
    expect(await auth.getSession()).toBe(null);
    expect(await auth.getUser()).toBe(null);
    store.set(SESSION_STORAGE_KEY, { access_token: 'old-supabase-shape' });
    expect(await auth.getSession()).toBe(null);
  });
});

describe('signOut', () => {
  test('clears the local session and revokes it server-side', async () => {
    store.set(SESSION_STORAGE_KEY, SESSION);
    fetch.mockResolvedValueOnce(jsonResponse(204, null));
    const auth = require('../lib/auth.js');
    expect(await auth.signOut()).toEqual({ error: null });
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(API_URL + '/api/auth/logout');
    expect(init.headers.Authorization).toBe('Bearer ' + SESSION.token);
  });

  test('still signs out locally when the server is unreachable', async () => {
    store.set(SESSION_STORAGE_KEY, SESSION);
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    const auth = require('../lib/auth.js');
    expect(await auth.signOut()).toEqual({ error: null });
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
  });
});

describe('onAuthChange', () => {
  test('fires SIGNED_IN / SIGNED_OUT on storage changes; unsubscribe stops it', async () => {
    const auth = require('../lib/auth.js');
    const callback = jest.fn();
    const unsubscribe = auth.onAuthChange(callback);

    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: SESSION });
    await chrome.storage.local.set({ unrelated: 1 });
    await chrome.storage.local.remove(SESSION_STORAGE_KEY);
    expect(callback.mock.calls).toEqual([['SIGNED_IN', SESSION], ['SIGNED_OUT', null]]);

    unsubscribe();
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: SESSION });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

describe('apiFetch', () => {
  test('sends the Bearer token and returns parsed JSON', async () => {
    store.set(SESSION_STORAGE_KEY, SESSION);
    fetch.mockResolvedValueOnce(jsonResponse(200, [{ id: 'r1' }]));
    const auth = require('../lib/auth.js');
    expect(await auth.apiFetch('/resumes')).toEqual([{ id: 'r1' }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(API_URL + '/api/resumes');
    expect(init.headers.Authorization).toBe('Bearer ' + SESSION.token);
  });

  test('401 drops the local session so the UI flips to signed-out', async () => {
    store.set(SESSION_STORAGE_KEY, SESSION);
    fetch.mockResolvedValueOnce(jsonResponse(401, { error: 'session expired' }));
    const auth = require('../lib/auth.js');
    await expect(auth.apiFetch('/resumes')).rejects.toThrow(/sign in again/);
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  test('throws without a session and never calls the network', async () => {
    const auth = require('../lib/auth.js');
    await expect(auth.apiFetch('/resumes')).rejects.toThrow(/Not signed in/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
