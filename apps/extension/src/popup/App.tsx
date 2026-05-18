// Landed extension — side-panel surface (was popup; restored to side panel
// per user feedback. Single React app, served from the side panel via
// manifest.json's side_panel.default_path; clicking the toolbar icon opens
// the panel via background.js's chrome.action.onClicked handler).
//
// SCOPE OF THIS REWRITE: visual + brand parity with apps/web's LoginScreen
// (LandedMark + display heading + OAuth row + OR-WITH-EMAIL divider + dark
// .btn-primary + accent "Already have a code" + DEV SHORTCUT yellow card).
// Resume picker + fill flow (the SignedIn surface) unchanged from PR #67.
import React, { useEffect, useState } from 'react'
import * as auth from '@lib/auth.js'
// Namespace import (vs. named) matches the existing @lib/auth.js pattern
// and avoids Vite's CJS-interop edge case for named imports out of UMD
// modules. Sub-agent flagged the named form as fragile-but-working.
import * as sentinels from '@lib/portal-sentinels.js'
const { NEEDS_AUTH_KEY, FATAL_STATE_KEY } = sentinels

// NEEDS_AUTH_KEY is the chrome.storage.local sentinel the SW sets on
// 401/403 push failures and clears on the next successful push. The
// popup subscribes via chrome.storage.onChanged and renders ReauthBanner
// whenever it's truthy. Centralized in lib/portal-sentinels.js.

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'codeSent'; email: string }
  | { kind: 'signedIn'; email: string }

/** Read + subscribe to a single chrome.storage.local key. Returns the
 *  current value (or null if absent / chrome.* unavailable). Updates
 *  live via chrome.storage.onChanged so the consumer unmounts content
 *  within ms of the SW clearing the key.
 *
 *  Race protection: listener is registered BEFORE the async get, AND
 *  the post-await setter is gated on a "change already arrived" flag —
 *  prevents a stale `get` result from clobbering a newer onChanged
 *  update in the tight window between subscription and resolution.
 *  (Both fixes were caught by the Run 4 sub-agent review of #73.)
 */
function useStorageSentinel<T = unknown>(key: string): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    let cancelled = false
    let gotChange = false
    const listener = (changes: any, areaName: string) => {
      if (areaName !== 'local') return
      if (!changes || !(key in changes)) return
      gotChange = true
      setValue(changes[key].newValue ?? null)
    }
    try { chrome.storage.onChanged.addListener(listener) } catch { /* test env */ }
    ;(async () => {
      try {
        const res = await chrome.storage.local.get(key)
        if (cancelled || gotChange) return
        setValue(res?.[key] ?? null)
      } catch { /* chrome.* unavailable in tests — leave as null */ }
    })()
    return () => {
      cancelled = true
      try { chrome.storage.onChanged.removeListener(listener) } catch { /* test env */ }
    }
  }, [key])
  return value
}

/** Returns the ISO timestamp the SW last set on a 401/403 push, or null. */
function useNeedsAuth(): string | null {
  return useStorageSentinel<string>(NEEDS_AUTH_KEY)
}

/** Returns the fatal-state record the SW set on a 4xx schema/RLS
 *  rejection, or null. Shape: `{ error: string, at: ISO string }`. */
function useFatalState(): { error: string; at: string } | null {
  return useStorageSentinel<{ error: string; at: string }>(FATAL_STATE_KEY)
}

