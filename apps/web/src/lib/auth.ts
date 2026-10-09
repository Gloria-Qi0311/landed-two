// Landed Cloud session state. Landed works without an account (local mode);
// this store only tracks whether this browser is signed in to Landed Cloud,
// which decides the active data store (lib/store).
//
// The session itself is an httpOnly cookie owned by the server. We remember
// the last mode on this device ('landed:mode', device-local UI state) only
// to tell "signed out" apart from "Cloud is unreachable right now": a Cloud
// user whose server is down must not be dropped into an empty local mode.
import { create } from 'zustand'
import { ApiError, api, setUnauthorizedHandler } from './api'

export type User = { id: string; email: string }

const MODE_KEY = 'landed:mode'

function rememberMode(user: User | null) {
  try {
    localStorage.setItem(MODE_KEY, user ? 'cloud' : 'local')
  } catch {
    // storage blocked — mode memory is best-effort
  }
}

function lastModeWasCloud() {
  try {
    return localStorage.getItem(MODE_KEY) === 'cloud'
  } catch {
    return false
  }
}

type AuthState = {
  user: User | null
  ready: boolean // false until the first /auth/session probe settles
  unreachable: boolean // last mode was Cloud but the server can't be reached
  sessionExpired: boolean // a Cloud session was revoked/expired mid-use
  hydrate: () => Promise<void>
  setUser: (user: User | null) => void
  signOut: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  unreachable: false,
  sessionExpired: false,
  hydrate: async () => {
    try {
      const { user } = await api.get<{ user: User | null }>('/auth/session')
      rememberMode(user)
      set({ user, ready: true, unreachable: false })
    } catch (e) {
      // Network error or 5xx. Only a problem if this device was in Cloud mode.
      const serverDown = !(e instanceof ApiError) || e.status >= 500
      set({ user: null, ready: true, unreachable: serverDown && lastModeWasCloud() })
    }
  },
  setUser: (user) => {
    rememberMode(user)
    set({ user, unreachable: false, sessionExpired: false })
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
  rememberMode(null)
  useAuth.setState({ user: null, sessionExpired: true })
})
