// TanStack Query hooks for the portal-sync surface (Sync page).
//
// Backed by two tables (see supabase/migrations/20260516235333_initial_schema.sql):
//   - portal_connections — one row per (company, portal-vendor) login
//   - portal_events       — append-only stream emitted by the extension
//
// The browser extension (Sprint 4, #34–#38) will eventually write to both
// tables. Until then, the page is read-only with a DEV-gated demo seed so
// the UI can be exercised without the extension being wired up.
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

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
  return useQuery({
    queryKey: ['portal_connections'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('portal_connections')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as DbPortalConnection[]
    },
  })
}

/**
 * Activity feed — most recent N events. Default limit 50 keeps the feed
 * snappy; users who want history can paginate later. Ordered by created_at
 * desc, leveraging portal_events_user_created_idx.
 */
export function usePortalEvents(limit = 50) {
  return useQuery({
    queryKey: ['portal_events', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('portal_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return (data ?? []) as DbPortalEvent[]
    },
  })
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Upsert a connection on (user_id, company_id, provider). Backed by the
 * unique constraint added in 20260517070000_portal_connections_unique.sql,
 * so this is a single atomic .upsert() — no SELECT-then-UPDATE-or-INSERT
 * race window.
 */
export function useUpsertPortalConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      company_id: string
      provider: PortalProvider
      portal_host?: string | null
      status?: PortalStatus
      last_sync_at?: string | null
      failure_reason?: string | null
    }) => {
      const userRes = await supabase.auth.getUser()
      const userId = userRes.data.user?.id
      if (!userId) throw new Error('not signed in')

      const { data, error } = await supabase
        .from('portal_connections')
        .upsert(
          {
            user_id: userId,
            company_id: input.company_id,
            provider: input.provider,
            portal_host: input.portal_host ?? null,
            status: input.status ?? 'active',
            last_sync_at: input.last_sync_at ?? null,
            failure_reason: input.failure_reason ?? null,
          },
          { onConflict: 'user_id,company_id,provider' },
        )
        .select()
        .single()
      if (error) throw error
      return data as DbPortalConnection
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_connections'] }),
  })
}

// ── Realtime: subscribe to portal_events INSERT (#38) ────────────────────
//
// The extension push pipeline (#35) inserts rows into portal_events via
// PostgREST. This hook subscribes to Supabase Realtime so the Sync page
// reflects new events without polling.
//
// Mechanics:
//   - One per-mount channel ('portal-events:<random>'), with a unique
//     suffix so two tabs / two mounts don't collide on the channel name
//     (Supabase Realtime keys channels by name across the auth session).
//   - postgres_changes filter on INSERT against public.portal_events. RLS
//     is honored on the server side; subscribers only see their own rows.
//   - On INSERT: invalidate the cached ['portal_events'] query so the
//     activity list refreshes from the source of truth (avoids us trying
//     to splice the incoming row into the cache and getting cache shape
//     drift).
//   - Returns the most recent event for opt-in inline UX (toast/banner).
//
// Requires the migration 20260517072000_portal_events_realtime.sql which
// adds public.portal_events to the supabase_realtime publication. Without
// that, the subscription succeeds silently but never fires.
//
// Channel teardown on unmount via supabase.removeChannel — important
// because subscriptions accumulate across navigation otherwise (Supabase
// JS doesn't garbage-collect channels on its own).
export function usePortalEventsRealtime() {
  const qc = useQueryClient()
  const [latest, setLatest] = useState<DbPortalEvent | null>(null)
  useEffect(() => {
    // Unique channel name per mount so concurrent SyncPage instances
    // (e.g. two browser tabs) don't collide.
    const name = 'portal-events:' + Math.random().toString(36).slice(2)
    const channel = supabase
      .channel(name)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: 'INSERT', schema: 'public', table: 'portal_events' },
        (payload: { new: DbPortalEvent }) => {
          if (payload && payload.new) setLatest(payload.new)
          qc.invalidateQueries({ queryKey: ['portal_events'] })
        },
      )
      .subscribe()
    return () => {
      // removeChannel both unsubscribes and removes from the client's
      // tracked-channels list.
      supabase.removeChannel(channel)
    }
  }, [qc])
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
      const userRes = await supabase.auth.getUser()
      const userId = userRes.data.user?.id
      if (!userId) throw new Error('not signed in')

      const { data, error } = await supabase
        .from('portal_events')
        .insert({
          user_id: userId,
          type: input.type,
          connection_id: input.connection_id ?? null,
          application_id: input.application_id ?? null,
          payload_json: input.payload_json ?? {},
        })
        .select()
        .single()
      if (error) throw error
      return data as DbPortalEvent
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_events'] }),
  })
}
