// Account + onboarding components — login screen, account menu, first-run
// tour. Landed is local-first: everyone signs in, but data stays in the
// browser unless the account turns on Landed Cloud sync. The account menu
// shows where data lives and hosts that switch.
import React, { useState as authState, useEffect as authEffect, useRef as authRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, LandedMark, StageBadge, CompanyMark } from './primitives';
import { COMPANIES } from '../data';
import { useAuth } from '../lib/auth';
import type { ShellAccount } from './shell';

// ---------- Profile menu (dropdown from sidebar avatar) ----------
const THEMES = [
  { id: 'cool', label: 'Cool' },
  { id: 'warm', label: 'Warm' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'dark', label: 'Dark' },
];

// Whether the browser promised not to evict this origin's storage.
function usePersisted(open: boolean) {
  const [persisted, setPersisted] = authState<boolean | null>(null);
  authEffect(() => {
    if (!open || !navigator.storage?.persisted) return;
    navigator.storage.persisted().then(setPersisted).catch(() => {});
  }, [open]);
  return persisted;
}

type ProfileMenuProps = {
  open: boolean;
  onClose: () => void;
  account: ShellAccount;
  onShowTour: () => void;
  theme: string;
  setTheme: (theme: string) => void;
  onTurnOnCloud: () => void;
  onSignOut: () => void;
  onLeaveCloud: () => void;
  onExport: () => void;
  onImport: () => void;
  onRecoveryCodes: () => void;
};

type MenuItemProps = { icon: React.ReactNode; label: React.ReactNode; kbd?: string; onClick?: () => void; danger?: boolean };

export function ProfileMenu({
  open, onClose, account, onShowTour, theme, setTheme,
  onTurnOnCloud, onSignOut, onLeaveCloud, onExport, onImport, onRecoveryCodes,
}: ProfileMenuProps) {
  const navigate = useNavigate();
  const persisted = usePersisted(open && account.mode === 'local');
  const inCloud = account.mode === 'cloud';
  authEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('[data-profile-menu]') && !target.closest('[data-profile-trigger]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, onClose]);

  if (!open) return null;

  const Item = ({ icon, label, kbd, onClick, danger }: MenuItemProps) => (
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
              {account.email}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name={inCloud ? 'cloud' : 'device'} size={11} />
              {inCloud ? 'Landed Cloud sync on' : 'Data stored on this device'}
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
          ? <Item icon={<Icon name="device" size={13} />} label="Turn off Cloud sync…" onClick={onLeaveCloud} />
          : <Item icon={<Icon name="cloud" size={13} />} label="Turn on Cloud sync…" onClick={onTurnOnCloud} />}
        <Item icon={<Icon name="download" size={13} />} label="Export backup" onClick={onExport} />
        <Item icon={<Icon name="upload" size={13} />} label="Restore backup…" onClick={onImport} />
      </div>
      <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
        <Item icon={<Icon name="doc" size={13} />} label="My resumes" onClick={() => navigate('/resumes')} />
        <Item icon={<Icon name="refresh" size={13} />} label="Recovery codes…" onClick={onRecoveryCodes} />
        <Item icon={<Icon name="adjust" size={13} />} label="Preferences" />
      </div>
      <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
        <Item icon={<Icon name="sparkle" size={13} />} label="What's new" />
        <Item icon={<Icon name="target" size={13} />} label="Show tour again" onClick={onShowTour} />
        <Item icon={<Icon name="external" size={13} />} label="Help & docs" />
      </div>
      <div style={{ borderTop: '0.5px solid var(--border)', padding: '4px 0' }}>
        <Item icon={<Icon name="x" size={13} />} label="Sign out" onClick={onSignOut} danger />
      </div>
    </div>
  );
}

// Round avatar with the email initial; tinted when the account syncs to Cloud.
export function AccountAvatar({ account, size = 24 }: { account: ShellAccount; size?: number }) {
  const inCloud = account.mode === 'cloud';
  return (
    <div style={{
      width: size, height: size, borderRadius: size / 2, flexShrink: 0,
      background: inCloud ? 'oklch(0.85 0.06 220)' : 'var(--surface-3)',
      color: inCloud ? 'oklch(0.35 0.15 220)' : 'var(--fg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.43, fontWeight: 600,
    }}>
      {account.email.slice(0, 1).toUpperCase()}
    </div>
  );
}

// ---------- Login screen ----------
// Everyone signs in (email + password against apps/server). Signing in does
// NOT move data anywhere: each account's data stays in this browser until
// the user turns on Landed Cloud sync from the account menu.
type LoginMode = 'signin' | 'signup' | 'forgot' | 'reset' | 'recovery';

