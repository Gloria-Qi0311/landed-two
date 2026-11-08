// Picks the active store for the signed-in account: Landed Cloud when the
// account has cloud_sync on, otherwise that account's own database in this
// browser (one IndexedDB per account, so accounts sharing a browser never
// see each other's local data). Hooks call useStore() and include
// store.kind in their query keys; the query cache is cleared whenever the
// account or its sync mode changes (App.tsx).
import { useAuth, type User } from '../auth'
import { createCloudStore } from './cloud'
import { createLocalStore, type LocalStore } from './local'
import type { DataStore } from './types'

export const cloudStore = createCloudStore()

const localStores = new Map<string, LocalStore>()
export function localStoreFor(userId: string): LocalStore {
  let store = localStores.get(userId)
  if (!store) localStores.set(userId, (store = createLocalStore(`landed-${userId}`)))
  return store
}

function storeFor(user: User): DataStore {
  return user.cloud_sync ? cloudStore : localStoreFor(user.id)
}

/** Only valid below the login gate (a user is always signed in there). */
export function useStore(): { store: DataStore; ready: boolean } {
  const user = useAuth((s) => s.user)
  const ready = useAuth((s) => s.ready && !s.unreachable)
  if (!user) throw new Error('useStore() used while signed out')
  return { store: storeFor(user), ready }
}

/** Non-hook access for code outside components (e.g. the backup download). */
export function currentStore(): DataStore {
  const user = useAuth.getState().user
  if (!user) throw new Error('not signed in')
  return storeFor(user)
}

export * from './types'
