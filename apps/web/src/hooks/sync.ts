// TanStack Query hooks for the portal-sync surface (Sync page), over the
// active data store (this device or Landed Cloud — see lib/store).
//
// Two tables:
//   - portal_connections — one row per (company, portal-vendor) login
//   - portal_events       — append-only stream emitted by the extension
//
// The browser extension hands events to this page (lib/extension-bridge) or,
// when signed in to Cloud, pushes them to the API itself. The page also has
// a DEV-gated demo seed so the UI can be exercised without the extension.
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useStore,
  type ConnectionInput, type DbPortalConnection, type DbPortalEvent, type PortalEventInput,
} from '../lib/store'

export type {
  DbPortalConnection, DbPortalEvent, PortalEventType, PortalProvider, PortalStatus,
} from '../lib/store'

// ── Reads ─────────────────────────────────────────────────────────────────

export function usePortalConnections() {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['portal_connections', store.kind],
    enabled: ready,
    queryFn: (): Promise<DbPortalConnection[]> => store.listPortalConnections(),
  })
}

/**
 * Activity feed — most recent N events. Default limit 50 keeps the feed
 * snappy; users who want history can paginate later. Ordered by created_at
 * desc, leveraging portal_events_user_created_idx.
 */
export function usePortalEvents(limit = 50) {
  const { store, ready } = useStore()
  return useQuery({
    queryKey: ['portal_events', store.kind, limit],
    enabled: ready,
    queryFn: (): Promise<DbPortalEvent[]> => store.listPortalEvents(limit),
  })
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Upsert a connection on (company_id, provider) — a single atomic upsert in
 * both stores, never SELECT-then-UPDATE-or-INSERT (see CLAUDE.md).
 */
export function useUpsertPortalConnection() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: (input: ConnectionInput) => store.upsertPortalConnection(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_connections'] }),
  })
}

// ── Realtime: subscribe to portal_events INSERT (#38) ────────────────────
//
// New events arrive from the extension (via the bridge, or pushed straight to
// Cloud), from other tabs, or from this tab. The active store's subscription
// covers all of them: local mode uses an in-page emitter + BroadcastChannel,
// Cloud mode an EventSource on /api/portal-events/stream.
//
//   - On each insert: invalidate the cached ['portal_events'] query so the
//     activity list refreshes from the source of truth (avoids splicing the
//     incoming row into the cache and getting shape drift).
//   - Returns the most recent event for opt-in inline UX (toast/banner).
export function usePortalEventsRealtime() {
  const qc = useQueryClient()
  const { store, ready } = useStore()
  const [latest, setLatest] = useState<DbPortalEvent | null>(null)
  useEffect(() => {
    if (!ready) return
    return store.subscribePortalEvents((row) => {
      setLatest(row)
      qc.invalidateQueries({ queryKey: ['portal_events'] })
    })
  }, [qc, store, ready])
  return latest
}

export function useAddPortalEvent() {
  const qc = useQueryClient()
  const { store } = useStore()
  return useMutation({
    mutationFn: async (input: PortalEventInput) => (await store.addPortalEvents([input]))[0],
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_events'] }),
  })
}