export function LoginScreen({ initialMode = 'signin' }: { initialMode?: LoginMode }) {
  const navigate = useNavigate();
  const signIn = useAuth((s) => s.signIn);
  const signUp = useAuth((s) => s.signUp);
  const requestPasswordReset = useAuth((s) => s.requestPasswordReset);
  const resetPassword = useAuth((s) => s.resetPassword);
  const recoverWithCode = useAuth((s) => s.recoverWithCode);
  const sessionExpired = useAuth((s) => s.sessionExpired);
  const [mode, setMode] = authState<LoginMode>(initialMode);
  const [email, setEmail] = authState(() => localStorage.getItem('landed:last-email') || '');
  const [recoveryCode, setRecoveryCode] = authState('');
  const [password, setPassword] = authState('');
  const [confirmPassword, setConfirmPassword] = authState('');
  const [loading, setLoading] = authState(false);
  const [error, setError] = authState<string | null>(null);
  const [notice, setNotice] = authState<string | null>(null);
  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';
  const isRecovery = mode === 'recovery';
  const usesNewPassword = isSignup || isReset || isRecovery;
  const resetToken = isReset ? new URLSearchParams(window.location.hash.slice(1)).get('token') || '' : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    const trimmed = email.trim();
    try {
      if (isForgot) {
        const message = await requestPasswordReset(trimmed);
        localStorage.setItem('landed:last-email', trimmed);
        setNotice(message);
        setLoading(false);
        return;
      }
      if (isReset) {
        if (!resetToken) throw new Error('This reset link is invalid or incomplete.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const user = await resetPassword(resetToken, password);
        localStorage.setItem('landed:last-email', user.email);
        navigate('/applications', { replace: true });
        return;
      }
      if (isRecovery) {
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const user = await recoverWithCode(trimmed, recoveryCode, password);
        localStorage.setItem('landed:last-email', user.email);
        navigate('/applications', { replace: true });
        return;
      }
      await (isSignup ? signUp : signIn)(trimmed, password);
      localStorage.setItem('landed:last-email', trimmed);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode(isSignup ? 'signin' : 'signup');
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirmPassword('');
    setRecoveryCode('');
  };

  const showMode = (nextMode: LoginMode) => {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirmPassword('');
    setRecoveryCode('');
  };

  const title = isReset ? 'Choose a new password.'
    : isForgot ? 'Reset your password.'
      : isRecovery ? 'Use a recovery code.'
      : isSignup ? 'Create your account.' : 'Land your next role.';
  const description = isReset
    ? 'Use a new password with at least 8 characters. All older Landed sessions will be signed out.'
    : isForgot
      ? 'Enter your account email. We’ll send a secure, one-time link that expires in 30 minutes.'
      : isRecovery
        ? 'Enter one of the single-use codes you saved earlier, then choose a new password.'
      : isSignup
        ? 'Your pipeline stays in this browser. Turn on Landed Cloud sync later if you want it on every device.'
        : 'Your data stays on your device unless you turned on Landed Cloud sync.';
  const submitDisabled = loading || (isReset
    ? !resetToken || !password || !confirmPassword
    : isForgot ? !email
      : isRecovery ? !email || !recoveryCode || !password || !confirmPassword
        : !email || !password);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 500,
      display: 'flex', alignItems: 'stretch',
    }}>
      {/* Left — form */}
      <div style={{
        flex: '0 0 420px',
        display: 'flex', flexDirection: 'column',
        padding: '48px 56px',
        borderRight: '0.5px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 'auto' }}>
          <LandedMark size={22} />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>Landed</span>
        </div>

        <div style={{ marginTop: 40, marginBottom: 24 }}>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.15, fontFamily: 'var(--font-display)', marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            {description}
          </div>
        </div>

        {sessionExpired && !isReset && !isRecovery && (
          <div role="status" style={{
            fontSize: 11.5, padding: '7px 10px', marginBottom: 12, borderRadius: 6, lineHeight: 1.5,
            background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
          }}>
            Your session ended — sign in again.
          </div>
        )}

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!isReset && <>
            <label htmlFor="login-email" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@work.com"
              required
              autoFocus={!email || isForgot}
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }}
            />
          </>}

          {isRecovery && <>
            <label htmlFor="recovery-code" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500, marginTop: 4 }}>Recovery code</label>
            <input
              id="recovery-code"
              type="text"
              autoComplete="one-time-code"
              value={recoveryCode}
              onChange={e => setRecoveryCode(e.target.value.toUpperCase())}
              placeholder="LND-XXXXX-XXXXX-XXXXX-XXXXX"
              required
              spellCheck={false}
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
            />
          </>}

          {!isForgot && <>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4 }}>
              <label htmlFor="login-password" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>
                {(isReset || isRecovery) ? 'New password' : 'Password'}
              </label>
              {mode === 'signin' && (
                <button type="button" onClick={() => showMode('forgot')} style={{
                  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--accent)', fontSize: 11, fontFamily: 'inherit', fontWeight: 500,
                }}>Forgot password?</button>
              )}
            </div>
            <input
              id="login-password"
              type="password"
              autoComplete={usesNewPassword ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={usesNewPassword ? 'At least 8 characters' : ''}
              minLength={usesNewPassword ? 8 : undefined}
              required
              autoFocus={isReset || (!isRecovery && !!email)}
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }}
            />
          </>}

          {(isReset || isRecovery) && <>
            <label htmlFor="confirm-password" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500, marginTop: 4 }}>Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              minLength={8}
              required
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }}
            />
          </>}

          {notice && (
            <div role="status" style={{
              fontSize: 11.5, color: 'oklch(0.38 0.1 150)',
              padding: '7px 10px', background: 'oklch(0.97 0.03 150)',
              border: '0.5px solid oklch(0.86 0.06 150)', borderRadius: 6, lineHeight: 1.5,
            }}>{notice}</div>
          )}

          {error && (
            <div style={{
              fontSize: 11.5, color: 'oklch(0.45 0.15 30)',
              padding: '6px 10px', background: 'oklch(0.97 0.03 30)',
              border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
            }}>{error}</div>
          )}

          <button type="submit" disabled={submitDisabled} className="btn-primary"
            style={{ marginTop: 6, justifyContent: 'center', padding: '8px 12px', fontSize: 12.5, opacity: submitDisabled ? 0.6 : 1 }}>
            {loading
              ? ((isReset || isRecovery) ? 'Updating password…' : isForgot ? 'Sending link…' : isSignup ? 'Creating account…' : 'Signing in…')
              : ((isReset || isRecovery) ? 'Set new password' : isForgot ? (notice ? 'Send another link' : 'Email me a reset link') : isSignup ? 'Create account' : 'Sign in')}
            {!loading && <Icon name="arrowRight" size={12} />}
          </button>

          {isForgot && <button type="button" onClick={() => showMode('recovery')} style={{
            alignSelf: 'flex-start', marginTop: 6,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
          }}>
            Use a recovery code instead →
          </button>}
          {(isForgot || isRecovery) && <button type="button" onClick={() => showMode('signin')} style={{
            alignSelf: 'flex-start', marginTop: 2,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--fg-muted)', fontSize: 11.5, fontFamily: 'inherit', fontWeight: 500,
          }}>← Back to sign in</button>}
          {isRecovery && <button type="button" onClick={() => showMode('forgot')} style={{
            alignSelf: 'flex-start', marginTop: 2,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11.5, fontFamily: 'inherit', fontWeight: 500,
          }}>Use an email reset link instead</button>}
          {!isReset && !isForgot && !isRecovery && <button type="button" onClick={switchMode} style={{
            alignSelf: 'flex-start', marginTop: 6,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
          }}>
            {isSignup ? 'Already have an account? Sign in →' : 'New here? Create an account →'}
          </button>}
        </form>

        <div style={{ marginTop: 'auto', paddingTop: 24, fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          By continuing you agree to the <a href="#" style={{ color: 'var(--fg-muted)' }}>terms</a> and <a href="#" style={{ color: 'var(--fg-muted)' }}>privacy policy</a>. Cookies from portals never leave your browser.
        </div>
      </div>

      {/* Right — marketing canvas */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48, position: 'relative', overflow: 'hidden', background: 'var(--surface-2)' }}>
        <LoginCollage />
      </div>
    </div>
  );
}

