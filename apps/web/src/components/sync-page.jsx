// Sync page — Connections grid + Activity feed + onboarding state
import React, { useState } from 'react';
import { CompanyMark, Icon, stageColors } from './primitives';
import { PageHeader } from './shell';
import { COMPANIES, PORTAL_STATUS } from '../data';

export const SyncPage = () => {
  const [tab, setTab] = useState('overview'); // 'overview' | 'connections' | 'activity'

  const connections = COMPANIES.slice(0, 16).map((c, i) => {
    const p = PORTAL_STATUS[c.id];
    return {
      company: c,
      // Generate plausible portal info if not in PORTAL_STATUS
      status: p?.ok === false ? 'expired' : p?.ok === true ? 'active' : (i % 7 === 3 ? 'syncing' : 'active'),
      lastSync: p?.lastSync || ['Apr 19, 09:12', 'Apr 19, 08:40', 'Apr 19, 10:01', 'Apr 18, 22:30'][i % 4],
      portal: ['Greenhouse', 'Lever', 'Workday', 'Ashby', 'BambooHR', 'BOSS Zhipin', 'Workday', 'Greenhouse', 'Lever'][i % 9],
      tracked: 1 + (i % 3),
      reason: p?.reason,
    };
  });

  const activity = [
    { id: 1, type: 'status-change', t: '2 min ago',  company: COMPANIES[0], text: 'Stage changed', from: 'Phone Screen', to: 'Onsite',  detail: 'Recruiter scheduled final round for Apr 23' },
    { id: 2, type: 'status-change', t: '14 min ago', company: COMPANIES[4], text: 'Stage changed', from: 'Applied',     to: 'Phone',   detail: 'Auto-detected from Greenhouse portal' },
    { id: 3, type: 'expired',       t: '32 min ago', company: COMPANIES[2], text: 'Login expired',  detail: 'Re-authenticate to resume tracking' },
    { id: 4, type: 'new-event',     t: '1 hour ago',  company: COMPANIES[7], text: 'New event',     detail: 'Interview Apr 24 confirmed via email' },
    { id: 5, type: 'status-change', t: '3 hours ago', company: COMPANIES[19], text: 'Stage changed', from: 'OA',          to: 'Phone',   detail: 'Passed online assessment with 92%' },
    { id: 6, type: 'sync',          t: '6 hours ago', company: null,           text: 'Auto-sync complete', detail: 'Scanned 16 portals · 2 changes detected · 1 needs attention' },
    { id: 7, type: 'expired',       t: 'Yesterday',  company: COMPANIES[8], text: 'Login expired',  detail: 'Session cookie no longer valid' },
    { id: 8, type: 'rejection',     t: 'Yesterday',  company: COMPANIES[2], text: 'Rejection received', detail: '"After careful consideration..." auto-classified as rejection' },
    { id: 9, type: 'status-change', t: '2 days ago', company: COMPANIES[29], text: 'Stage changed', from: 'Applied', to: 'OA',      detail: 'Take-home test issued · due Apr 23' },
    { id: 10, type: 'sync',         t: '2 days ago', company: null, text: 'Auto-sync complete', detail: 'Scanned 16 portals · 3 changes detected' },
  ];

  const statusCounts = {
    active:  connections.filter(c => c.status === 'active').length,
    syncing: connections.filter(c => c.status === 'syncing').length,
    expired: connections.filter(c => c.status === 'expired').length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Sync"
        subtitle={`Browser extension watching ${connections.length} portals · last sync 2 min ago`}
        actions={
          <button className="btn-secondary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            <Icon name="external" size={13} /> Extension v0.4.2
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 24px' }}>
        {/* Top status strip — extension health */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
          <ExtCard
            label="Extension"
            value="Running"
            sub="Chrome · Connected"
            dot="oklch(0.65 0.17 155)"
          />
          <ExtCard
            label="Portals watched"
            value={connections.length}
            sub={`${statusCounts.active} active · ${statusCounts.syncing} syncing`}
          />
          <ExtCard
            label="Needs attention"
            value={statusCounts.expired}
            sub="expired sessions"
            warn={statusCounts.expired > 0}
          />
          <ExtCard
            label="Last sync"
            value="2 min ago"
            sub="Auto every 6 hours"
          />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, background: 'var(--surface-2)', padding: 3, borderRadius: 7, width: 'fit-content', marginBottom: 12, border: '0.5px solid var(--border)' }}>
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'connections', label: `Connections (${connections.length})` },
            { id: 'activity', label: 'Activity feed' },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '5px 12px', fontSize: 12, fontWeight: 500,
              background: tab === t.id ? 'var(--surface)' : 'transparent',
              color: tab === t.id ? 'var(--fg)' : 'var(--fg-muted)',
              border: 'none', borderRadius: 5, cursor: 'pointer',
              boxShadow: tab === t.id ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
              whiteSpace: 'nowrap',
            }}>{t.label}</button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab connections={connections} activity={activity} />}
        {tab === 'connections' && <ConnectionsTab connections={connections} />}
        {tab === 'activity' && <ActivityTab activity={activity} />}
      </div>
    </div>
  );
};

