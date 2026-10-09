// Picks the active store: Landed Cloud while signed in, otherwise this
// browser's local database. Hooks call useStore() and include store.kind in
// their query keys so the two never share cached rows.
import { useAuth } from '../auth'
import { createCloudStore } from './cloud'
import { createLocalStore } from './local'
import type { AiRunInsert } from '@landed/ai-roundtrip'
import type { DataStore } from './types'

export const localStore = createLocalStore()
export const cloudStore = createCloudStore()

export function useStore(): { store: DataStore; ready: boolean } {
  const signedIn = useAuth((s) => !!s.user)
  const ready = useAuth((s) => s.ready && !s.unreachable)
  return { store: signedIn ? cloudStore : localStore, ready }
}

/** Non-hook access for code outside components (e.g. the AI-run sink). */
export function currentStore(): DataStore {
  return useAuth.getState().user ? cloudStore : localStore
}

/** Sink for @landed/ai-roundtrip's saveAiRun — persists one ai_runs row. */
export const insertAiRun: AiRunInsert = (row) => currentStore().addAiRun(row)

export * from './types'