export function App() {
  const [state, setState] = useState<AuthState>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    ;(async () => {
      try {
        const session = await auth.getSession()
        if (session?.user?.email) setState({ kind: 'signedIn', email: session.user.email })
        else setState({ kind: 'signedOut' })
      } catch (e) {
        setError(toErr(e))
        setState({ kind: 'signedOut' })
      }
      unsubscribe = auth.onAuthChange((_event: string, session: any) => {
        if (session?.user?.email) setState({ kind: 'signedIn', email: session.user.email })
        else setState((s) => (s.kind === 'codeSent' ? s : { kind: 'signedOut' }))
      })
    })()
    return () => { unsubscribe?.() }
  }, [])

  if (state.kind === 'loading') {
    return (
      <>
        <Header />
        <div style={{ color: 'var(--fg-muted)', padding: '20px 0' }}>Loading…</div>
      </>
    )
  }

  if (state.kind === 'signedIn') {
    return (
      <SignedIn
        email={state.email}
        onSignOut={async () => {
          setBusy(true); setError(null)
          try { await auth.signOut(); setState({ kind: 'signedOut' }) }
          catch (e) { setError(toErr(e)) }
          finally { setBusy(false) }
        }}
        busy={busy}
        error={error}
      />
    )
  }

  if (state.kind === 'codeSent') {
    return (
      <CodeForm
        email={state.email}
        busy={busy}
        error={error}
        onBack={() => { setState({ kind: 'signedOut' }); setError(null) }}
        onVerify={async (token) => {
          setBusy(true); setError(null)
          try {
            const result = await auth.verifyOtp(state.email, token)
            if (result.error) setError(result.error.message || 'Invalid code')
          } catch (e) {
            setError(toErr(e))
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }

  return (
    <EmailForm
      busy={busy}
      error={error}
      onSubmit={async (email) => {
        setBusy(true); setError(null)
        try {
          const result = await auth.signInWithOtp(email)
          if (result.error) setError(result.error.message || 'Failed to send code')
          else setState({ kind: 'codeSent', email })
        } catch (e) {
          setError(toErr(e))
        } finally {
          setBusy(false)
        }
      }}
      onSkipToCode={(email) => {
        setError(null)
        setState({ kind: 'codeSent', email })
      }}
    />
  )
}

// ── Brand mark — verbatim from apps/web LandedMark ────────────────────────
function LandedMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Landed">
      <path d="M7 5.5 L10 5.5 L10 15.5 L17 15.5 L17 18.5 L7 18.5 Z" fill="currentColor" />
      <circle cx="18" cy="7" r="2" fill="var(--landed-dot)" />
    </svg>
  )
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <LandedMark size={22} />
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
        Landed
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>extension</span>
    </div>
  )
}

function DisplayHeading({ subtitle }: { subtitle: string }) {
  return (
    <div style={{ marginTop: 24, marginBottom: 8 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.2, fontFamily: 'var(--font-display)', marginBottom: 6 }}>
        Land your next role.
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
        {subtitle}
      </div>
    </div>
  )
}

function ArrowRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

