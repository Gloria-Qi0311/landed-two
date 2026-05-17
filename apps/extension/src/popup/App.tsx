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
      onSkipToCode={(email) => {
        // Skip the send step entirely; user already has a code from elsewhere
        // (terminal `pnpm dev:otp`, previous send, etc).
        setError(null)
        setState({ kind: 'codeSent', email })
      }}
    />
  )
}

// Brand mark — verbatim port of LandedMark from apps/web/src/components/primitives.jsx.
// Keep in lockstep with the web version; design system parity is the goal.
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
      <LandedMark size={20} />
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
        Landed
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>extension</span>
    </div>
  )
}

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
      <div style={{ color: 'var(--fg-muted)' }}>
        Sign in to use Landed across web + extension. No password — we'll email a 6-digit code.
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) onSubmit(email.trim()) }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoFocus />
        <button className="primary" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send sign-in code'}
        </button>
        {/* Skip-to-code bypass — same as the web app's "Already have a code?" link.
            Useful when (a) email rate-limited, (b) you ran `pnpm dev:otp <email>`
            in the terminal and already have the code, (c) you got the code from
            a previous send that didn't pop the popup. */}
        <button
          type="button"
          onClick={() => { if (email.trim()) onSkipToCode(email.trim()) }}
          disabled={busy || !email.trim()}
          style={{ fontSize: 11, color: 'var(--fg-muted)', background: 'transparent', border: 0, padding: 4, cursor: 'pointer', textAlign: 'center', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
        >
          Already have a code? Enter it →
        </button>
      </form>
      {/* DEV-only hint: tells you how to bypass email entirely during dev.
          Vite strips this whole block from production builds. */}
      {import.meta.env.DEV && (
        <div style={{ padding: 8, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 6, fontSize: 10.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--fg)' }}>Dev tip:</strong> hitting the Supabase email rate limit?
          Run <span style={{ fontFamily: 'var(--font-mono)' }}>pnpm dev:otp {email || '&lt;email&gt;'}</span> in your terminal
          (uses service_role to print the code), then click "Already have a code?" above.
        </div>
      )}
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
      // content.js's chrome.runtime.onMessage handler gates on
      // msg.action === 'fill' (see content.js:591). Sending bare { resume }
      // silently no-ops because the listener has no matching branch.
      chrome.tabs.sendMessage(tab.id, { action: 'fill', resume: resume.parsed_json }, () => {
        // chrome.runtime.lastError fires when no content script is loaded
        // (chrome://, file://, the new-tab page, etc). Surface gracefully.
        const err = chrome.runtime.lastError
        if (err) {
          setFillNotice(`Couldn't reach the page (${err.message || 'no content script'}). Make sure you're on a job-application form.`)
        } else {
          setFillNotice(`Filling with "${resume.name}"…`)
          setTimeout(() => window.close(), 400)
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
      <div style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signed in</div>
        <div style={{ fontFamily: 'var(--font-mono)' }}>{email}</div>
      </div>

      <div>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Your resumes {resumes && `(${resumes.length})`}
        </div>
        {resumes === null && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Loading…</div>}
        {resumes && resumes.length === 0 && (
          <div style={{ padding: 10, background: 'var(--surface-2)', border: '0.5px dashed var(--border)', borderRadius: 6, fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            No resumes yet. Open Landed → Resumes to add one, then come back.
          </div>
        )}
        {resumes && resumes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {resumes.map((r) => (
              <ResumeRow key={r.id} resume={r} filling={fillingId === r.id} onFill={() => fillWith(r)} />
            ))}
          </div>
        )}
      </div>

      {fillNotice && <div style={{ fontSize: 11, padding: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 6, color: 'var(--fg)' }}>{fillNotice}</div>}
      {loadErr && <ErrorBanner message={loadErr} />}
      <button onClick={onSignOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
      {error && <ErrorBanner message={error} />}
    </>
  )
}

function ResumeRow({ resume, filling, onFill }: { resume: DbResume; filling: boolean; onFill: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resume.name}</div>
          {resume.is_current && (
            <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', background: '#dcfce7', color: 'var(--success)', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current</span>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
          {new Date(resume.created_at).toLocaleDateString()}
        </div>
      </div>
      <button className="primary" onClick={onFill} disabled={filling} style={{ fontSize: 11, padding: '5px 9px' }}>
        {filling ? 'Filling…' : 'Use'}
      </button>
    </div>
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
