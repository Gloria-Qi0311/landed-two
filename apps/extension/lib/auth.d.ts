// Type declarations for lib/auth.js, lib/storage-adapter.js, lib/config.js.
//
// These files are vanilla IIFE+CJS hybrids (#28 chose that shape for Jest+MV3
// compatibility — see lib/auth.js header comment). TypeScript can't infer
// named exports through the IIFE wrapper, so the popup's
// `import * as auth from '@lib/auth.js'` errors at typecheck time without
// explicit declarations.
//
// When #29/#30 collapse the popup/options onto the bundler, lib/auth.js may
// be re-authored as proper ESM and these declarations can be deleted.

declare module '@lib/auth.js' {
  export type Session = { token: string; user: { id: string; email: string } }
  export function getSession(): Promise<Session | null>
  export function getUser(): Promise<Session['user'] | null>
  export function signIn(email: string, password: string): Promise<{ data: { session: Session } | null; error: { message?: string } | null }>
  export function signOut(): Promise<{ error: { message?: string } | null }>
  export function onAuthChange(callback: (event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) => void): () => void
  export function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T>
}

declare module '@lib/storage-adapter.js' {
  export const chromeStorageAdapter: {
    getItem(key: string): Promise<unknown>
    setItem(key: string, value: unknown): Promise<void>
    removeItem(key: string): Promise<void>
  }
}

declare module '@lib/config.js' {
  export const API_URL: string
  export const WEB_ORIGINS: string[]
  export const SESSION_STORAGE_KEY: string
  export const LOCAL_RESUMES_KEY: string
}
