// Session state for the web app (replaces supabase.auth). The session itself
// is an httpOnly cookie owned by the server; this store only mirrors who is
// signed in so the UI can gate on it.
import { create } from 'zustand'
import { api, setUnauthorizedHandler } from './api'

export type User = { id: string; email: string }

type AuthState = {
  user: User | null
  ready: boolean // false until the first /auth/session probe resolves
  hydrate: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,
  hydrate: async () => {
    try {
      const { user } = await api.get<{ user: User | null }>('/auth/session')
      set({ user, ready: true })
    } catch {
      set({ user: null, ready: true })
    }
  },
  signIn: async (email, password) => {
    const { user } = await api.post<{ user: User }>('/auth/login', { email, password })
    set({ user })
  },
  signUp: async (email, password) => {
    const { user } = await api.post<{ user: User }>('/auth/signup', { email, password })
    set({ user })
  },
  signOut: async () => {
    try {
      await api.post('/auth/logout')
    } finally {
      set({ user: null })
    }
  },
}))

setUnauthorizedHandler(() => useAuth.setState({ user: null }))
