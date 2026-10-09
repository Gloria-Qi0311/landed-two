// Account + onboarding components — profile/account menu, first-run tour.
// Landed is local-first: there is no login gate. The account menu shows
// where data lives (this device vs Landed Cloud) and hosts the switches.
import React, { useState as authState, useEffect as authEffect, useRef as authRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, LandedMark, StageBadge, CompanyMark } from './primitives';
import { COMPANIES } from '../data';

// ---------- Profile menu (dropdown from sidebar avatar) ----------
const THEMES = [
  { id: 'cool', label: 'Cool' },
  { id: 'warm', label: 'Warm' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'dark', label: 'Dark' },
];

// Whether the browser promised not to evict this origin's storage.
function usePersisted(open) {
  const [persisted, setPersisted] = authState(null);
  authEffect(() => {
    if (!open || !navigator.storage?.persisted) return;
    navigator.storage.persisted().then(setPersisted).catch(() => {});
  }, [open]);
  return persisted;
}

export function ProfileMenu({
  open, onClose, account, onShowTour, theme, setTheme,
  onTurnOnCloud, onSignOut, onLeaveCloud, onExport, onImport,
}) {
  const navigate = useNavigate();
  const persisted = usePersisted(open && account.mode === 'local');
  const inCloud = account.mode === 'cloud';
  authEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!e.target.closest('[data-profile-menu]') && !e.target.closest('[data-profile-trigger]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, onClose]);

  if (!open) return null;

  const Item = ({ icon, label, kbd, onClick, danger }) => (
    <button onClick={() => { onClick && onClick(); onClose(); }} style={{
      width: '100%', textAlign: 'left',
      padding: '7px 10px', fontSize: 12.5,
      background: 'transparent', border: 'none', borderRadius: 5,
      color: danger ? 'oklch(0.5 0.16 30)' : 'var(--fg)',
      display: 'flex', alignItems: 'center', gap: 9,
      cursor: 'pointer', fontFamily: 'inherit',
    }} className="sidebar-item">
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {kbd && <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{kbd}</span>}
    </button>
  );

  return (
    <div data-profile-menu style={{
      position: 'fixed', bottom: 56, left: 10,
      width: 224,
      background: 'var(--surface)',
      border: '0.5px solid var(--border)',
      borderRadius: 8,
      padding: 5,
      boxShadow: '0 12px 40px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)',
      zIndex: 200,
      animation: 'slideIn 140ms cubic-bezier(0.2, 0, 0, 1)',
    }}>
      <div style={{ padding: '8px 10px 10px', borderBottom: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <AccountAvatar account={account} size={28} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {inCloud ? account.email : 'This device'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
              {inCloud ? 'Landed Cloud · synced' : 'Local · stays in this browser'}
            </div>
          </div>
        </div>
        {!inCloud && persisted === false && (
          <div style={{ marginTop: 7, padding: '5px 7px', background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.88 0.06 70)', borderRadius: 4, fontSize: 10.5, color: 'oklch(0.42 0.1 60)', lineHeight: 1.45 }}>
            Your browser may clear this data under storage pressure. Export a backup now and then.
          </div>
        )}
      </div>

      {setTheme && (
        <div style={{ padding: '8px 10px 6px', borderBottom: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Theme</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {THEMES.map(t => (
              <button key={t.id} onClick={() => setTheme(t.id)} style={{
                padding: '4px 9px', fontSize: 11, fontWeight: 500,
                background: theme === t.id ? 'var(--fg)' : 'var(--surface)',
                color: theme === t.id ? 'var(--bg)' : 'var(--fg)',
                border: `0.5px solid ${theme === t.id ? 'var(--fg)' : 'var(--border)'}`,
                borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
              }}>{t.label}</button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '4px 0' }}>
        {inCloud
          ? <Item icon={<Icon name="device" size={13} />} label="Move data to this device…" onClick={onLeaveCloud} />
          : <Item icon={<Icon name="cloud" size={13} />} label="Turn on Landed Cloud…" onClick={onTurnOnCloud} />}
        <Item icon={<Icon name="download" size={13} />} label="Export backup" onClick={onExport} />
        <Item icon={<Icon name="upload" size={13} />} label="Restore backup…" onClick={onImport} />
      </div>
      <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
        <Item icon={<Icon name="doc" size={13} />} label="My resumes" onClick={() => navigate('/resumes')} />
        <Item icon={<Icon name="adjust" size={13} />} label="Preferences" />
      </div>
      <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
        <Item icon={<Icon name="sparkle" size={13} />} label="What's new" />
        <Item icon={<Icon name="target" size={13} />} label="Show tour again" onClick={onShowTour} />
        <Item icon={<Icon name="external" size={13} />} label="Help & docs" />
      </div>
      {inCloud && (
        <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
          <Item icon={<Icon name="x" size={13} />} label="Sign out of Cloud" onClick={onSignOut} danger />
        </div>
      )}
    </div>
  );
}

// Round avatar: email initial in Cloud mode, a device glyph locally.
export function AccountAvatar({ account, size = 24 }) {
  const inCloud = account.mode === 'cloud';
  return (
    <div style={{
      width: size, height: size, borderRadius: size / 2, flexShrink: 0,
      background: inCloud ? 'oklch(0.85 0.06 220)' : 'var(--surface-3)',
      color: inCloud ? 'oklch(0.35 0.15 220)' : 'var(--fg-muted)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.43, fontWeight: 600,
    }}>
      {inCloud ? account.email.slice(0, 1).toUpperCase() : <Icon name="device" size={Math.round(size * 0.55)} />}
    </div>
  );
}

// ---------- Onboarding tour ----------
const ONBOARDING_STEPS = [
  {
    title: 'Welcome to Landed',
    body: "Your job-hunt operations console. No account needed — everything you add stays in this browser. Turn on Landed Cloud later if you want it on every device.",
    art: 'hero',
  },
  {
    title: 'Track every application',
    body: 'Five views over the same data. Kanban for triage, Table for density, Timeline for "what moved this week."',
    art: 'views',
  },
  {
    title: 'Auto-sync from portals',
    body: 'Our browser extension watches Greenhouse, Lever, Workday, Ashby and more. Stage changes show up here without you refreshing.',
    art: 'sync',
  },
  {
    title: 'AI without paying for an API',
    body: "Generate a prompt, send it to your existing ChatGPT / Claude / Gemini, paste the reply back. We parse the structured answer and visualize the comparison.",
    art: 'ai',
  },
];

export function OnboardingTour({ onClose }) {
  const [step, setStep] = authState(0);
  const total = ONBOARDING_STEPS.length;
  const s = ONBOARDING_STEPS[step];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'oklch(0.18 0.01 240 / 0.55)',
      backdropFilter: 'blur(2px)', zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'slideIn 200ms ease',
    }}>
      <div style={{
        width: 560, background: 'var(--surface)',
        border: '0.5px solid var(--border)', borderRadius: 12,
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      }}>
        {/* Art panel */}
        <div style={{ height: 220, background: 'var(--surface-2)', position: 'relative', overflow: 'hidden', borderBottom: '0.5px solid var(--border)' }}>
          <TourArt kind={s.art} />
        </div>

        {/* Copy */}
        <div style={{ padding: '22px 28px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>
            Step {step + 1} of {total}
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', marginBottom: 6 }}>{s.title}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 480 }}>{s.body}</div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px 16px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {ONBOARDING_STEPS.map((_, i) => (
              <span key={i} style={{
                width: i === step ? 16 : 5, height: 5, borderRadius: 3,
                background: i <= step ? 'var(--fg)' : 'var(--border-strong)',
                transition: 'width 200ms, background 200ms',
              }} />
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} className="btn-secondary" style={{ fontSize: 12 }}>
            Skip tour
          </button>
          {step > 0 && (
            <button onClick={() => setStep(s => s - 1)} className="btn-secondary" style={{ fontSize: 12 }}>
              Back
            </button>
          )}
          <button onClick={() => step < total - 1 ? setStep(step + 1) : onClose()} className="btn-primary" style={{ fontSize: 12 }}>
            {step < total - 1 ? <>Next <Icon name="arrowRight" size={12} /></> : <>Get started <Icon name="check" size={12} stroke={2} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

function TourArt({ kind }) {
  if (kind === 'hero') {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
        <LandedMark size={48} />
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>v0.4 · early access</div>
      </div>
    );
  }
  if (kind === 'views') {
    return (
      <div style={{ position: 'absolute', inset: 0, padding: 18, display: 'flex', gap: 8 }}>
        {['saved','applied','phone','onsite','offer'].map((s, i) => (
          <div key={s} style={{ flex: 1, padding: 7, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <StageBadge stage={s} />
            {[0, 1, 2].slice(0, 3 - Math.floor(i / 2)).map(j => {
              const c = COMPANIES[i * 3 + j];
              return c ? (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 3 }}>
                  <CompanyMark company={c} size={12} />
                  <span style={{ fontSize: 9.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name.split(' ')[0]}</span>
                </div>
              ) : null;
            })}
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'sync') {
    return (
      <div style={{ position: 'absolute', inset: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>Browser extension · Chrome</div>
        {[
          { name: 'Greenhouse', state: 'Active',  color: 'oklch(0.65 0.17 155)' },
          { name: 'Lever',      state: 'Active',  color: 'oklch(0.65 0.17 155)' },
          { name: 'Workday',    state: 'Syncing', color: 'oklch(0.65 0.17 240)', pulse: true },
          { name: 'BOSS Zhipin', state: 'Expired', color: 'oklch(0.65 0.17 30)' },
        ].map((p, i) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color, animation: p.pulse ? 'pulse 1.2s ease-in-out infinite' : 'none' }} />
            <span style={{ fontSize: 11.5, fontWeight: 500 }}>{p.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{p.state}</span>
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'ai') {
    return (
      <div style={{ position: 'absolute', inset: 0, padding: 18, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', lineHeight: 1.6, padding: 10, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 5 }}>
          # Generated prompt<br/>
          Compare resume against 4 JDs. Return JSON…
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { name: 'ChatGPT', color: 'oklch(0.55 0.13 155)' },
            { name: 'Claude',  color: 'oklch(0.58 0.14 40)' },
            { name: 'Gemini',  color: 'oklch(0.55 0.13 255)' },
          ].map(p => (
            <div key={p.name} style={{ flex: 1, padding: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} />
              <span style={{ fontSize: 11, fontWeight: 500 }}>{p.name}</span>
              <Icon name="external" size={10} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