// ── Signed-out: email form (mirrors web LoginScreen) ──────────────────────
function EmailForm({
  busy, error, onSubmit, onSkipToCode,
}: {
  busy: boolean
  error: string | null
  onSubmit: (e: string) => void
  onSkipToCode: (e: string) => void
}) {
  const [email, setEmail] = useState('')
  return (
    <>
      <Header />
      <DisplayHeading subtitle="Sign in to keep your application pipeline in sync. No password — we'll email you a 6-digit code." />

      <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) onSubmit(email.trim()) }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* OAuth placeholders — visual parity with web. chrome.identity wiring
            is a follow-up (needs Web Store publication + OAuth scope config).
            Disabled with tooltip explaining. */}
        <button type="button" className="btn-secondary" disabled title="OAuth in the extension needs chrome.identity setup — Sprint 4 follow-up" style={{ width: '100%', justifyContent: 'center' }}>
          Continue with Google
        </button>
        <button type="button" className="btn-secondary" disabled title="OAuth in the extension needs chrome.identity setup — Sprint 4 follow-up" style={{ width: '100%', justifyContent: 'center' }}>
          Continue with GitHub
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
          required
          autoFocus
          placeholder="you@work.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />

        {error && <ErrorBanner message={error} />}

        <button type="submit" className="btn-primary" disabled={busy || !email.trim()} style={{ marginTop: 6, justifyContent: 'center', padding: '8px 12px' }}>
          {busy ? 'Sending code…' : <>Send code <ArrowRight /></>}
        </button>

        <button
          type="button"
          className="link"
          disabled={!email.trim()}
          onClick={() => { if (email.trim()) onSkipToCode(email.trim()) }}
          style={{ alignSelf: 'flex-start', marginTop: 4, fontSize: 12 }}
        >
          Already have a code? Enter it →
        </button>

        {/* DEV SHORTCUT — yellow card, matches web's treatment exactly.
            Extension can't reach the web's /api/dev/login (no Vite server +
            CORS would block). The realistic shortcut for an extension is
            "skip the email send + paste the code from `pnpm dev:otp` running
            in your terminal". Same outcome (signed in without email), one
            extra terminal command. Vite strips this block from prod. */}
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
              className="btn-secondary"
              disabled={!email.trim()}
              onClick={() => { if (email.trim()) onSkipToCode(email.trim()) }}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Skip email — paste code from terminal
            </button>
            <div style={{ fontSize: 10.5, color: 'oklch(0.42 0.08 90)', lineHeight: 1.45 }}>
              Run <span style={{ fontFamily: 'var(--font-mono)', background: 'oklch(1 0 0 / 0.5)', padding: '1px 4px', borderRadius: 3 }}>pnpm dev:otp {email || '<email>'}</span> in your terminal — uses service_role to print the code without sending email. Stripped from production builds.
            </div>
          </div>
        )}
      </form>

      <div style={{ marginTop: 'auto', paddingTop: 24, fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        By continuing you agree to the terms and privacy policy. Cookies from portals never leave your browser.
      </div>
    </>
  )
}

// ── Signed-out: code-entry form ───────────────────────────────────────────
function CodeForm({ email, busy, error, onBack, onVerify }: { email: string; busy: boolean; error: string | null; onBack: () => void; onVerify: (t: string) => void }) {
  const [code, setCode] = useState('')
  return (
    <>
      <Header />
      <DisplayHeading subtitle={`A 6-digit code is on its way to ${email}. Paste it below.`} />

      <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) onVerify(code.trim()) }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ padding: 12, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 3 }}>Check your email</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Sent to <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{email}</span>
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
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="123456"
          required
          disabled={busy}
          style={{ padding: '10px 12px', fontSize: 16, fontFamily: 'var(--font-mono)', letterSpacing: '0.25em', textAlign: 'center' }}
        />

        {error && <ErrorBanner message={error} />}

        <button type="submit" className="btn-primary" disabled={busy || code.length < 6} style={{ marginTop: 6, justifyContent: 'center', padding: '8px 12px' }}>
          {busy ? 'Verifying…' : <>Sign in <ArrowRight /></>}
        </button>

        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.5, marginTop: 2 }}>
          Tip: in dev, run <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>pnpm dev:otp {email}</span> in your terminal to print the code without waiting for email.
        </div>

        <button type="button" className="link" onClick={onBack} style={{ alignSelf: 'flex-start', marginTop: 4, fontSize: 12 }}>
          Use a different email →
        </button>
      </form>
    </>
  )
}

// ── Signed-in: resume list + Use → fill (preserved from PR #67) ───────────
type DbResume = {
  id: string
  name: string
  parsed_json: any
  is_current: boolean
  created_at: string
}