const ExtCard = ({ label, value, sub, dot, warn }) => (
  <div style={{
    background: warn ? 'oklch(0.97 0.03 30)' : 'var(--surface)',
    border: `0.5px solid ${warn ? 'oklch(0.88 0.06 30)' : 'var(--border)'}`,
    borderRadius: 8, padding: '10px 12px',
  }}>
    <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 600 }}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      {dot && <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, alignSelf: 'center' }} />}
      <span style={{ fontSize: 18, fontWeight: 600, color: warn ? 'oklch(0.45 0.15 30)' : 'var(--fg)', fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</span>
    </div>
    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3 }}>{sub}</div>
  </div>
);

const OverviewTab = ({ connections, activity }) => {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12, minWidth: 0 }}>
      {/* Left — How it works */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 16, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 14 }}>How auto-sync works</div>
        {[
          { n: 1, title: 'Extension reads your existing session', body: 'Already logged into Greenhouse, Workday, BOSS? We piggyback on those tabs — no separate sign-in.' },
          { n: 2, title: 'Background scrape every 6 hours', body: 'A service worker visits each portal silently, parses the status of every role you\'ve applied to, diffs against last snapshot.' },
          { n: 3, title: 'Changes appear in Landed instantly', body: 'Stage transitions, new interview emails, rejections — surfaced in the activity feed with desktop notification.' },
          { n: 4, title: 'Cookie expired? We tell you immediately', body: 'No silent failures. If a portal logs you out, you get a notification with a 1-click re-auth link.' },
        ].map(s => (
          <div key={s.n} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: s.n === 1 ? 'none' : '0.5px solid var(--border-subtle)' }}>
            <div style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--fg)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0, fontFamily: 'var(--font-display)' }}>{s.n}</div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{s.body}</div>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 12, padding: 10, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="check" size={12} /></span>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>Everything stays local.</strong> No portal cookies leave your browser. Status data syncs through your Landed account only.
          </div>
        </div>
      </div>

      {/* Right — recent activity preview */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', minHeight: 320, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Recent</span>
          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.65 0.17 155)', animation: 'pulse 2s ease-in-out infinite' }} />
            Live
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {activity.slice(0, 6).map(e => <ActivityRow key={e.id} event={e} compact />)}
        </div>
      </div>
    </div>
  );
};

