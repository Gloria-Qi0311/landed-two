// Account surfaces for local-first Landed: turning Landed Cloud on/off,
// restoring backups, and the notices shown when a Cloud session can't be
// used. The flows themselves live in lib/cloud.ts; these are the dialogs.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from './primitives'
import { useAuth } from '../lib/auth'
import { leaveCloud, restoreBackup, summarize, turnOnCloud } from '../lib/cloud'
import { localStore, type Snapshot } from '../lib/store'

const FIELD = {
  label: { fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 },
  input: { padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' },
} as const

function Dialog({ icon, title, onClose, children, footer, width = 420 }: {
  icon: string
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  width?: number
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'oklch(0.18 0.01 240 / 0.45)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '12vh', animation: 'slideIn 160ms ease',
      }}
    >
      <div role="dialog" aria-label={title} style={{
        width, maxWidth: 'calc(100vw - 32px)', background: 'var(--surface)',
        border: '0.5px solid var(--border)', borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.22)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name={icon} size={15} stroke={2} />
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="icon-btn" style={{
            marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)',
            cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex',
          }}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5, lineHeight: 1.55 }}>
          {children}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {footer}
        </div>
      </div>
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      fontSize: 11.5, color: 'oklch(0.45 0.15 30)', padding: '6px 10px',
      background: 'oklch(0.97 0.03 30)', border: '0.5px solid oklch(0.88 0.06 30)', borderRadius: 6,
    }}>{message}</div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: '9px 11px', background: 'var(--surface-2)', border: '0.5px solid var(--border)',
      borderRadius: 8, fontSize: 12, color: 'var(--fg-muted)',
    }}>{children}</div>
  )
}

// ── Turn on Landed Cloud ─────────────────────────────────────────────────

export function TurnOnCloudDialog({ onClose, signIn = false }: { onClose: () => void; signIn?: boolean }) {
  const [isSignup, setIsSignup] = useState(!signIn)
  const [email, setEmail] = useState(() => localStorage.getItem('landed:last-email') || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onDevice, setOnDevice] = useState<{ applications: number; resumes: number; total: number } | null>(null)

  useEffect(() => {
    localStore.exportSnapshot().then((s) => setOnDevice(summarize(s))).catch(() => {})
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await turnOnCloud({ email: email.trim(), password, isSignup })
      localStorage.setItem('landed:last-email', email.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const ready = !!email.trim() && password.length > 0
  return (
    <Dialog
      icon="cloud"
      title={isSignup ? 'Turn on Landed Cloud' : 'Sign in to Landed Cloud'}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="cloud-form" className="btn-primary" disabled={busy || !ready} style={{ opacity: busy || !ready ? 0.6 : 1 }}>
          {busy ? 'Working…' : isSignup ? 'Create account & sync' : 'Sign in & sync'}
        </button>
      </>}
    >
      <div style={{ color: 'var(--fg-muted)' }}>
        Sync your pipeline across devices and let the extension sync portals in the background.
        Without Cloud, everything stays in this browser.
      </div>
      {onDevice && onDevice.total > 0 && (
        <Note>
          <strong style={{ color: 'var(--fg)' }}>{onDevice.applications} applications</strong>
          {onDevice.resumes > 0 && <> and <strong style={{ color: 'var(--fg)' }}>{onDevice.resumes} resumes</strong></>}
          {' '}on this device will move to your Cloud account{isSignup ? '' : ' and merge with what is already there'}.
        </Note>
      )}
      <form id="cloud-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="cloud-email" style={FIELD.label}>Email</label>
        <input id="cloud-email" type="email" autoComplete="email" required value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@work.com" style={FIELD.input} autoFocus={!email} />
        <label htmlFor="cloud-password" style={{ ...FIELD.label, marginTop: 4 }}>Password</label>
        <input id="cloud-password" type="password" required value={password}
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          minLength={isSignup ? 8 : undefined} placeholder={isSignup ? 'At least 8 characters' : ''}
          onChange={(e) => setPassword(e.target.value)} style={FIELD.input} autoFocus={!!email} />
      </form>
      {error && <ErrorBox message={error} />}
      <button type="button" onClick={() => { setIsSignup(!isSignup); setError(null) }} style={{
        alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
        color: 'var(--accent)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
      }}>
        {isSignup ? 'Already have a Cloud account? Sign in →' : 'New to Landed Cloud? Create an account →'}
      </button>
    </Dialog>
  )
}

// ── Leave Landed Cloud ───────────────────────────────────────────────────

export function LeaveCloudDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await leaveCloud(password)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      icon="device"
      title="Move data back to this device"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="leave-form" className="btn-primary" disabled={busy || !password}
          style={{ opacity: busy || !password ? 0.6 : 1, background: 'oklch(0.5 0.16 30)', borderColor: 'oklch(0.5 0.16 30)' }}>
          {busy ? 'Moving…' : 'Move & delete Cloud account'}
        </button>
      </>}
    >
      <div>
        Everything in your Cloud account is copied into this browser, then the Cloud account and all of
        its data are <strong>permanently deleted</strong>.
      </div>
      <Note>Other devices signed in to this account will lose access. Export a backup first if you want an extra copy.</Note>
      <form id="leave-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="leave-password" style={FIELD.label}>Confirm your password</label>
        <input id="leave-password" type="password" autoComplete="current-password" required autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} style={FIELD.input} />
      </form>
      {error && <ErrorBox message={error} />}
    </Dialog>
  )
}

