// Landed — shared UI primitives and helpers
const { useState, useEffect, useMemo, useRef, useCallback } = React;

const stageColors = {
  saved:    { bg: 'oklch(0.96 0.005 240)', fg: 'oklch(0.45 0.01 240)',  dot: 'oklch(0.65 0.02 240)',  ring: 'oklch(0.88 0.01 240)' },
  applied:  { bg: 'oklch(0.96 0.03 240)',  fg: 'oklch(0.45 0.12 240)',  dot: 'oklch(0.62 0.15 240)',  ring: 'oklch(0.88 0.05 240)' },
  oa:       { bg: 'oklch(0.96 0.04 275)',  fg: 'oklch(0.44 0.14 275)',  dot: 'oklch(0.60 0.17 275)',  ring: 'oklch(0.88 0.06 275)' },
  phone:    { bg: 'oklch(0.96 0.04 305)',  fg: 'oklch(0.44 0.14 305)',  dot: 'oklch(0.60 0.17 305)',  ring: 'oklch(0.88 0.06 305)' },
  onsite:   { bg: 'oklch(0.96 0.05 340)',  fg: 'oklch(0.45 0.15 340)',  dot: 'oklch(0.62 0.18 340)',  ring: 'oklch(0.88 0.07 340)' },
  offer:    { bg: 'oklch(0.96 0.05 155)',  fg: 'oklch(0.40 0.13 155)',  dot: 'oklch(0.60 0.17 155)',  ring: 'oklch(0.86 0.07 155)' },
  rejected: { bg: 'oklch(0.96 0.03 25)',   fg: 'oklch(0.50 0.12 25)',   dot: 'oklch(0.65 0.15 25)',   ring: 'oklch(0.88 0.05 25)' },
  ghosted:  { bg: 'oklch(0.96 0.003 60)',  fg: 'oklch(0.55 0.01 60)',   dot: 'oklch(0.70 0.01 60)',   ring: 'oklch(0.90 0.005 60)' },
};

window.stageColors = stageColors;

function CompanyMark({ company, size = 32 }) {
  const bg = `oklch(0.94 0.04 ${company.hue})`;
  const fg = `oklch(0.35 0.12 ${company.hue})`;
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28,
      background: bg, color: fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: size * 0.42,
      letterSpacing: '-0.02em', flexShrink: 0,
      border: `0.5px solid oklch(0.88 0.04 ${company.hue})`,
    }}>{company.logo}</div>
  );
}
window.CompanyMark = CompanyMark;

function StageBadge({ stage, size = 'sm' }) {
  const s = STAGES.find(x => x.id === stage);
  const c = stageColors[stage];
  const padding = size === 'sm' ? '2px 8px 2px 6px' : '4px 10px 4px 8px';
  const fontSize = size === 'sm' ? 11 : 12;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding, borderRadius: 999,
      background: c.bg, color: c.fg,
      fontSize, fontWeight: 500, letterSpacing: '0.01em',
      border: `0.5px solid ${c.ring}`,
      whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: c.dot }} />
      {s.label}
    </span>
  );
}
window.StageBadge = StageBadge;

function PortalDot({ companyId }) {
  const p = PORTAL_STATUS[companyId];
  if (!p) return null;
  if (p.ok) {
    return <span title={`Synced ${p.lastSync}`} style={{
      width: 7, height: 7, borderRadius: 4,
      background: 'oklch(0.70 0.14 155)',
      boxShadow: '0 0 0 2px oklch(0.95 0.05 155)',
      display: 'inline-block',
    }} />;
  }
  return <span title={`${p.reason} · last ${p.lastSync}`} style={{
    width: 7, height: 7, borderRadius: 4,
    background: 'oklch(0.70 0.15 35)',
    boxShadow: '0 0 0 2px oklch(0.95 0.05 35)',
    display: 'inline-block',
    animation: 'pulse 2s ease-in-out infinite',
  }} />;
}
window.PortalDot = PortalDot;

// Brand logo — bold geometric "L" with an accent dot.
// The L is the letterform of "Landed"; the dot is both the period in "Landed."
// and a marker for the moment of arrival.
function LandedMark({ size = 22, dotColor = 'oklch(0.62 0.18 30)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Landed">
      {/* The L — filled, slightly bracketed serif tips for character */}
      <path d="M7 5.5 L10 5.5 L10 15.5 L17 15.5 L17 18.5 L7 18.5 Z" fill="currentColor" />
      {/* The arrival dot — accent color, top-right */}
      <circle cx="18" cy="7" r="2" fill={dotColor} />
    </svg>
  );
}
window.LandedMark = LandedMark;

function Icon({ name, size = 16, stroke = 1.5 }) {
  const paths = {
    kanban: <><rect x="3" y="4" width="5" height="14" rx="1"/><rect x="10" y="4" width="5" height="9" rx="1"/><rect x="17" y="4" width="4" height="12" rx="1"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 4v16"/></>,
    timeline: <><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/><path d="M6.6 12h3.8M13.6 12h3.8"/></>,
    cards: <><rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/></>,
    map: <><path d="M9 3L3 5v16l6-2 6 2 6-2V3l-6 2-6-2z"/><path d="M9 3v16M15 5v16"/></>,
    search: <><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    chevronDown: <><path d="M6 9l6 6 6-6"/></>,
    chevronRight: <><path d="M9 6l6 6-6 6"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9M10 6H4v14h14v-6"/></>,
    star: <><path d="M12 3l2.6 5.5L20 9.3l-4 4.1 1 5.8-5-2.7-5 2.7 1-5.8-4-4.1 5.4-0.8L12 3z"/></>,
    filter: <><path d="M4 5h16M7 12h10M10 19h4"/></>,
    sort: <><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></>,
    bell: <><path d="M6 10a6 6 0 0112 0v4l1.5 3h-15L6 14v-4z"/><path d="M10 20a2 2 0 004 0"/></>,
    sparkle: <><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3z"/><path d="M19 15l0.8 2 2 0.8-2 0.8-0.8 2-0.8-2-2-0.8 2-0.8 0.8-2z"/></>,
    doc: <><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/></>,
    adjust: <><path d="M4 6h10M4 12h4M4 18h14"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="18" r="2" fill="none"/></>,
    refresh: <><path d="M4 12a8 8 0 0114-5.3L20 8M20 4v4h-4"/><path d="M20 12a8 8 0 01-14 5.3L4 16M4 20v-4h4"/></>,
    link: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="1.5"/><path d="M3 10h18M8 3v4M16 3v4"/></>,
    alert: <><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v0.5"/></>,
    check: <><path d="M5 12l5 5 9-11"/></>,
    x: <><path d="M6 6l12 12M18 6L6 18"/></>,
    dots: <><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></>,
    inbox: <><path d="M4 13l3-8h10l3 8"/><path d="M4 13v6h16v-6M4 13h5l1 2h4l1-2h5"/></>,
    wand: <><path d="M15 4l5 5L9 20H4v-5L15 4z"/><path d="M14 5l5 5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></>,
    arrowRight: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    logo: <><path d="M4 18l6-12 4 7 3-4 3 9"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
window.Icon = Icon;

// Export
Object.assign(window, { CompanyMark, StageBadge, PortalDot, Icon, LandedMark, stageColors });
