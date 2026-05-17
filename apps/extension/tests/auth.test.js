// Tests for the extension's Supabase auth wrapper (lib/auth.js).
//
// Doesn't hit the network: we mock `@supabase/supabase-js` createClient
// so each helper just verifies the right method gets called with the
// right shape. End-to-end OTP flow is exercised manually in #29 when
// the popup React UI lands.

// `mock`-prefixed name is the only way to reference a closure var from
// inside jest.mock()'s factory (Jest hoists the factory; mock-prefixed
// names are exempt from the "out-of-scope variable" guard).
const mockStubClient = {
  auth: {
    getSession: jest.fn(async () => ({ data: { session: null } })),
    getUser: jest.fn(async () => ({ data: { user: null } })),
    signInWithOtp: jest.fn(async () => ({ data: {}, error: null })),
    verifyOtp: jest.fn(async () => ({ data: {}, error: null })),
    signOut: jest.fn(async () => ({ error: null })),
    onAuthStateChange: jest.fn(() => ({
      data: { subscription: { unsubscribe: jest.fn() } },
    })),
  },
};

let mockedCreateClient;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockStubClient),
}));

beforeEach(() => {
  // chrome.storage.local stub — auth.js doesn't actively touch it but
  // storage-adapter.js (transitively required via auth.js) reads from
  // globalThis.chrome at call time.
  globalThis.chrome = {
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  };
  jest.resetModules();
  jest.clearAllMocks();
  mockedCreateClient = require('@supabase/supabase-js').createClient;
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('getSupabase — singleton + correct init', () => {
  test('returns the same instance on repeat calls', () => {
    const auth = require('../lib/auth.js');
    const a = auth.getSupabase();
    const b = auth.getSupabase();
    expect(a).toBe(b);
    expect(mockedCreateClient).toHaveBeenCalledTimes(1);
  });

  test('initializes with chromeStorageAdapter + persistSession + autoRefreshToken + detectSessionInUrl=false', () => {
    const auth = require('../lib/auth.js');
    auth.getSupabase();
    const [url, key, options] = mockedCreateClient.mock.calls[0];
    expect(url).toMatch(/^https:\/\/.+\.supabase\.co$/);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(20); // anon key is a JWT
    expect(options.auth.persistSession).toBe(true);
    expect(options.auth.autoRefreshToken).toBe(true);
    expect(options.auth.detectSessionInUrl).toBe(false); // popup has no URL
    expect(typeof options.auth.storage.getItem).toBe('function');
    expect(typeof options.auth.storage.setItem).toBe('function');
    expect(typeof options.auth.storage.removeItem).toBe('function');
  });

  test('__resetForTests allows a fresh init', () => {
    const auth = require('../lib/auth.js');
    auth.getSupabase();
    auth.__resetForTests();
    auth.getSupabase();
    expect(mockedCreateClient).toHaveBeenCalledTimes(2);
  });
});

describe('OTP flow helpers', () => {
  test('signInWithOtp forwards the email', async () => {
    const auth = require('../lib/auth.js');
    await auth.signInWithOtp('user@example.com');
    expect(mockStubClient.auth.signInWithOtp).toHaveBeenCalledWith({ email: 'user@example.com' });
  });

  test('verifyOtp passes email + token + type=email', async () => {
    const auth = require('../lib/auth.js');
    await auth.verifyOtp('user@example.com', '123456');
    expect(mockStubClient.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: '123456',
      type: 'email',
    });
  });
});

describe('Session + user accessors', () => {
  test('getSession unwraps the data.session shape', async () => {
    mockStubClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { access_token: 'tok', user: { id: 'u1' } } },
    });
    const auth = require('../lib/auth.js');
    const session = await auth.getSession();
    expect(session).toEqual({ access_token: 'tok', user: { id: 'u1' } });
  });

  test('getSession returns null when no session', async () => {
    const auth = require('../lib/auth.js');
    expect(await auth.getSession()).toBe(null);
  });

  test('getUser unwraps the data.user shape', async () => {
    mockStubClient.auth.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1', email: 'a@b.co' } },
    });
    const auth = require('../lib/auth.js');
    const user = await auth.getUser();
    expect(user).toEqual({ id: 'u1', email: 'a@b.co' });
  });
});

describe('signOut + onAuthChange', () => {
  test('signOut delegates to supabase.auth.signOut', async () => {
    const auth = require('../lib/auth.js');
    await auth.signOut();
    expect(mockStubClient.auth.signOut).toHaveBeenCalledTimes(1);
  });

  test('onAuthChange registers a callback + returns an unsubscribe fn', () => {
    const auth = require('../lib/auth.js');
    const callback = jest.fn();
    const unsubscribe = auth.onAuthChange(callback);
    expect(mockStubClient.auth.onAuthStateChange).toHaveBeenCalledWith(callback);
    expect(typeof unsubscribe).toBe('function');
    // Calling unsubscribe should invoke the underlying subscription.unsubscribe
    const sub = mockStubClient.auth.onAuthStateChange.mock.results[0].value.data.subscription;
    unsubscribe();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});
