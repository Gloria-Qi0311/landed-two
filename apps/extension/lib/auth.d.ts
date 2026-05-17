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
  export function getSupabase(): any
  export function getSession(): Promise<any>
  export function getUser(): Promise<any>
  export function signInWithOtp(email: string): Promise<{ data: any; error: { message?: string } | null }>
  export function verifyOtp(email: string, token: string): Promise<{ data: any; error: { message?: string } | null }>
  export function signOut(): Promise<{ error: { message?: string } | null }>
  export function onAuthChange(callback: (event: string, session: any) => void): () => void
  export function __resetForTests(): void
}

declare module '@lib/storage-adapter.js' {
  export const chromeStorageAdapter: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
  }
}

declare module '@lib/config.js' {
  export const SUPABASE_URL: string
  export const SUPABASE_ANON_KEY: string
}