// ── Restore a backup file ────────────────────────────────────────────────

export function RestoreBackupDialog({ snapshot, onClose, onRestored }: {
  snapshot: Snapshot
  onClose: () => void
  onRestored: () => void
}) {
  const inCloud = useAuth((s) => !!s.user)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const counts = summarize(snapshot)

  const restore = async () => {
    setBusy(true)
    setError(null)
    try {
      await restoreBackup(snapshot)
      onRestored()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      icon="upload"
      title="Restore backup"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={restore} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Restoring…' : inCloud ? 'Merge into Cloud' : 'Replace data on this device'}
        </button>
      </>}
    >
      <div>
        Backup from <strong>{new Date(snapshot.exported_at).toLocaleString()}</strong>:{' '}
        {counts.applications} applications, {counts.resumes} resumes.
      </div>
      <Note>
        {inCloud
          ? 'Rows are merged into your Cloud account; anything already there is kept.'
          : 'Everything currently on this device is replaced by the backup.'}
      </Note>
      {error && <ErrorBox message={error} />}
    </Dialog>
  )
}

// ── Notices when Cloud can't be used ─────────────────────────────────────

export function CloudNotice({ onSignIn }: { onSignIn: () => void }) {
  const unreachable = useAuth((s) => s.unreachable)
  const sessionExpired = useAuth((s) => s.sessionExpired)
  const hydrate = useAuth((s) => s.hydrate)
  const setUser = useAuth((s) => s.setUser)
  if (!unreachable && !sessionExpired) return null
  return (
    <div role="status" style={{
      margin: '10px 28px 0', padding: '9px 12px', borderRadius: 8, fontSize: 12,
      background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Icon name="cloud" size={14} />
      <span style={{ flex: 1 }}>
        {unreachable
          ? "Can't reach Landed Cloud right now — your data is safe there. Try again in a moment."
          : "Your Landed Cloud session ended — you're seeing this device's local data. Sign in again to see your Cloud data."}
      </span>
      {unreachable ? <>
        <button type="button" className="btn-secondary" onClick={() => setUser(null)}>Use this device only</button>
        <button type="button" className="btn-secondary" onClick={() => hydrate()}>Retry</button>
      </> : <button type="button" className="btn-secondary" onClick={onSignIn}>Sign in</button>}
    </div>
  )
}
