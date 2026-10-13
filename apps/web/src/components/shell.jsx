// Sidebar + page header
import React from 'react';
import { NavLink } from 'react-router-dom';
import { LandedMark, Icon } from './primitives';
import { PORTAL_STATUS } from '../data';
import { AccountAvatar } from './auth';

export const Sidebar = ({ account, onProfileClick, navCounts = {} }) => {
  const needsAuth = Object.values(PORTAL_STATUS).filter(p => !p.ok).length;

  const NavItem = ({ to, icon, label, count }) => (
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
      {count > 0 && (
        <span style={{
          marginLeft: 'auto', minWidth: 18, padding: '0 5px', borderRadius: 9, fontSize: 10.5, fontWeight: 600,
          lineHeight: '17px', textAlign: 'center', background: 'var(--accent)', color: 'var(--bg)',
        }}>{count}</span>
      )}
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
      </div>

      {/* Nav */}
      <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
        <NavItem to="/applications" icon={<Icon name="inbox" size={14} />} label="Applications" count={navCounts.applications} />
        <NavItem to="/agent" icon={<Icon name="sparkle" size={14} />} label="Agent" count={navCounts.agent} />
        <NavItem to="/automation" icon={<Icon name="calendar" size={14} />} label="Automation" />
        <NavItem to="/resumes" icon={<Icon name="doc" size={14} />} label="My Resume" />
      </div>

      <div style={{ flex: 1 }} />

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
// Unified page header — used on every top-level page so the design language stays consistent.
/**
 * @param {{ title: import('react').ReactNode, subtitle?: import('react').ReactNode, actions?: import('react').ReactNode }} props
 */
export const PageHeader = ({ title, subtitle, actions }) => (
  <div style={{
    padding: '12px 28px 10px',
    display: 'flex', alignItems: 'center', gap: 10, rowGap: 8, flexWrap: 'wrap',
    borderBottom: '0.5px solid var(--border)', background: 'var(--bg)',
    flexShrink: 0,
  }}>
    <div style={{ minWidth: 0, flex: '1 1 160px' }}>
      <div style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
