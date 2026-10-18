// Sidebar + page header
import React, { type CSSProperties, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LandedMark, Icon } from './primitives';
import { AccountAvatar } from './auth';

/** The signed-in account as the shell shows it (App.tsx). */
export type ShellAccount = { mode: 'cloud' | 'local'; email: string };

type SidebarProps = {
  account: ShellAccount;
  onProfileClick: () => void;
  navCounts?: { applications?: number; agent?: number };
};

export const Sidebar = ({ account, onProfileClick, navCounts = {} }: SidebarProps) => {

  const NavItem = ({ to, icon, label, count = 0 }: { to: string; icon: ReactNode; label: string; count?: number }) => (
    <NavLink to={to} end={to === '/applications'} className={({ isActive }) => (isActive ? 'sidebar-item active' : 'sidebar-item')} style={({ isActive }) => ({
      width: '100%', textAlign: 'left', textDecoration: 'none',
      padding: '7px 10px', fontSize: 13,
      background: isActive ? 'var(--surface)' : 'transparent',
      boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
      color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
      border: 'none', borderRadius: 8,
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9,
      fontWeight: isActive ? 550 : 450,
    })}>
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span style={{
          marginLeft: 'auto', minWidth: 18, padding: '0 5px', borderRadius: 9, fontSize: 10.5, fontWeight: 600,
          lineHeight: '17px', textAlign: 'center', background: 'var(--accent)', color: 'white',
        }}>{count}</span>
      )}
    </NavLink>
  );

  return (
    <aside style={{
      width: 224, flexShrink: 0,
      background: 'var(--surface-2)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
    }}>
      {/* Brand */}
      <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <LandedMark size={22} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--fg)', letterSpacing: '-0.025em', fontFamily: 'var(--font-display)' }}>Landed</div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
        <NavItem to="/applications" icon={<Icon name="inbox" size={14} />} label="Applications" count={navCounts.applications} />
        <NavItem to="/agent" icon={<Icon name="sparkle" size={14} />} label="Agent" count={navCounts.agent} />
        <NavItem to="/automation" icon={<Icon name="calendar" size={14} />} label="Automation" />
        <NavItem to="/resumes" icon={<Icon name="doc" size={14} />} label="My Resume" />
        <NavItem to="/extension" icon={<Icon name="puzzle" size={14} />} label="Extension" />
      </div>

      <div style={{ flex: 1 }} />

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
export const PageHeader = ({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) => (
  <div style={{
    padding: '18px 28px 14px',
    display: 'flex', alignItems: 'center', gap: 10, rowGap: 8, flexWrap: 'wrap',
    borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg)',
    flexShrink: 0,
  }}>
    <div style={{ minWidth: 0, flex: '1 1 160px' }}>
      <div style={{ fontSize: 19, fontWeight: 650, color: 'var(--fg)', letterSpacing: '-0.025em', fontFamily: 'var(--font-display)', lineHeight: 1.25 }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {subtitle}
        </div>
      )}
    </div>
    {actions && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{actions}</div>}
  </div>
);
// Section title pattern used inside cards / forms — keep consistent everywhere.
export const SectionLabel = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{
    fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    marginBottom: 8, ...style,
  }}>{children}</div>
);
