// Auth + onboarding components — login modal, profile menu, first-run tour
import React, { useState as authState, useEffect as authEffect, useRef as authRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, LandedMark, StageBadge, CompanyMark } from './primitives';
import { COMPANIES } from '../data';
import { supabase } from '../lib/supabase';

// ---------- Profile menu (dropdown from sidebar avatar) ----------
const THEMES = [
  { id: 'cool', label: 'Cool' },
  { id: 'warm', label: 'Warm' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'dark', label: 'Dark' },
];

export function ProfileMenu({ open, onClose, onSignOut, onShowTour, theme, setTheme }) {
  const navigate = useNavigate();
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
          <div style={{ width: 28, height: 28, borderRadius: 14, background: 'oklch(0.85 0.06 220)', color: 'oklch(0.35 0.15 220)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>Y</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Your Name</div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>you@landed.app</div>
          </div>
        </div>
        <div style={{ marginTop: 6, padding: '4px 7px', background: 'oklch(0.96 0.04 60)', border: '0.5px solid oklch(0.88 0.06 60)', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Icon name="sparkle" size={10} />
          <span style={{ fontSize: 10.5, color: 'oklch(0.42 0.12 60)', fontWeight: 500 }}>Pro plan · 13 days left</span>
        </div>
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
        <Item icon={<Icon name="settings" size={13} />} label="Profile & account" kbd="⌘," />
        <Item icon={<Icon name="doc" size={13} />} label="My resumes" onClick={() => navigate('/resumes')} />
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

// ---------- Login screen ----------
// Passwordless email OTP code + OAuth (Google / GitHub).
//
// Why OTP code instead of magic-link click: corporate / .edu email security
// scanners (Outlook ATP, Mimecast, UW's filter, etc.) auto-fetch URLs in
// emails to scan them — this CONSUMES the magic-link token before the user
// can click it. The 6-digit OTP code in the same email is a separately
// verifiable token that scanners can't touch.
//
// For best results, the project's email template should remove
// {{ .ConfirmationURL }} entirely and keep only {{ .Token }} — see
// Supabase dashboard → Authentication → Email Templates → Magic Link.
//
// OAuth buttons only work once you've registered the providers in Supabase
// dashboard → Auth → Providers; until then they surface a "Unsupported
// provider" error inline.
export function LoginScreen() {
  const [email, setEmail] = authState(() => localStorage.getItem('landed:dev-last-email') || '');
  const [code, setCode] = authState('');
  const [loading, setLoading] = authState(false);
  const [verifying, setVerifying] = authState(false);
  const [sentTo, setSentTo] = authState(null); // email address after OTP requested
  const [error, setError] = authState(null);

  const sendCode = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const trimmed = email.trim();
    const { error: err } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (err) setError(err.message);
    else setSentTo(trimmed);
  };

  const verifyCode = async (e) => {
    e.preventDefault();
    setError(null);
    setVerifying(true);
    const { error: err } = await supabase.auth.verifyOtp({
      email: sentTo,
      token: code.trim(),
      type: 'email',
    });
    setVerifying(false);
    if (err) setError(err.message);
    // On success: onAuthStateChange in App.tsx fires → session set → dashboard renders.
  };

  // Dev-only: hits the Vite middleware in vite.config.ts which uses
  // service_role to mint a session for any email — no email round-trip,
  // no rate-limit. Available ONLY under `vite dev`.
  const devLogin = async () => {
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) { setError('Enter an email first.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `dev login failed (${res.status})`);
      await supabase.auth.setSession(body.session);
      localStorage.setItem('landed:dev-last-email', trimmed);
      // onAuthStateChange in App.tsx fires next; dashboard appears.
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const oauth = async (provider) => {
    setError(null);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (err) setError(`${provider}: ${err.message}`);
  };

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
            Land your next role.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            Sign in to keep your application pipeline in sync. No password — we'll email you a 6-digit code.
          </div>
        </div>

        {sentTo ? (
          <form onSubmit={verifyCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ padding: 14, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>Check your email</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                A 6-digit code is on its way to <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{sentTo}</span>. Paste it below.
              </div>
            </div>

            <label htmlFor="login-code" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500, marginTop: 4 }}>Code</label>
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              required
              style={{ padding: '8px 10px', fontSize: 15, fontFamily: 'var(--font-mono)', letterSpacing: '0.2em', textAlign: 'center' }}
            />

            {error && (
              <div style={{
                fontSize: 11.5, color: 'oklch(0.45 0.15 30)',
                padding: '6px 10px', background: 'oklch(0.97 0.03 30)',
                border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
              }}>{error}</div>
            )}

            <button type="submit" disabled={verifying || code.length < 6} className="btn-primary"
              style={{ marginTop: 6, justifyContent: 'center', padding: '8px 12px', fontSize: 12.5, opacity: (verifying || code.length < 6) ? 0.6 : 1 }}>
              {verifying ? 'Verifying…' : 'Sign in'}
              {!verifying && <Icon name="arrowRight" size={12} />}
            </button>

            <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.5, marginTop: 2 }}>
              Tip: in dev, run <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>pnpm dev:otp {sentTo}</span> to print the code directly to your terminal — bypasses email entirely.
            </div>

            <button type="button" onClick={() => { setSentTo(null); setCode(''); setError(null); }} style={{
              alignSelf: 'flex-start', marginTop: 4,
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--accent)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
            }}>
              Use a different email →
            </button>
          </form>
        ) : (
          <form onSubmit={sendCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button type="button" onClick={() => oauth('google')} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', padding: '8px 12px', fontSize: 12.5 }}>
              <Icon name="external" size={13} /> Continue with Google
            </button>
            <button type="button" onClick={() => oauth('github')} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', padding: '8px 12px', fontSize: 12.5 }}>
              <Icon name="external" size={13} /> Continue with GitHub
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>or with email</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>

            <label htmlFor="login-email" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@work.com"
              required
              autoFocus
              style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }}
            />

            {error && (
              <div style={{
                fontSize: 11.5, color: 'oklch(0.45 0.15 30)',
                padding: '6px 10px', background: 'oklch(0.97 0.03 30)',
                border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
              }}>{error}</div>
            )}

            <button type="submit" disabled={loading || !email} className="btn-primary"
              style={{ marginTop: 6, justifyContent: 'center', padding: '8px 12px', fontSize: 12.5, opacity: (loading || !email) ? 0.6 : 1 }}>
              {loading ? 'Sending code…' : 'Send code'}
              {!loading && <Icon name="arrowRight" size={12} />}
            </button>

            <button
              type="button"
              disabled={!email.trim()}
              onClick={() => { setSentTo(email.trim()); setError(null); }}
              style={{
                alignSelf: 'flex-start', marginTop: 6,
                background: 'transparent', border: 'none', padding: 0,
                cursor: email.trim() ? 'pointer' : 'not-allowed',
                color: email.trim() ? 'var(--accent)' : 'var(--fg-muted)',
                fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
              }}
            >
              Already have a code? Enter it →
            </button>

            {import.meta.env.DEV && (
              <div style={{
                marginTop: 10, padding: 10,
                background: 'oklch(0.96 0.04 90)',
                border: '0.5px dashed oklch(0.78 0.1 90)',
                borderRadius: 6,
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'oklch(0.40 0.12 90)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Dev shortcut
                </div>
                <button
                  type="button"
                  disabled={loading || !email.trim()}
                  onClick={devLogin}
                  className="btn-secondary"
                  style={{ width: '100%', justifyContent: 'center', padding: '7px 12px', fontSize: 12, opacity: (loading || !email.trim()) ? 0.6 : 1 }}
                >
                  Skip email — sign in now
                </button>
                <div style={{ fontSize: 10.5, color: 'oklch(0.42 0.08 90)', lineHeight: 1.45 }}>
                  Stripped from production builds. Uses service_role server-side via /api/dev/login.
                </div>
              </div>
            )}
          </form>
        )}

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
    body: "Your job-hunt operations console. Let's set you up in about 60 seconds.",
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

