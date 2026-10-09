// Tests for the chrome.storage.local adapter behind the extension's auth
// session persistence (lib/storage-adapter.js).
//
// Tests stub `chrome.storage.local` on globalThis with an in-memory Map
// before requiring the module. Each test starts with a fresh stub.

function makeChromeStorageStub() {
  const data = new Map();
  return {
    storage: {
      local: {
        async get(key) {
          if (key == null) return Object.fromEntries(data);
          if (typeof key === 'string') {
            return data.has(key) ? { [key]: data.get(key) } : {};
          }
          const keys = Array.isArray(key) ? key : Object.keys(key);
          const result = {};
          for (const k of keys) if (data.has(k)) result[k] = data.get(k);
          return result;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) data.set(k, v);
        },
        async remove(key) {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) data.delete(k);
        },
        _data: data,
      },
    },
  };
}

let chromeStorageAdapter;

beforeEach(() => {
  globalThis.chrome = makeChromeStorageStub();
  // Re-require — module-level closure captures `chrome` lazily inside getStorage(),
  // so the stub swap works without resetting modules. But import once.
  ({ chromeStorageAdapter } = require('../lib/storage-adapter.js'));
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('chromeStorageAdapter — basic CRUD', () => {
  test('setItem stores under chrome.storage.local', async () => {
    await chromeStorageAdapter.setItem('sb-session', '{"access_token":"x"}');
    expect(globalThis.chrome.storage.local._data.get('sb-session')).toBe('{"access_token":"x"}');
  });

  test('getItem reads back what setItem stored', async () => {
    await chromeStorageAdapter.setItem('k', 'v');
    expect(await chromeStorageAdapter.getItem('k')).toBe('v');
  });

  test('getItem returns null for a missing key', async () => {
    expect(await chromeStorageAdapter.getItem('missing')).toBe(null);
  });

  test('removeItem deletes the key', async () => {
    await chromeStorageAdapter.setItem('k', 'v');
    await chromeStorageAdapter.removeItem('k');
    expect(await chromeStorageAdapter.getItem('k')).toBe(null);
  });

  test('removeItem is a no-op for a missing key', async () => {
    await expect(chromeStorageAdapter.removeItem('missing')).resolves.toBeUndefined();
  });
});

describe('chromeStorageAdapter — defensive when chrome is missing', () => {
  test('getItem returns null when chrome.storage is unavailable', async () => {
    delete globalThis.chrome;
    expect(await chromeStorageAdapter.getItem('k')).toBe(null);
  });

  test('setItem silently no-ops when chrome.storage is unavailable', async () => {
    delete globalThis.chrome;
    await expect(chromeStorageAdapter.setItem('k', 'v')).resolves.toBeUndefined();
  });

  test('removeItem silently no-ops when chrome.storage is unavailable', async () => {
    delete globalThis.chrome;
    await expect(chromeStorageAdapter.removeItem('k')).resolves.toBeUndefined();
  });
});
