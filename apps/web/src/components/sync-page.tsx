// Sync page — DB-backed (issue #23).
//
// Reads:
//   - portal_connections (per-portal-vendor login) via usePortalConnections
//   - portal_events (append-only activity stream)   via usePortalEvents
// Joins to companies + applications via the existing react-query caches
// rather than Postgres-side joins — the caches are already populated for
// other pages and a client-side lookup is cheaper than a fresh round-trip.
//
// Until the browser extension (Sprint 4, #34–#38) starts emitting writes,
// a DEV-gated "Seed demo data" button can populate both tables so the page
// renders meaningfully.
//
// Replaces the prototype port at src/components/sync-page.jsx, which used
// hardcoded COMPANIES / PORTAL_STATUS arrays.
import React, { useEffect, useMemo, useState } from 'react'
import { CompanyMark, Icon } from './primitives'
import { PageHeader } from './shell'
import { useCompanies, useApplications } from '../hooks/queries'
import {
  usePortalConnections, usePortalEvents, usePortalEventsRealtime,
  useUpsertPortalConnection, useAddPortalEvent,
  type DbPortalConnection, type DbPortalEvent,
  type PortalProvider, type PortalStatus, type PortalEventType,
} from '../hooks/sync'
import { formatRelative, formatTimestamp } from '../lib/time'

// Matches toCompanyShape() output in hooks/queries.ts. Replicated here so
// sync-page doesn't have to import an inferred return type.
type CompanyShape = { id: string; name: string; logo: string; hue: number }

// ── Display helpers ───────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<PortalProvider, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  bamboohr: 'BambooHR',
  boss: 'BOSS Zhipin',
  smartrecruiters: 'SmartRecruiters',
  other: 'Other',
}

const STATUS_LABEL: Record<PortalStatus, string> = {
  active: 'Active',
  syncing: 'Syncing',
  expired: 'Expired',
  disconnected: 'Disconnected',
}

const EVENT_ICON: Record<PortalEventType, { icon: string; color: string }> = {
  'status-change': { icon: 'arrowRight', color: 'oklch(0.55 0.13 240)' },
  'expired':       { icon: 'alert',      color: 'oklch(0.55 0.16 30)' },
  'new-event':     { icon: 'calendar',   color: 'oklch(0.50 0.13 270)' },
  'sync':          { icon: 'refresh',    color: 'oklch(0.55 0.04 240)' },
  'rejection':     { icon: 'x',          color: 'oklch(0.55 0.14 25)' },
}

const EVENT_TEXT: Record<PortalEventType, string> = {
  'status-change': 'Stage changed',
  'expired':       'Login expired',
  'new-event':     'New event',
  'sync':          'Auto-sync',
  'rejection':     'Rejection received',
}

// ── Main page ─────────────────────────────────────────────────────────────

type Tab = 'overview' | 'connections' | 'activity'

