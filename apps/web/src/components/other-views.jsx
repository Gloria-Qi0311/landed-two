// Timeline + Cards + Map views
import React, { useMemo } from 'react';
import { CompanyMark, StageBadge, PortalDot, Icon, stageColors } from './primitives';
import { PORTAL_STATUS } from '../data';

export const TimelineView = ({ apps, companies, onOpen }) => {
  const getCompany = (id) => companies.find(c => c.id === id);
  // group by day bucket relative to today
  const active = apps.filter(a => a.stage !== 'rejected' && a.stage !== 'ghosted' && a.stage !== 'saved');
  const buckets = [
    { label: 'Today', min: 0, max: 0 },
    { label: 'This week', min: 1, max: 7 },
    { label: 'Last 2 weeks', min: 8, max: 14 },
    { label: 'This month', min: 15, max: 30 },
    { label: 'Earlier', min: 31, max: 999 },
  ];

  return (
    <div style={{ padding: '8px 28px 24px', overflowY: 'auto', height: '100%' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 95, top: 20, bottom: 20, width: 1, background: 'var(--border)' }} />
        {buckets.map((b, bi) => {
          const items = active.filter(a => a.lastActivity >= b.min && a.lastActivity <= b.max)
            .sort((x, y) => x.lastActivity - y.lastActivity);
          if (items.length === 0) return null;
          return (
            <div key={b.label} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', paddingLeft: 120, marginBottom: 8 }}>{b.label}</div>
              {items.map(a => {
                const c = getCompany(a.companyId);
                const col = stageColors[a.stage];
                return (
                  <div key={a.id} onClick={() => onOpen(a.id)} style={{ display: 'flex', alignItems: 'stretch', gap: 16, marginBottom: 6, cursor: 'pointer' }} className="timeline-row">
                    <div style={{ width: 80, textAlign: 'right', paddingTop: 14, fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {a.lastActivity === 0 ? 'today' : `${a.lastActivity}d ago`}
                    </div>
                    <div style={{ width: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, flexShrink: 0 }}>
                      <div style={{ width: 9, height: 9, borderRadius: 5, background: col.dot, boxShadow: `0 0 0 3px var(--bg)` }} />
                    </div>
                    <div style={{
                      flex: 1, background: 'var(--surface)', border: '0.5px solid var(--border)',
                      borderRadius: 8, padding: '10px 14px',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}>
                      <CompanyMark company={c} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, maxWidth: '40%' }}>{c.name}</span>
                          <span style={{ fontSize: 12, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>· {a.role}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.nextStep}</div>
                      </div>
                      <StageBadge stage={a.stage} />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
export const CardsView = ({ apps, companies, onOpen }) => {
  const byCompany = useMemo(() => {
    const map = {};
    apps.forEach(a => {
      if (!map[a.companyId]) map[a.companyId] = [];
      map[a.companyId].push(a);
    });
    return map;
  }, [apps]);

  const companyIds = Object.keys(byCompany).sort((a, b) => {
    const ca = companies.find(c => c.id === a), cb = companies.find(c => c.id === b);
    return ca.name.localeCompare(cb.name);
  });

  return (
    <div style={{ padding: '8px 28px 24px', overflowY: 'auto', height: '100%' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 12,
      }}>
        {companyIds.map(cid => {
          const c = companies.find(x => x.id === cid);
          const items = byCompany[cid];
          const portal = PORTAL_STATUS[cid];
          return (
            <div key={cid} style={{
              background: 'var(--surface)',
              border: '0.5px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CompanyMark company={c} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{c.sector} · {c.loc}</div>
                </div>
                <PortalDot companyId={c.id} />
              </div>
              {portal && !portal.ok && (
                <div style={{ fontSize: 10.5, color: 'oklch(0.45 0.15 30)', background: 'oklch(0.96 0.04 30)', padding: '5px 8px', borderRadius: 5, display: 'flex', alignItems: 'center', gap: 5, border: '0.5px solid oklch(0.88 0.06 30)' }}>
                  <Icon name="alert" size={11} /> {portal.reason} — re-auth to resync
                </div>
              )}
              <div style={{ borderTop: '0.5px dashed var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {items.map(a => (
                  <div key={a.id} onClick={() => onOpen(a.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', margin: '-2px -4px',
                    borderRadius: 6, cursor: 'pointer',
                  }} className="role-row">
                    <StageBadge stage={a.stage} />
                    <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.role}</div>
                    {a.starred && <Icon name="star" size={11} stroke={2} />}
                    <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{a.appliedDays === 0 ? 'draft' : `${a.appliedDays}d`}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
export const MapView = ({ apps, companies, onOpen }) => {
  // Group apps by city label. Use a schematic "map" not a real one — pill nodes laid out.
  const getCompany = (id) => companies.find(c => c.id === id);
  const byLoc = useMemo(() => {
    const map = {};
    apps.forEach(a => {
      const c = getCompany(a.companyId);
      const key = c.loc;
      if (!map[key]) map[key] = [];
      map[key].push({ app: a, company: c });
    });
    return map;
  }, [apps]);

  // Region groupings
  const regions = [
    { name: 'US — West', cities: ['Seattle, WA', 'San Francisco, CA', 'Mountain View, CA', 'Palo Alto, CA', 'Los Angeles, CA', 'Santa Monica, CA', 'Portland, OR', 'Denver, CO'] },
    { name: 'US — Central & South', cities: ['Chicago, IL', 'Austin, TX', 'Dallas, TX', 'Detroit, MI', 'Pittsburgh, PA'] },
    { name: 'US — East', cities: ['New York, NY', 'Brooklyn, NY', 'Boston, MA', 'Cambridge, MA', 'Arlington, VA', 'Long Beach, CA'] },
    { name: 'China', cities: ['Shanghai', 'Beijing', 'Shenzhen', 'Hangzhou', 'Suzhou'] },
    { name: 'Europe', cities: ['London, UK', 'Dublin, IE', 'Zurich, CH'] },
    { name: 'Remote & Other', cities: ['Remote', 'Montreal, QC'] },
  ];

  return (
    <div style={{ padding: '8px 28px 24px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        {regions.map(r => {
          const citiesWithData = r.cities.filter(city => byLoc[city]);
          if (citiesWithData.length === 0) return null;
          const totalApps = citiesWithData.reduce((sum, city) => sum + byLoc[city].length, 0);
          return (
            <div key={r.name} style={{
              background: 'var(--surface)',
              border: '0.5px solid var(--border)',
              borderRadius: 10,
              padding: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{r.name}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{totalApps} roles · {citiesWithData.length} cities</div>
              </div>
              {citiesWithData.map(city => (
                <div key={city} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
                    {city} <span style={{ color: 'var(--fg-muted)', opacity: 0.6 }}>· {byLoc[city].length}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {byLoc[city].map(({ app, company }) => {
                      const col = stageColors[app.stage];
                      return (
                        <button key={app.id} onClick={() => onOpen(app.id)} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          background: 'var(--surface-2)', border: '0.5px solid var(--border)',
                          borderRadius: 999, padding: '3px 10px 3px 4px',
                          cursor: 'pointer', font: 'inherit',
                        }} className="map-pill">
                          <CompanyMark company={company} size={18} />
                          <span style={{ fontSize: 11.5, color: 'var(--fg)', fontWeight: 500 }}>{company.name.split(' ')[0]}</span>
                          <span style={{ width: 6, height: 6, borderRadius: 3, background: col.dot }} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};