function SignedIn({ email, onSignOut, busy, error }: { email: string; onSignOut: () => void; busy: boolean; error: string | null }) {
  const [resumes, setResumes] = useState<DbResume[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [fillingId, setFillingId] = useState<string | null>(null)
  const [fillNotice, setFillNotice] = useState<string | null>(null)
  const needsAuthAt = useNeedsAuth()
  const fatalState = useFatalState()

  useEffect(() => {
    ;(async () => {
      try {
        const client = auth.getSupabase()
        const { data, error: e } = await client
          .from('resumes')
          .select('id, name, parsed_json, is_current, created_at')
          .order('is_current', { ascending: false })
          .order('created_at', { ascending: false })
        if (e) throw new Error(e.message)
        setResumes(data ?? [])
      } catch (e) {
        setLoadErr(toErr(e))
        setResumes([])
      }
    })()
  }, [])

  async function fillWith(resume: DbResume) {
    setFillingId(resume.id); setFillNotice(null)
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      if (!tab?.id) throw new Error('No active tab found')
      chrome.tabs.sendMessage(tab.id, { action: 'fill', resume: resume.parsed_json }, () => {
        const err = chrome.runtime.lastError
        if (err) {
          setFillNotice(`Couldn't reach the page (${err.message || 'no content script'}). Make sure you're on a job-application form.`)
        } else {
          setFillNotice(`Filling with "${resume.name}"…`)
        }
        setFillingId(null)
      })
    } catch (e) {
      setFillNotice(toErr(e))
      setFillingId(null)
    }
  }

  return (
    <>
      <Header />

      <div style={{ padding: 12, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signed in</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{email}</div>
      </div>

      {fatalState && (
        <FatalBanner
          error={fatalState.error}
          at={fatalState.at}
          onDismiss={async () => {
            // User acknowledged — clear the sentinel. SW will set it
            // again on the next fatal push, so dismissal isn't lossy:
            // the banner reappears if the bug recurs.
            try { await chrome.storage.local.remove(FATAL_STATE_KEY) } catch { /* ignore */ }
          }}
        />
      )}
      {needsAuthAt && (
        <ReauthBanner
          detectedAt={needsAuthAt}
          onReauth={async () => {
            // Clear the sentinel optimistically before signing out. Without
            // this, the banner re-appears the instant the user signs back
            // in (SignedIn remounts → useNeedsAuth reads → sentinel still
            // there, SW hasn't had a chance to attempt a fresh push yet)
            // — looks broken even though a push is seconds away.
            try { await chrome.storage.local.remove(NEEDS_AUTH_KEY) } catch { /* ignore */ }
            onSignOut()
          }}
        />
      )}

      <div>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Your resumes {resumes && `(${resumes.length})`}
        </div>
        {resumes === null && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Loading…</div>}
        {resumes && resumes.length === 0 && (
          <div style={{ padding: 12, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            No resumes yet. Open Landed → Resumes to add one, then come back.
          </div>
        )}
        {resumes && resumes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {resumes.map((r) => (
              <ResumeRow key={r.id} resume={r} filling={fillingId === r.id} onFill={() => fillWith(r)} />
            ))}
          </div>
        )}
      </div>

      {fillNotice && (
        <div style={{ fontSize: 11.5, padding: 10, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6, color: 'var(--fg)', lineHeight: 1.5 }}>
          {fillNotice}
        </div>
      )}
      {loadErr && <ErrorBanner message={loadErr} />}

      <button onClick={onSignOut} disabled={busy} className="btn-secondary" style={{ marginTop: 'auto', justifyContent: 'center' }}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {error && <ErrorBanner message={error} />}
    </>
  )
}

function ResumeRow({ resume, filling, onFill }: { resume: DbResume; filling: boolean; onFill: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resume.name}</div>
          {resume.is_current && (
            <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', background: 'oklch(0.92 0.06 155)', color: 'oklch(0.40 0.13 155)', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current</span>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 2 }}>
          {new Date(resume.created_at).toLocaleDateString()}
        </div>
      </div>
      <button className="btn-primary" onClick={onFill} disabled={filling} style={{ fontSize: 11.5, padding: '6px 11px' }}>
        {filling ? 'Filling…' : 'Use'}
      </button>
    </div>
  )
}

// ── Fatal banner (SW push got a 4xx that isn't auth — schema/RLS) ─────────
//
// Triggered when pushEvents returns `fatal` (e.g. a Supabase migration
// shipped a column rename that the extension hasn't caught up to). The
// SW drops the queue + logs to console; this banner surfaces the same
// info to the user so they know to check for an extension update
// rather than silently wonder why nothing's syncing.
//
// More severe than the re-auth banner — rendered first when both are
// active. Red palette, single Dismiss control (which clears the
// sentinel; SW re-sets it on the next fatal push, so dismissal isn't
// lossy — banner reappears if the bug persists).
function FatalBanner({ error, at, onDismiss }: { error: string; at: string; onDismiss: () => void }) {
  let when: string
  try {
    const d = new Date(at)
    when = Number.isNaN(+d) ? 'recently' : d.toLocaleTimeString()
  } catch { when = 'recently' }
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        padding: 12,
        background: 'oklch(0.96 0.06 28)',
        border: '0.5px solid oklch(0.82 0.10 28)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'oklch(0.40 0.18 28)' }}>
        Sync is misconfigured
      </div>
      <div style={{ fontSize: 11.5, color: 'oklch(0.40 0.14 28)', lineHeight: 1.5 }}>
        Your pending events couldn't sync (detected {when}) and were dropped
        to keep the queue from growing without bound. The most likely cause
        is an extension update — check the Web Store, or reach out if you
        keep seeing this.
      </div>
      <details style={{ fontSize: 10.5, color: 'oklch(0.45 0.10 28)' }}>
        <summary style={{ cursor: 'pointer' }}>Details</summary>
        <code style={{
          display: 'block', marginTop: 4, padding: 6,
          background: 'oklch(0.98 0.02 28)', borderRadius: 4,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          wordBreak: 'break-all',
        }}>{error}</code>
      </details>
      <button
        type="button"
        className="btn-secondary"
        onClick={onDismiss}
        style={{ alignSelf: 'flex-start', fontSize: 11.5, padding: '6px 11px' }}
      >
        Dismiss
      </button>
    </div>
  )
}

// ── Re-auth banner (signedIn but SW push got 401/403) ─────────────────────
//
// Visible only when the SW has staged events that PostgREST rejected on
// auth grounds. We pair "you appear signed in locally" with "the server
// disagrees" to nudge a re-auth. Sign-out + sign-in is the simplest fix
// (it forces a fresh JWT); silently refreshing the existing session is a
// #29.x followup once chrome.alarms-based token refresh lands.
function ReauthBanner({ detectedAt, onReauth }: { detectedAt: string; onReauth: () => void }) {
  let when: string
  try {
    const d = new Date(detectedAt)
    when = Number.isNaN(+d) ? 'recently' : d.toLocaleTimeString()
  } catch { when = 'recently' }
  return (
    // role="alert" + aria-live="polite" is intentional: role="alert"
    // implies aria-live="assertive" by default, but this message is a
    // nudge, not an emergency — polite waits for the user to finish
    // current speech rather than interrupting.
    <div
      role="alert"
      aria-live="polite"
      style={{
        padding: 12,
        background: 'oklch(0.97 0.04 80)',
        border: '0.5px solid oklch(0.85 0.08 80)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'oklch(0.40 0.13 80)' }}>
        Sync session expired
      </div>
      <div style={{ fontSize: 11.5, color: 'oklch(0.40 0.10 80)', lineHeight: 1.5 }}>
        Some portal events couldn't sync (detected {when}). Sign in again to push them — your queue is preserved.
      </div>
      <button
        type="button"
        className="btn-primary"
        onClick={onReauth}
        style={{ alignSelf: 'flex-start', fontSize: 11.5, padding: '6px 11px' }}
      >
        Sign in again
      </button>
    </div>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────
function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      fontSize: 11.5, color: 'oklch(0.45 0.15 30)',
      padding: '8px 10px', background: 'oklch(0.97 0.03 30)',
      border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
      lineHeight: 1.4,
    }}>
      {message}
    </div>
  )
}

function toErr(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
