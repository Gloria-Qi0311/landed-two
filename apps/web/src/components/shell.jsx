// Sidebar + stats banner + Resume Match page + JD Breakdown page
import React, { useMemo } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { LandedMark, Icon, stageColors } from './primitives';
import { STAGES, PORTAL_STATUS } from '../data';
import { AccountAvatar } from './auth';

export const Sidebar = ({ apps, account, onProfileClick }) => {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('filter') || 'all';
  const setFilter = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'all') next.delete('filter');
    else next.set('filter', id);
    setSearchParams(next, { replace: true });
  };

  const counts = useMemo(() => {
    const c = { all: apps.length, active: 0, starred: 0 };
    STAGES.forEach(s => c[s.id] = 0);
    apps.forEach(a => {
      c[a.stage]++;
      if (a.starred) c.starred++;
      if (!['rejected', 'ghosted'].includes(a.stage)) c.active++;
    });
    return c;
  }, [apps]);

  const needsAuth = Object.values(PORTAL_STATUS).filter(p => !p.ok).length;

  const Item = ({ id, icon, label, count, badge }) => (
    <button onClick={() => setFilter(id)} className="sidebar-item" style={{
      width: '100%', textAlign: 'left',
      padding: '6px 10px', fontSize: 12.5,
      background: filter === id ? 'var(--surface-3)' : 'transparent',
      color: filter === id ? 'var(--fg)' : 'var(--fg-muted)',
      border: 'none', borderRadius: 6,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
      fontWeight: filter === id ? 500 : 400,
    }}>
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge}
      {count !== undefined && <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </button>
  );

  const NavItem = ({ to, icon, label }) => (
    <NavLink to={to} end={to === '/applications'} className="sidebar-item" style={({ isActive }) => ({
      width: '100%', textAlign: 'left', textDecoration: 'none',
      padding: '7px 10px', fontSize: 13,
      background: isActive ? 'var(--surface-3)' : 'transparent',
      color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
      border: 'none', borderRadius: 6,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9,
      fontWeight: isActive ? 500 : 400,
    })}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );

  return (
    <aside style={{
      width: 232, flexShrink: 0,
      background: 'var(--surface-2)',
      borderRight: '0.5px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
    }}>
      {/* Brand */}
      <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <LandedMark size={22} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>Landed</div>
        </div>
        <button className="icon-btn" style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', position: 'relative' }}>
          <Icon name="bell" size={14} />
          {needsAuth > 0 && (
            <span style={{ position: 'absolute', top: 2, right: 2, width: 7, height: 7, background: 'oklch(0.65 0.18 30)', borderRadius: 4, border: '1.5px solid var(--surface-2)' }} />
          )}
        </button>
      </div>

      {/* Nav */}
      <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
        <NavItem to="/applications" icon={<Icon name="inbox" size={14} />} label="Applications" />
        <NavItem to="/sync" icon={<Icon name="refresh" size={14} />} label="Sync" />
        <NavItem to="/resume-match" icon={<Icon name="sparkle" size={14} />} label="Resume Match" />
        <NavItem to="/jd-breakdown" icon={<Icon name="target" size={14} />} label="JD Breakdown" />
        <NavItem to="/agents" icon={<Icon name="wand" size={14} />} label="Agents" />
      </div>

      {/* Design-only references — easy access for reviewer */}
      <div style={{ padding: '8px 10px 0', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
        <a href="how-it-works.html" target="_blank" rel="noopener" style={{
          textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 9,
          padding: '6px 10px', fontSize: 12, color: 'var(--fg-muted)',
          borderRadius: 6,
        }} className="sidebar-item">
          <Icon name="external" size={13} />
          <span style={{ flex: 1 }}>How it works</span>
        </a>
        <a href="design-system.html" target="_blank" rel="noopener" style={{
          textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 9,
          padding: '6px 10px', fontSize: 12, color: 'var(--fg-muted)',
          borderRadius: 6,
        }} className="sidebar-item">
          <Icon name="adjust" size={13} />
          <span style={{ flex: 1 }}>Design system</span>
        </a>
      </div>

      {/* Scrollable filters region — keeps the bottom strip always visible */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {location.pathname === '/applications' && (
          <>
            <div style={{ padding: '14px 16px 4px', fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Views</div>
            <div style={{ padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Item id="all" icon={<Icon name="inbox" size={13} />} label="All applications" count={counts.all} />
              <Item id="active" icon={<div style={{ width: 7, height: 7, borderRadius: 4, background: 'oklch(0.65 0.17 155)' }} />} label="Active" count={counts.active} />
              <Item id="starred" icon={<Icon name="star" size={13} />} label="Starred" count={counts.starred} />
            </div>

            <div style={{ padding: '14px 16px 4px', fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pipeline</div>
            <div style={{ padding: '2px 10px 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {STAGES.map(s => (
                <Item key={s.id} id={s.id}
                  icon={<span style={{ width: 7, height: 7, borderRadius: 4, background: stageColors[s.id].dot }} />}
                  label={s.label} count={counts[s.id]} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Portal status strip — always visible at the bottom */}
      <div style={{ padding: 10, borderTop: '0.5px solid var(--border)', flexShrink: 0 }}>
        <div style={{
          padding: 10, borderRadius: 7,
          background: needsAuth > 0 ? 'oklch(0.97 0.03 30)' : 'var(--surface)',
          border: `0.5px solid ${needsAuth > 0 ? 'oklch(0.88 0.06 30)' : 'var(--border)'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
            <span style={{ flexShrink: 0, color: needsAuth > 0 ? 'oklch(0.55 0.16 30)' : 'oklch(0.50 0.13 155)', display: 'flex', marginTop: 1 }}>
              <Icon name={needsAuth > 0 ? 'alert' : 'check'} size={12} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: needsAuth > 0 ? 'oklch(0.45 0.15 30)' : 'var(--fg)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>
              {needsAuth > 0 ? `${needsAuth} expired sessions` : 'All portals synced'}
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
            {needsAuth > 0 ? 'Expired cookies detected. Click to sign back in.' : 'Last checked just now via extension'}
          </div>
        </div>
      </div>

      <div style={{ padding: '8px 14px 12px', display: 'flex', alignItems: 'center', gap: 8, borderTop: '0.5px solid var(--border)', flexShrink: 0, position: 'relative' }}>
        <button onClick={onProfileClick} data-profile-trigger
          style={{
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
            fontFamily: 'inherit', textAlign: 'left',
          }}>
          <AccountAvatar account={account} size={24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {account.email}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
              {account.mode === 'cloud' ? 'Landed Cloud' : 'On this device'}
            </div>
          </div>
          <Icon name="chevronRight" size={12} stroke={2} />
        </button>
      </div>
    </aside>
  );
};
export const StatsBanner = ({ apps }) => {
  const stats = useMemo(() => {
    const active = apps.filter(a => !['rejected', 'ghosted', 'saved'].includes(a.stage)).length;
    const interviewing = apps.filter(a => ['phone', 'onsite'].includes(a.stage)).length;
    const offers = apps.filter(a => a.stage === 'offer').length;
    // Response rate: of apps the user has actually applied to (not just saved),
    // how many got SOME kind of response (moved beyond 'applied' — into oa / phone /
    // onsite / offer / rejected / ghosted). Saved roles aren't part of the denominator.
    const appliedAt = apps.filter(a => a.stage !== 'saved');
    const responded = apps.filter(a => !['saved', 'applied'].includes(a.stage));
    const responseRate = Math.round((responded.length / Math.max(1, appliedAt.length)) * 100);
    // Apps with an actionable next step (not empty / '—' / 'Awaiting response' boilerplate)
    // and not in a terminal stage. Honest proxy for "things on your plate."
    const idleNextSteps = new Set(['', '—', 'Awaiting response']);
    const nextSteps = apps.filter(a =>
      !['rejected', 'ghosted'].includes(a.stage) &&
      a.nextStep && !idleNextSteps.has(a.nextStep)
    ).length;
    return { active, interviewing, offers, responseRate, nextSteps };
  }, [apps]);

  const Stat = ({ label, value, sub, accent }) => (
    <div style={{ flex: 1, padding: '0 18px', borderLeft: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: accent || 'var(--fg)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>{value}</span>
        {sub && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{sub}</span>}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', padding: '10px 28px 12px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ paddingLeft: 0, paddingRight: 18, flex: 1 }}>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>In flight</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
          {stats.active} <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 400 }}>active applications</span>
        </div>
      </div>
      <Stat label="Interviewing" value={stats.interviewing} sub="phone + onsite" />
      <Stat label="Offers" value={stats.offers} sub="awaiting decision" accent="oklch(0.45 0.14 155)" />
      <Stat label="Response rate" value={`${stats.responseRate}%`} sub="of applied" />
      <Stat label="Next steps" value={stats.nextSteps} sub="actionable" />
    </div>
  );
};
// Unified page header — used on every top-level page so the design language stays consistent.
export const PageHeader = ({ title, subtitle, actions }) => (
  <div style={{
    padding: '12px 28px 10px',
    display: 'flex', alignItems: 'center', gap: 10,
    borderBottom: '0.5px solid var(--border)', background: 'var(--bg)',
    flexShrink: 0,
  }}>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 1 }}>
          {subtitle}
        </div>
      )}
    </div>
    {actions && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{actions}</div>}
  </div>
);
// Section title pattern used inside cards / forms — keep consistent everywhere.
export const SectionLabel = ({ children, style }) => (
  <div style={{
    fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    marginBottom: 8, ...style,
  }}>{children}</div>
);