export function SyncPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [seedNotice, setSeedNotice] = useState<string>('')
  const [seeding, setSeeding] = useState(false)

  const { data: connections = [], isLoading: connLoading } = usePortalConnections()
  const { data: events = [], isLoading: evLoading } = usePortalEvents(50)
  const { data: companies = [] } = useCompanies()
  const { data: applications = [] } = useApplications()

  // Live updates from the extension push pipeline (#35). The hook
  // already invalidates the events query; `latest` powers an inline
  // banner. Under rapid arrivals (#38.3), we aggregate into
  // `recentBatch` so the banner shows "N new events" instead of
  // flickering through individual ones. The 6s dismiss timer RESETS
  // on every arrival, so the banner stays visible 6s past the LAST
  // event in a burst, not 6s past the first.
  const liveEvent = usePortalEventsRealtime()
  const [recentBatch, setRecentBatch] = useState<DbPortalEvent[]>([])
  useEffect(() => {
    if (!liveEvent) return
    // Append + cap. 100 is generous: a flood beyond that would be
    // suspicious anyway and we just need an accurate count, not the
    // events themselves.
    setRecentBatch((prev) => {
      // Dedup by id — Realtime can occasionally double-fire on reconnect.
      if (prev.some((e) => e.id === liveEvent.id)) return prev
      const next = prev.concat(liveEvent)
      return next.length > 100 ? next.slice(-100) : next
    })
    const t = setTimeout(() => {
      // Only clear if THIS event is still the most recent in the batch
      // (i.e. no newer event has arrived since this timer started).
      setRecentBatch((cur) => {
        if (cur.length === 0) return cur
        const last = cur[cur.length - 1]
        return last && last.id === liveEvent.id ? [] : cur
      })
    }, 6000)
    return () => clearTimeout(t)
  }, [liveEvent])

  const companyById = useMemo(() => {
    const m = new Map<string, CompanyShape>()
    for (const c of companies) m.set(c.id, c)
    return m
  }, [companies])

  const connById = useMemo(() => {
    const m = new Map<string, DbPortalConnection>()
    for (const c of connections) m.set(c.id, c)
    return m
  }, [connections])

  const appById = useMemo(() => {
    const m = new Map<string, { id: string; role?: string; companyId?: string }>()
    for (const a of applications) m.set(a.id, a)
    return m
  }, [applications])

  const statusCounts = useMemo(() => ({
    active: connections.filter((c) => c.status === 'active').length,
    syncing: connections.filter((c) => c.status === 'syncing').length,
    expired: connections.filter((c) => c.status === 'expired').length,
    disconnected: connections.filter((c) => c.status === 'disconnected').length,
  }), [connections])

  const lastSyncIso = useMemo(() => {
    let max: string | null = null
    for (const c of connections) {
      if (c.last_sync_at && (!max || c.last_sync_at > max)) max = c.last_sync_at
    }
    return max
  }, [connections])

  // ── Seed (DEV only) ──────────────────────────────────────────────────────

  const upsertConn = useUpsertPortalConnection()
  const addEvent = useAddPortalEvent()
  const onSeedDemo = async () => {
    if (companies.length === 0) {
      setSeedNotice('Add an application first — seed needs at least one company in your account.')
      return
    }
    setSeeding(true)
    setSeedNotice('')
    try {
      const targets = companies.slice(0, Math.min(4, companies.length))
      const providers: PortalProvider[] = ['greenhouse', 'lever', 'workday', 'ashby']
      const statuses: PortalStatus[] = ['active', 'syncing', 'expired', 'active']
      let added = 0
      for (let i = 0; i < targets.length; i++) {
        const provider = providers[i % providers.length]
        const status = statuses[i % statuses.length]
        const conn = await upsertConn.mutateAsync({
          company_id: targets[i].id,
          provider,
          portal_host: `${provider}.com`,
          status,
          last_sync_at: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
          failure_reason: status === 'expired' ? 'Session cookie expired' : null,
        })
        added++
        await addEvent.mutateAsync({
          type: 'sync',
          connection_id: conn.id,
          payload_json: { detected: 0, source: 'demo-seed' },
        })
        if (status === 'expired') {
          await addEvent.mutateAsync({
            type: 'expired',
            connection_id: conn.id,
            payload_json: { reason: 'cookie', source: 'demo-seed' },
          })
        } else if (i === 0) {
          await addEvent.mutateAsync({
            type: 'status-change',
            connection_id: conn.id,
            payload_json: { from: 'applied', to: 'phone', source: 'demo-seed' },
          })
        }
      }
      setSeedNotice(`Seeded ${added} connection${added === 1 ? '' : 's'} + events.`)
      setTimeout(() => setSeedNotice(''), 5000)
    } catch (e) {
      setSeedNotice(`Seed failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSeeding(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Sync"
        subtitle={
          connLoading
            ? 'Loading…'
            : connections.length === 0
              ? 'No portals connected yet — the browser extension (coming in Sprint 4) will populate this.'
              : `Browser extension watching ${connections.length} portal${connections.length === 1 ? '' : 's'}${lastSyncIso ? ` · last sync ${formatRelative(lastSyncIso)}` : ''}`
        }
        actions={
          <button className="btn-secondary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            <Icon name="external" size={13} /> Extension v0.4.2
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 24px' }}>
        {recentBatch.length > 0 && (
          <LiveEventBanner
            batch={recentBatch}
            onDismiss={() => setRecentBatch([])}
            onViewAll={() => { setTab('activity'); setRecentBatch([]) }}
          />
        )}

        {/* Top status strip */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
          <ExtCard
            label="Extension"
            value="Not connected"
            sub="Install Sprint 4 build"
            dot="oklch(0.65 0.04 240)"
          />
          <ExtCard
            label="Portals watched"
            value={connections.length}
            sub={`${statusCounts.active} active · ${statusCounts.syncing} syncing`}
          />
          <ExtCard
            label="Needs attention"
            value={statusCounts.expired + statusCounts.disconnected}
            sub={statusCounts.expired > 0 ? `${statusCounts.expired} expired session${statusCounts.expired === 1 ? '' : 's'}` : 'All healthy'}
            warn={statusCounts.expired + statusCounts.disconnected > 0}
          />
          <ExtCard
            label="Last sync"
            value={lastSyncIso ? formatRelative(lastSyncIso) : '—'}
            sub={lastSyncIso ? formatTimestamp(lastSyncIso) : 'Awaiting first sync'}
          />
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 2, background: 'var(--surface-2)', padding: 3, borderRadius: 7,
          width: 'fit-content', marginBottom: 12, border: '0.5px solid var(--border)',
        }}>
          {([
            { id: 'overview' as const, label: 'Overview' },
            { id: 'connections' as const, label: `Connections (${connections.length})` },
            { id: 'activity' as const, label: `Activity feed (${events.length})` },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: tab === t.id ? 'var(--surface)' : 'transparent',
                color: tab === t.id ? 'var(--fg)' : 'var(--fg-muted)',
                border: 'none', borderRadius: 5, cursor: 'pointer',
                boxShadow: tab === t.id ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* DEV-gated demo seed */}
        {import.meta.env.DEV && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              padding: '8px 12px', background: 'var(--surface-2)',
              border: '0.5px dashed var(--border)', borderRadius: 8,
              fontSize: 11.5, color: 'var(--fg-muted)',
            }}
          >
            <span>
              <strong style={{ color: 'var(--fg)' }}>Dev</strong>{' '}
              {companies.length === 0
                ? '· no companies in your account yet — add an application first (or use Import demo data on /applications) to enable seeding'
                : `· seed ${Math.min(4, companies.length)} sample portal connections + events (uses your existing compan${companies.length === 1 ? 'y' : 'ies'})`}
            </span>
            <div style={{ flex: 1 }} />
            <button
              className="btn-secondary"
              onClick={onSeedDemo}
              disabled={seeding}
              style={{ fontSize: 11, opacity: seeding ? 0.6 : 1 }}
            >
              <Icon name="plus" size={11} /> {seeding ? 'Seeding…' : 'Seed sample data'}
            </button>
            {seedNotice && <span style={{ marginLeft: 8 }}>{seedNotice}</span>}
          </div>
        )}

        {tab === 'overview' && (
          <OverviewTab
            connections={connections}
            events={events}
            companyById={companyById}
            connById={connById}
            appById={appById}
          />
        )}
        {tab === 'connections' && (
          <ConnectionsTab
            connections={connections}
            companyById={companyById}
            loading={connLoading}
          />
        )}
        {tab === 'activity' && (
          <ActivityTab
            events={events}
            companyById={companyById}
            connById={connById}
            appById={appById}
            loading={evLoading}
          />
        )}
      </div>
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────────

function LiveEventBanner({
  batch, onDismiss, onViewAll,
}: {
  batch: DbPortalEvent[]
  onDismiss: () => void
  onViewAll: () => void
}) {
  if (batch.length === 0) return null
  const latest = batch[batch.length - 1]
  const latestPayload = (latest.payload_json || {}) as Record<string, unknown>
  const latestSource = typeof latestPayload.source === 'string' ? latestPayload.source : 'portal'

  // Single-event vs aggregate display. Aggregate when there are 2+ events
  // (rapid arrivals — without this, the banner would flicker through
  // each one in sequence, only showing the last). Single-event keeps the
  // existing detailed format.
  const isAggregate = batch.length > 1
  // For the aggregate label, derive a unique source list — if every
  // event is from the same portal, surface that; otherwise say "portals".
  const distinctSources = isAggregate
    ? Array.from(new Set(batch
        .map((e) => (e.payload_json as Record<string, unknown> | null)?.source)
        .filter((s): s is string => typeof s === 'string')))
    : [latestSource]
  const sourceLabel = distinctSources.length === 1 ? distinctSources[0] : 'portals'

  let body: React.ReactNode
  if (isAggregate) {
    // Batch is capped at 100 in the page-level state; show "100+" rather
    // than imply we counted exactly 100 during a flood.
    const countLabel = batch.length >= 100 ? '100+' : String(batch.length)
    body = (
      <>
        <strong style={{ fontWeight: 600 }}>{countLabel} new events</strong>
        {' from '}
        {sourceLabel}
      </>
    )
  } else {
    const company = typeof latestPayload.company === 'string' ? latestPayload.company : ''
    const role = typeof latestPayload.role === 'string' ? latestPayload.role : ''
    const summary = [company, role].filter(Boolean).join(' · ') || 'New event'
    body = (
      <>
        <strong style={{ fontWeight: 600 }}>Live · {latestSource}</strong>
        {' — '}
        {summary} ({latest.type})
      </>
    )
  }

  return (
    // role="status" + aria-live="polite" preserved from the original
    // single-event banner. Polite means the screen reader waits for the
    // user to finish current speech rather than interrupting — right
    // call for a non-emergency notification, even on aggregate flows
    // where multiple announcements would otherwise pile up.
    <div
      role="status"
      aria-live="polite"
      style={{
        marginBottom: 14,
        padding: '10px 14px',
        background: 'oklch(0.96 0.06 155)',
        border: '0.5px solid oklch(0.82 0.10 155)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 12.5,
        color: 'oklch(0.35 0.13 155)',
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: 'oklch(0.62 0.18 155)',
        boxShadow: '0 0 0 3px oklch(0.62 0.18 155 / 0.2)',
      }} />
      <span style={{ flex: 1 }}>{body}</span>
      {isAggregate && (
        <button
          type="button"
          onClick={onViewAll}
          className="link"
          style={{ fontSize: 11, color: 'inherit', fontWeight: 600 }}
        >
          View all →
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="link"
        aria-label="Dismiss"
        style={{ fontSize: 11, color: 'inherit' }}
      >
        Dismiss
      </button>
    </div>
  )
}

function ExtCard({
  label, value, sub, dot, warn,
}: { label: string; value: React.ReactNode; sub: string; dot?: string; warn?: boolean }) {
  return (
    <div
      style={{
        background: warn ? 'oklch(0.97 0.03 30)' : 'var(--surface)',
        border: `0.5px solid ${warn ? 'oklch(0.88 0.06 30)' : 'var(--border)'}`,
        borderRadius: 8, padding: '10px 12px',
      }}
    >
      <div style={{
        fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: 4, fontWeight: 600,
      }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, alignSelf: 'center' }} />}
        <span style={{
          fontSize: 18, fontWeight: 600,
          color: warn ? 'oklch(0.45 0.15 30)' : 'var(--fg)',
          fontFamily: 'var(--font-display)', letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
        }}>{value}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3 }}>{sub}</div>
    </div>
  )
}

function OverviewTab({
  connections, events, companyById, connById, appById,
}: {
  connections: DbPortalConnection[]
  events: DbPortalEvent[]
  companyById: Map<string, CompanyShape>
  connById: Map<string, DbPortalConnection>
  appById: Map<string, { id: string; role?: string; companyId?: string }>
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12, minWidth: 0 }}>
      {/* Left — How it works */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 16, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 14 }}>How auto-sync works</div>
        {[
          { n: 1, title: 'Extension reads your existing session', body: 'Already logged into Greenhouse, Workday, BOSS? Landed piggybacks on those tabs — no separate sign-in.' },
          { n: 2, title: 'Background scrape every 6 hours', body: "A service worker visits each portal silently, parses the status of every role you've applied to, diffs against last snapshot." },
          { n: 3, title: 'Changes appear in Landed instantly', body: 'Stage transitions, new interview emails, rejections — surfaced in the activity feed with desktop notification.' },
          { n: 4, title: 'Cookie expired? Landed tells you immediately', body: 'No silent failures. If a portal logs you out, you get a notification with a 1-click re-auth link.' },
        ].map((s) => (
          <div key={s.n} style={{
            display: 'flex', gap: 12, padding: '10px 0',
            borderTop: s.n === 1 ? 'none' : '0.5px solid var(--border-subtle)',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 11, background: 'var(--fg)', color: 'var(--bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 600, flexShrink: 0, fontFamily: 'var(--font-display)',
            }}>{s.n}</div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{s.body}</div>
            </div>
          </div>
        ))}
        <div style={{
          marginTop: 12, padding: 10, background: 'var(--surface-2)',
          border: '0.5px solid var(--border)', borderRadius: 6,
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="check" size={12} /></span>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>Everything stays local.</strong>
            {' '}No portal cookies leave your browser. Status data stays in this browser unless you turn on Landed Cloud.
          </div>
        </div>
      </div>

      {/* Right — recent activity preview */}
      <div style={{
        background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10,
        padding: 14, display: 'flex', flexDirection: 'column', minHeight: 320, minWidth: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Recent</span>
          <span style={{
            marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 3,
              background: connections.length ? 'oklch(0.65 0.17 155)' : 'oklch(0.7 0.02 240)',
              animation: connections.length ? 'pulse 2s ease-in-out infinite' : 'none',
            }} />
            {connections.length ? 'Live' : 'Idle'}
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {events.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '24px 0', textAlign: 'center' }}>
              Activity feed is empty.
            </div>
          ) : (
            events.slice(0, 6).map((e) => (
              <ActivityRow
                key={e.id}
                event={e}
                connection={e.connection_id ? connById.get(e.connection_id) ?? null : null}
                companyById={companyById}
                appById={appById}
                compact
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ConnectionsTab({
  connections, companyById, loading,
}: {
  connections: DbPortalConnection[]
  companyById: Map<string, CompanyShape>
  loading: boolean
}) {
  if (loading) {
    return <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '24px 0' }}>Loading…</div>
  }
  if (connections.length === 0) {
    return (
      <div style={{
        background: 'var(--surface)', border: '0.5px dashed var(--border)', borderRadius: 10,
        padding: 24, textAlign: 'center', color: 'var(--fg-muted)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
          No portal connections yet
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, maxWidth: 480, margin: '0 auto' }}>
          The browser extension (Sprint 4) will create a connection row for each portal you're logged
          into. Until then, this table is empty. Use the dev seed above to preview the UI with sample data.
        </div>
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <div style={{
          display: 'flex', borderBottom: '0.5px solid var(--border)',
          background: 'var(--surface-2)', minWidth: 880,
        }}>
          {[
            { w: 240, l: 'Portal' },
            { w: 130, l: 'Provider' },
            { w: 110, l: 'Status' },
            { w: 160, l: 'Last sync' },
            { w: 1,   l: '' },
          ].map((c, i) => (
            <div key={i} style={{
              width: c.w === 1 ? 'auto' : c.w, flex: c.w === 1 ? 1 : 'none',
              padding: '9px 12px', fontSize: 10.5, fontWeight: 500,
              color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
              whiteSpace: 'nowrap',
            }}>{c.l}</div>
          ))}
        </div>
        {connections.map((c, i) => {
          const company = companyById.get(c.company_id)
          return (
            <div
              key={c.id}
              className="table-row"
              style={{
                display: 'flex', alignItems: 'center',
                borderBottom: i === connections.length - 1 ? 'none' : '0.5px solid var(--border-subtle)',
                minWidth: 880,
              }}
            >
              <div style={{ width: 240, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0 }}>
                {company ? <CompanyMark company={company} size={26} /> : <div style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--surface-2)' }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {company?.name ?? <span style={{ color: 'var(--fg-muted)', fontStyle: 'italic' }}>Unknown company</span>}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.portal_host ?? `${c.provider}.com`}
                  </div>
                </div>
              </div>
              <div style={{ width: 130, padding: '10px 12px', fontSize: 11.5, color: 'var(--fg-muted)', flexShrink: 0 }}>
                <span style={{
                  background: 'var(--surface-2)', border: '0.5px solid var(--border)',
                  padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap',
                }}>{PROVIDER_LABEL[c.provider]}</span>
              </div>
              <div style={{ width: 110, padding: '10px 12px', flexShrink: 0 }}>
                <StatusPill status={c.status} />
              </div>
              <div style={{ width: 160, padding: '10px 12px', fontSize: 11.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {c.last_sync_at ? formatRelative(c.last_sync_at) : '—'}
              </div>
              <div style={{ flex: 1, padding: '10px 12px', display: 'flex', justifyContent: 'flex-end', gap: 4, flexShrink: 0 }}>
                {c.status === 'expired' || c.status === 'disconnected' ? (
                  <button
                    className="btn-primary"
                    style={{ fontSize: 11, padding: '4px 9px', whiteSpace: 'nowrap' }}
                    disabled
                    title="Available in Sprint 4 once the extension lands"
                  >
                    <Icon name="refresh" size={11} /> Re-auth
                  </button>
                ) : (
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 11, padding: '4px 9px', whiteSpace: 'nowrap' }}
                    disabled
                    title="Available in Sprint 4 once the extension lands"
                  >
                    <Icon name="refresh" size={11} /> Sync
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ padding: 12, borderTop: '0.5px solid var(--border)', background: 'var(--surface-2)' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Connections are created by the extension when it detects you're logged into a portal. Manual creation lands in Sprint 4.
        </span>
      </div>
    </div>
  )
}

function ActivityTab({
  events, companyById, connById, appById, loading,
}: {
  events: DbPortalEvent[]
  companyById: Map<string, CompanyShape>
  connById: Map<string, DbPortalConnection>
  appById: Map<string, { id: string; role?: string; companyId?: string }>
  loading: boolean
}) {
  if (loading) {
    return <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '24px 0' }}>Loading…</div>
  }
  if (events.length === 0) {
    return (
      <div style={{
        background: 'var(--surface)', border: '0.5px dashed var(--border)', borderRadius: 10,
        padding: 24, textAlign: 'center', color: 'var(--fg-muted)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
          Activity feed is empty
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, maxWidth: 480, margin: '0 auto' }}>
          Portal events (stage changes, expired logins, sync runs) will land here once the extension is installed.
        </div>
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 6 }}>
      {events.map((e) => (
        <ActivityRow
          key={e.id}
          event={e}
          connection={e.connection_id ? connById.get(e.connection_id) ?? null : null}
          companyById={companyById}
          appById={appById}
        />
      ))}
    </div>
  )
}

function StatusPill({ status }: { status: PortalStatus }) {
  const meta: Record<PortalStatus, { fg: string; dot: string; animate?: boolean }> = {
    active:       { fg: 'oklch(0.45 0.13 155)', dot: 'oklch(0.65 0.17 155)' },
    syncing:      { fg: 'oklch(0.45 0.13 240)', dot: 'oklch(0.65 0.17 240)', animate: true },
    expired:      { fg: 'oklch(0.5 0.16 30)',   dot: 'oklch(0.65 0.17 30)' },
    disconnected: { fg: 'oklch(0.5 0.04 240)',  dot: 'oklch(0.65 0.04 240)' },
  }
  const m = meta[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: m.fg, whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 3, background: m.dot,
        animation: m.animate ? 'pulse 1.2s ease-in-out infinite' : 'none',
      }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function ActivityRow({
  event, connection, companyById, appById, compact,
}: {
  event: DbPortalEvent
  connection: DbPortalConnection | null
  companyById: Map<string, CompanyShape>
  appById: Map<string, { id: string; role?: string; companyId?: string }>
  compact?: boolean
}) {
  const meta = EVENT_ICON[event.type]
  const text = EVENT_TEXT[event.type]

  // Try to attribute the event to a company via: explicit application_id →
  // connection_id → none.
  let companyId: string | null = null
  if (event.application_id) {
    const app = appById.get(event.application_id)
    companyId = app?.companyId ?? null
  }
  if (!companyId && connection?.company_id) companyId = connection.company_id
  const company = companyId ? companyById.get(companyId) ?? null : null

  const payload = (event.payload_json ?? {}) as Record<string, unknown>
  const from = typeof payload.from === 'string' ? payload.from : null
  const to = typeof payload.to === 'string' ? payload.to : null
  const detail = typeof payload.detail === 'string' ? payload.detail : null

  return (
    <div
      className="role-row"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: compact ? '7px 8px' : '10px 12px',
        borderRadius: 6, cursor: 'default',
      }}
    >
      <div style={{
        width: 26, height: 26, borderRadius: 6,
        background: 'var(--surface-2)', border: '0.5px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: meta.color, flexShrink: 0,
      }}>
        <Icon name={meta.icon} size={13} stroke={2} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {company && (
            <>
              <CompanyMark company={company} size={14} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, maxWidth: '45%' }}>
                {company.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>·</span>
            </>
          )}
          <span style={{ fontSize: 12, color: 'var(--fg)', flexShrink: 0 }}>{text}</span>
          {from && to && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span style={{ padding: '0px 5px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{from}</span>
              <Icon name="arrowRight" size={10} />
              <span style={{ padding: '0px 5px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{to}</span>
            </span>
          )}
        </div>
        {!compact && detail && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', paddingTop: 4 }}>
        {formatRelative(event.created_at)}
      </div>
    </div>
  )
}
