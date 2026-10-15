// Session state. Everyone signs in, but signing in only establishes who you
// are: each account's data stays in this browser unless the account turned
// on Landed Cloud sync (`cloud_sync`), which picks the data store (lib/store).
//
// The session itself is an httpOnly cookie owned by the server. We also
// cache the signed-in account ({id, email, cloud_sync}, no secrets) in
// localStorage so the app keeps working when the server is unreachable:
// a local-only account just carries on offline (its data is all here), a
// Cloud account gets a "can't reach Landed Cloud" notice instead of an
// empty screen. The cache is cleared on sign-out.
import { create } from 'zustand'
import { ApiError, api, setUnauthorizedHandler } from './api'

export type User = { id: string; email: string; cloud_sync: boolean }

const ACCOUNT_KEY = 'landed:account'

function cacheAccount(user: User | null) {
  try {
    if (user) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(user))
    else localStorage.removeItem(ACCOUNT_KEY)
  } catch {
    // storage blocked — the cache is best-effort
  }
}

function cachedAccount(): User | null {
  try {
    const v = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null')
    return v && typeof v.id === 'string' && typeof v.email === 'string' ? { ...v, cloud_sync: !!v.cloud_sync } : null
  } catch {
    return null
  }
}

type AuthState = {
  user: User | null
  ready: boolean // false until the first /auth/session probe settles
  offline: boolean // server unreachable; local-only account running from cache
  unreachable: boolean // server unreachable and the account's data is in Cloud
  sessionExpired: boolean // the session was revoked/expired mid-use
  hydrate: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<string>
  resetPassword: (token: string, password: string) => Promise<User>
  recoverWithCode: (email: string, code: string, password: string) => Promise<User>
  setUser: (user: User | null) => void
  signOut: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  offline: false,
  unreachable: false,
  sessionExpired: false,
  hydrate: async () => {
    try {
      const { user } = await api.get<{ user: User | null }>('/auth/session')
      cacheAccount(user)
      set({ user, ready: true, offline: false, unreachable: false })
    } catch (e) {
      const serverDown = !(e instanceof ApiError) || e.status >= 500
      const cached = serverDown ? cachedAccount() : null
      set({
        user: cached,
        ready: true,
        offline: !!cached && !cached.cloud_sync,
        unreachable: !!cached && cached.cloud_sync,
      })
    }
  },
  signIn: async (email, password) => {
    const { user } = await api.post<{ user: User }>('/auth/login', { email, password })
    get().setUser(user)
  },
  signUp: async (email, password) => {
    const { user } = await api.post<{ user: User }>('/auth/signup', { email, password })
    get().setUser(user)
  },
  requestPasswordReset: async (email) => {
    const { message } = await api.post<{ message: string }>('/auth/forgot-password', { email })
    return message
  },
  resetPassword: async (token, password) => {
    const { user } = await api.post<{ user: User }>('/auth/reset-password', { token, password })
    get().setUser(user)
    return user
  },
  recoverWithCode: async (email, code, password) => {
    const { user } = await api.post<{ user: User }>('/auth/recover-with-code', { email, code, password })
    get().setUser(user)
    return user
  },
  setUser: (user) => {
    cacheAccount(user)
    set({ user, offline: false, unreachable: false, sessionExpired: false })
  },
  signOut: async () => {
    try {
      await api.post('/auth/logout')
    } finally {
      get().setUser(null)
    }
  },
}))

setUnauthorizedHandler(() => {
  if (!useAuth.getState().user) return
  cacheAccount(null)
  useAuth.setState({ user: null, sessionExpired: true })
})
