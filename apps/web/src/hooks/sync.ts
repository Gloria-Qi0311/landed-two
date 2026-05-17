// TanStack Query hooks for the portal-sync surface (Sync page).
//
// Backed by two tables (see supabase/migrations/20260516235333_initial_schema.sql):
//   - portal_connections — one row per (company, portal-vendor) login
//   - portal_events       — append-only stream emitted by the extension
//
// The browser extension (Sprint 4, #34–#38) will eventually write to both
// tables. Until then, the page is read-only with a DEV-gated demo seed so
// the UI can be exercised without the extension being wired up.
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
 * Upsert a connection on (company_id, provider). The schema doesn't enforce
 * a unique constraint on that pair, so we do client-side: SELECT first, then
 * UPDATE-or-INSERT. Race-prone if two tabs upsert the same pair concurrently
 * (would produce duplicate rows). Acceptable for the dev seed flow; the
 * extension will hit this from a single service worker so multi-tab races
 * are not a real concern.
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

      const { data: existing } = await supabase
        .from('portal_connections')
        .select('id')
        .eq('company_id', input.company_id)
        .eq('provider', input.provider)
        .maybeSingle()

      const patch = {
        portal_host: input.portal_host ?? null,
        status: input.status ?? 'active',
        last_sync_at: input.last_sync_at ?? null,
        failure_reason: input.failure_reason ?? null,
      }

      if (existing?.id) {
        const { data, error } = await supabase
          .from('portal_connections')
          .update(patch)
          .eq('id', existing.id)
          .select()
          .single()
        if (error) throw error
        return data as DbPortalConnection
      }

      const { data, error } = await supabase
        .from('portal_connections')
        .insert({
          user_id: userId,
          company_id: input.company_id,
          provider: input.provider,
          ...patch,
        })
        .select()
        .single()
      if (error) throw error
      return data as DbPortalConnection
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal_connections'] }),
  })
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
