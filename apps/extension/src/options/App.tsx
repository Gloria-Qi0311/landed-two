// Landed extension options page — React rewrite shell.
//
// SCOPE OF THIS PR (#30): bundler entry + sign-in mirror + placeholders.
// The full options surface (resume editor, LLM provider settings, label-
// mapping admin — ~1959 LOC across old options.html + options.js) ports in
// #30.1 follow-up PRs as discrete pieces.
//
// Reuses lib/auth.js from #28; shares tokens.css with the popup. Signed-out
// state shows a hint pointing the user at the toolbar popup (sign-in is the
// popup's job; options is for already-signed-in account management).
import React, { useEffect, useState } from 'react'
import * as auth from '@lib/auth.js'

type Phase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'signedIn'; email: string }

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    ;(async () => {
      try {
        const session = await auth.getSession()
        if (session?.user?.email) setPhase({ kind: 'signedIn', email: session.user.email })
        else setPhase({ kind: 'signedOut' })
      } catch (e) {
        setErr(toErr(e))
        setPhase({ kind: 'signedOut' })
      }
      unsubscribe = auth.onAuthChange((_event: string, session: any) => {
        if (session?.user?.email) setPhase({ kind: 'signedIn', email: session.user.email })
        else setPhase({ kind: 'signedOut' })
      })
    })()
    return () => { unsubscribe?.() }
  }, [])

  if (phase.kind === 'loading') {
    return <Header subtitle="Loading…" />
  }

  if (phase.kind === 'signedOut') {
    return (
      <>
        <Header subtitle="Sign in to manage your Landed account" />
        <Card title="Sign in via the toolbar popup">
          <p style={{ color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            Open the Landed extension by clicking its toolbar icon → sign in with your Landed email and password.
            Once you're signed in, this Settings page will show your account details and (in #30.1 follow-ups) your resumes, LLM provider preferences, and label-mapping overrides.
          </p>
        </Card>
        {err && <ErrorBanner message={err} />}
      </>
    )
  }

  return (
    <>
      <Header subtitle={`Signed in as ${phase.email}`} />
      <Card title="Account">
        <Row label="Email" value={phase.email} />
        <Row label="Session storage" value="chrome.storage.local" mono />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true); setErr(null)
              try { await auth.signOut() }
              catch (e) { setErr(toErr(e)) }
              finally { setBusy(false) }
            }}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </Card>
      <Card title="Coming soon">
        <ul style={{ paddingLeft: 18, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
          <li>Resume editor (port from old options.html — #30.1)</li>
          <li>LLM provider settings (OpenAI / Anthropic / Gemini API keys) — #30.1</li>
          <li>Label-mapping admin (custom field → resume-key overrides) — #30.1</li>
          <li>Multi-resume picker linked to your Landed resumes table — #32</li>
        </ul>
      </Card>
      {err && <ErrorBanner message={err} />}
    </>
  )
}

function Header({ subtitle }: { subtitle: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 22, color: 'var(--fg)' }}>Landed Settings</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>extension</div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>{subtitle}</div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg)' }}>{value}</span>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: 10, background: '#fef2f2', border: '0.5px solid #fecaca', borderRadius: 6, color: 'var(--danger)', fontSize: 12, lineHeight: 1.4 }}>
      {message}
    </div>
  )
}

function toErr(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