const ConnectionsTab = ({ connections }) => {
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)', minWidth: 880 }}>
        {[
          { w: 220, l: 'Portal' },
          { w: 110, l: 'Provider' },
          { w: 100, l: 'Status' },
          { w: 60,  l: 'Roles' },
          { w: 140, l: 'Last sync' },
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
      {connections.map((c, i) => (
        <div key={c.company.id} style={{ display: 'flex', alignItems: 'center', borderBottom: i === connections.length - 1 ? 'none' : '0.5px solid var(--border-subtle)', minWidth: 880 }} className="table-row">
          <div style={{ width: 220, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0 }}>
            <CompanyMark company={c.company} size={26} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.company.name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.company.id}.{c.portal.toLowerCase().replace(' ', '')}.com</div>
            </div>
          </div>
          <div style={{ width: 110, padding: '10px 12px', fontSize: 11.5, color: 'var(--fg-muted)', flexShrink: 0 }}>
            <span style={{ background: 'var(--surface-2)', border: '0.5px solid var(--border)', padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>{c.portal}</span>
          </div>
          <div style={{ width: 100, padding: '10px 12px', flexShrink: 0 }}>
            {c.status === 'active' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'oklch(0.45 0.13 155)', whiteSpace: 'nowrap' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.65 0.17 155)' }} /> Active
              </span>
            )}
            {c.status === 'syncing' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'oklch(0.45 0.13 240)', whiteSpace: 'nowrap' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.65 0.17 240)', animation: 'pulse 1.2s ease-in-out infinite' }} /> Syncing
              </span>
            )}
            {c.status === 'expired' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'oklch(0.5 0.16 30)', whiteSpace: 'nowrap' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.65 0.17 30)' }} /> Expired
              </span>
            )}
          </div>
          <div style={{ width: 60, padding: '10px 12px', fontSize: 11.5, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{c.tracked}</div>
          <div style={{ width: 140, padding: '10px 12px', fontSize: 11.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', flexShrink: 0 }}>{c.lastSync}</div>
          <div style={{ flex: 1, padding: '10px 12px', display: 'flex', justifyContent: 'flex-end', gap: 4, flexShrink: 0 }}>
            {c.status === 'expired' ? (
              <button className="btn-primary" style={{ fontSize: 11, padding: '4px 9px', whiteSpace: 'nowrap' }}>
                <Icon name="refresh" size={11} /> Re-auth
              </button>
            ) : (
              <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 9px', whiteSpace: 'nowrap' }}>
                <Icon name="refresh" size={11} /> Sync
              </button>
            )}
            <button className="btn-secondary icon-only" style={{ padding: 4 }}><Icon name="dots" size={13} /></button>
          </div>
        </div>
      ))}
      </div>
      <div style={{ padding: 12, borderTop: '0.5px solid var(--border)', background: 'var(--surface-2)' }}>
        <button className="btn-secondary" style={{ fontSize: 11.5 }}>
          <Icon name="plus" size={12} stroke={2} /> Connect new portal
        </button>
        <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--fg-muted)' }}>
          Visit any career page logged in — extension will offer to track it.
        </span>
      </div>
    </div>
  );
};

const ActivityTab = ({ activity }) => {
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 6 }}>
      {activity.map(e => <ActivityRow key={e.id} event={e} />)}
    </div>
  );
};

const ActivityRow = ({ event, compact }) => {
  const iconMap = {
    'status-change': { icon: 'arrowRight', color: 'oklch(0.55 0.13 240)' },
    'expired':       { icon: 'alert',      color: 'oklch(0.55 0.16 30)' },
    'new-event':     { icon: 'calendar',   color: 'oklch(0.50 0.13 270)' },
    'sync':          { icon: 'refresh',    color: 'oklch(0.55 0.04 240)' },
    'rejection':     { icon: 'x',          color: 'oklch(0.55 0.14 25)' },
  };
  const meta = iconMap[event.type] || iconMap['status-change'];

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: compact ? '7px 8px' : '10px 12px',
      borderRadius: 6, cursor: 'pointer',
    }} className="role-row">
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
          {event.company && (
            <>
              <CompanyMark company={event.company} size={14} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, maxWidth: '45%' }}>{event.company.name}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>·</span>
            </>
          )}
          <span style={{ fontSize: 12, color: 'var(--fg)', flexShrink: 0 }}>{event.text}</span>
          {event.from && event.to && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span style={{ padding: '0px 5px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{event.from}</span>
              <Icon name="arrowRight" size={10} />
              <span style={{ padding: '0px 5px', background: stageColors[event.to.toLowerCase() === 'phone' ? 'phone' : event.to.toLowerCase() === 'onsite' ? 'onsite' : event.to.toLowerCase() === 'oa' ? 'oa' : 'applied'].bg, color: stageColors[event.to.toLowerCase() === 'phone' ? 'phone' : event.to.toLowerCase() === 'onsite' ? 'onsite' : event.to.toLowerCase() === 'oa' ? 'oa' : 'applied'].fg, border: `0.5px solid ${stageColors[event.to.toLowerCase() === 'phone' ? 'phone' : event.to.toLowerCase() === 'onsite' ? 'onsite' : event.to.toLowerCase() === 'oa' ? 'oa' : 'applied'].ring}`, borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{event.to}</span>
            </span>
          )}
        </div>
        {!compact && event.detail && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.detail}</div>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', paddingTop: 4 }}>{event.t}</div>
    </div>
  );
};

