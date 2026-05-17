// Landed extension popup — React rewrite shell.
//
// SCOPE OF THIS PR (#29): bundler scaffold + sign-in / sign-out only.
// The bulk of the old popup.js (resume picker, fill button, AI-takeover,
// label-mapping editor — ~696 LOC) lands in #29.1 followup PRs.
//
// Auth wiring uses lib/auth.js from #28. Three states:
//   loading  → spinner placeholder while getSession() resolves
//   signedOut → "Sign in with Landed" → email input → 6-digit OTP input
//   signedIn  → email pill + "Sign out" + placeholder for the rest of the UI
import React, { useEffect, useState } from 'react'
// lib/auth.js is a vanilla CJS+IIFE module from #28; types declared at
// apps/extension/lib/auth.d.ts so this import typechecks cleanly.
import * as auth from '@lib/auth.js'

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'codeSent'; email: string }
  | { kind: 'signedIn'; email: string }

export function App() {
  const [state, setState] = useState<AuthState>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Initial session check + onAuthChange subscription.
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
    return <div style={{ color: 'var(--fg-muted)', padding: '20px 0', textAlign: 'center' }}>Loading…</div>
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
            // onAuthChange will flip to signedIn on success
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
    />
  )
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--fg)' }}>Landed</div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>extension</div>
    </div>
  )
}

function EmailForm({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (e: string) => void }) {
  const [email, setEmail] = useState('')
  return (
    <>
      <Header />
      <div style={{ color: 'var(--fg-muted)' }}>Sign in to use Landed across web + extension.</div>
      <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) onSubmit(email.trim()) }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoFocus />
        <button className="primary" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send sign-in code'}
        </button>
      </form>
      {error && <ErrorBanner message={error} />}
    </>
  )
}

function CodeForm({ email, busy, error, onBack, onVerify }: { email: string; busy: boolean; error: string | null; onBack: () => void; onVerify: (t: string) => void }) {
  const [code, setCode] = useState('')
  return (
    <>
      <Header />
      <div style={{ color: 'var(--fg-muted)', lineHeight: 1.5 }}>
        A 6-digit code is on its way to <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{email}</span>.
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) onVerify(code.trim()) }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input type="text" required placeholder="123456" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={busy} autoFocus style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.15em', fontSize: 16, textAlign: 'center' }} />
        <button className="primary" type="submit" disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button type="button" onClick={onBack} disabled={busy} style={{ fontSize: 11 }}>← Use a different email</button>
      </form>
      {error && <ErrorBanner message={error} />}
    </>
  )
}

function SignedIn({ email, onSignOut, busy, error }: { email: string; onSignOut: () => void; busy: boolean; error: string | null }) {
  return (
    <>
      <Header />
      <div style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signed in</div>
        <div style={{ fontFamily: 'var(--font-mono)' }}>{email}</div>
      </div>
      <div style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 6, fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
        Resume picker + fill button land in PR #29.1 (this PR is the bundler + auth shell only).
      </div>
      <button onClick={onSignOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
      {error && <ErrorBanner message={error} />}
    </>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: 8, background: '#fef2f2', border: '0.5px solid #fecaca', borderRadius: 6, color: 'var(--danger)', fontSize: 11.5, lineHeight: 1.4 }}>
      {message}
    </div>
  )
}

function toErr(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