function LoginCollage() {
  return (
    <div style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)', lineHeight: 1.25, marginBottom: 6 }}>
        Every application, every portal, every AI reply — one place.
      </div>

      {/* Mini kanban-ish preview */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', gap: 8 }}>
        {['applied','phone','onsite'].map((s, i) => (
          <div key={s} style={{ flex: 1, padding: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6 }}>
            <StageBadge stage={s} />
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[0, 1, 2 - i].slice(0, 3 - i).map(j => {
                const c = COMPANIES[i * 3 + j];
                return c ? (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: 5, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 4 }}>
                    <CompanyMark company={c} size={16} />
                    <span style={{ fontSize: 10.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name.split(' ')[0]}</span>
                  </div>
                ) : null;
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Activity card */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.65 0.17 155)' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)' }}>Live · auto-sync from 16 portals</span>
        </div>
        {[
          { c: COMPANIES[0], from: 'Phone', to: 'Onsite', t: 'just now' },
          { c: COMPANIES[4], from: 'Applied', to: 'Phone', t: '14 min' },
        ].map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)' }}>
            <CompanyMark company={e.c} size={16} />
            <span style={{ fontSize: 11, fontWeight: 500 }}>{e.c.name.split(' ')[0]}</span>
            <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{e.from}</span>
            <Icon name="arrowRight" size={10} />
            <span style={{ fontSize: 10.5, color: 'oklch(0.45 0.13 240)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{e.to}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{e.t}</span>
          </div>
        ))}
      </div>

      {/* AI router preview */}
      <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Route to your AI</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { name: 'ChatGPT', color: 'oklch(0.55 0.13 155)' },
            { name: 'Claude',  color: 'oklch(0.58 0.14 40)' },
            { name: 'Gemini',  color: 'oklch(0.55 0.13 255)' },
          ].map(p => (
            <div key={p.name} style={{ flex: 1, padding: '6px 8px', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: p.color }} />
              <span style={{ fontSize: 10.5, fontWeight: 500 }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Onboarding tour ----------
const ONBOARDING_STEPS = [
  {
    title: 'Welcome to Landed',
    body: "Your job-hunt operations console. Everything you add stays in this browser — turn on Landed Cloud sync from the account menu when you want it on every device.",
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

export function OnboardingTour({ onClose }: { onClose: () => void }) {
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

function TourArt({ kind }: { kind: string }) {
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

