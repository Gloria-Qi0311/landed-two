// TanStack Query hooks for the portal-sync surface (Sync page).
//
// Backed by two tables (see apps/server/migrations/0001_init.sql):
//   - portal_connections — one row per (company, portal-vendor) login
//   - portal_events       — append-only stream emitted by the extension
//
// The browser extension pushes events to the API; the page also has a
// DEV-gated demo seed so the UI can be exercised without the extension.
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'

// ── DB types (mirror the Postgres enums + tables verbatim) ────────────────

export type PortalProvider =
  | 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'bamboohr'
  | 'boss' | 'smartrecruiters' | 'other'

export type PortalStatus = 'active' | 'syncing' | 'expired' | 'disconnected'

export type PortalEventType = 'status-change' | 'new-event' | 'expired' | 'sync' | 'rejection'

export type DbPortalConnection = {
  id: string
  user_id: string
  company_id: string
  provider: PortalProvider
  portal_host: string | null
  status: PortalStatus
  last_sync_at: string | null
  last_seen_login_at: string | null
  failure_reason: string | null
  created_at: string
}

export type DbPortalEvent = {
  id: string
  user_id: string
  connection_id: string | null
  application_id: string | null
  type: PortalEventType
  payload_json: Record<string, unknown>
  created_at: string
}

// ── Reads ─────────────────────────────────────────────────────────────────

export function usePortalConnections() {
  const signedIn = useAuth((s) => !!s.user)
  return useQuery({
    queryKey: ['portal_connections'],
    enabled: signedIn,
    queryFn: () => api.get<DbPortalConnection[]>('/portal-connections'),
  })
}

/**
 * Activity feed — most recent N events. Default limit 50 keeps the feed
 * snappy; users who want history can paginate later. Ordered by created_at
 * desc, leveraging portal_events_user_created_idx.
 */
export function usePortalEvents(limit = 50) {
  const signedIn = useAuth((s) => !!s.user)
  return useQuery({
    queryKey: ['portal_events', limit],
    enabled: signedIn,
    queryFn: () => api.get<DbPortalEvent[]>(`/portal-events?limit=${limit}`),
  })
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Upsert a connection on (user_id, company_id, provider). The server does a
 * single INSERT ... ON CONFLICT against the unique constraint — no
 * SELECT-then-UPDATE-or-INSERT race window.
 */
export function useUpsertPortalConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      company_id: string
      provider: PortalProvider
      portal_host?: string | null
      status?: PortalStatus
      last_sync_at?: string | null
      failure_reason?: string | null
    }) => api.put<DbPortalConnection>('/portal-connections', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_connections'] }),
  })
}

// ── Realtime: subscribe to portal_events INSERT (#38) ────────────────────
//
// The extension push pipeline (#35) inserts rows into portal_events via the
// API. This hook holds an EventSource on /api/portal-events/stream (SSE fed
// by Postgres LISTEN/NOTIFY on the server) so the Sync page reflects new
// events without polling. The server only streams the signed-in user's rows.
//
//   - On each `portal_event` message: invalidate the cached ['portal_events']
//     query so the activity list refreshes from the source of truth (avoids
//     splicing the incoming row into the cache and getting shape drift).
//   - Returns the most recent event for opt-in inline UX (toast/banner).
//   - EventSource reconnects on its own after network drops; closed on
//     unmount so streams don't accumulate across navigation.
export function usePortalEventsRealtime() {
  const qc = useQueryClient()
  const signedIn = useAuth((s) => !!s.user)
  const [latest, setLatest] = useState<DbPortalEvent | null>(null)
  useEffect(() => {
    if (!signedIn) return
    const source = new EventSource('/api/portal-events/stream')
    source.addEventListener('portal_event', (e) => {
      try {
        setLatest(JSON.parse((e as MessageEvent).data) as DbPortalEvent)
      } catch {
        // malformed frame — still refresh from the source of truth below
      }
      qc.invalidateQueries({ queryKey: ['portal_events'] })
    })
    return () => source.close()
  }, [qc, signedIn])
  return latest
}

export function useAddPortalEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      type: PortalEventType
      connection_id?: string | null
      application_id?: string | null
      payload_json?: Record<string, unknown>
    }) => {
      const { rows } = await api.post<{ rows: DbPortalEvent[] }>('/portal-events', input)
      return rows[0]
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_events'] }),
  })
}
