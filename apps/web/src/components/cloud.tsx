// Account surfaces for local-first Landed: turning Landed Cloud sync on/off,
// restoring backups, and the notices shown when the server can't be reached.
// The flows themselves live in lib/cloud.ts; these are the dialogs.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from './primitives'
import { useAuth } from '../lib/auth'
import { restoreBackup, summarize, turnOffCloudSync, turnOnCloudSync } from '../lib/cloud'
import { localStoreFor, type Snapshot } from '../lib/store'

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

// ── Turn on Landed Cloud sync ────────────────────────────────────────────

export function TurnOnCloudDialog({ onClose }: { onClose: () => void }) {
  const user = useAuth((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onDevice, setOnDevice] = useState<{ applications: number; resumes: number; total: number } | null>(null)

  useEffect(() => {
    if (!user) return
    localStoreFor(user.id).exportSnapshot().then((s) => setOnDevice(summarize(s))).catch(() => {})
  }, [user])

  const turnOn = async () => {
    setBusy(true)
    setError(null)
    try {
      await turnOnCloudSync()
      onClose()
    } catch (err) {
      setError(`Nothing was changed: ${(err as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <Dialog
      icon="cloud"
      title="Turn on Landed Cloud sync"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={turnOn} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Moving data…' : 'Turn on sync'}
        </button>
      </>}
    >
      <div style={{ color: 'var(--fg-muted)' }}>
        Your pipeline moves to Landed Cloud: it follows you to every device you sign in on, and the extension
        can sync portals in the background even when no Landed tab is open.
      </div>
      {onDevice && (
        <Note>
          {onDevice.total > 0 ? <>
            <strong style={{ color: 'var(--fg)' }}>{onDevice.applications} applications</strong>
            {onDevice.resumes > 0 && <> and <strong style={{ color: 'var(--fg)' }}>{onDevice.resumes} resumes</strong></>}
            {' '}on this device will be uploaded, then removed from this browser.
          </> : 'Nothing on this device yet — new data will go straight to Landed Cloud.'}
        </Note>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>You can turn sync off any time; your data moves back to the device you do it on.</div>
      {error && <ErrorBox message={error} />}
    </Dialog>
  )
}

// ── Turn off Landed Cloud sync ───────────────────────────────────────────

export function TurnOffCloudDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await turnOffCloudSync(password)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      icon="device"
      title="Turn off Landed Cloud sync"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="sync-off-form" className="btn-primary" disabled={busy || !password}
          style={{ opacity: busy || !password ? 0.6 : 1 }}>
          {busy ? 'Moving…' : 'Move data here & turn off'}
        </button>
      </>}
    >
      <div>
        Everything in Landed Cloud is copied into this browser, then <strong>deleted from Landed Cloud</strong>.
        Your account stays — you just won't see this data on other devices anymore.
      </div>
      <Note>Want an extra copy first? Use Export backup in the account menu.</Note>
      <form id="sync-off-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="sync-off-password" style={FIELD.label}>Confirm your password</label>
        <input id="sync-off-password" type="password" autoComplete="current-password" required autoFocus
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
  const inCloud = useAuth((s) => !!s.user?.cloud_sync)
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

// ── Notice when the server can't be reached ─────────────────────────────

export function OfflineNotice() {
  const offline = useAuth((s) => s.offline)
  const unreachable = useAuth((s) => s.unreachable)
  const hydrate = useAuth((s) => s.hydrate)
  if (!offline && !unreachable) return null
  return (
    <div role="status" style={{
      margin: '10px 28px 0', padding: '9px 12px', borderRadius: 8, fontSize: 12,
      background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Icon name={unreachable ? 'cloud' : 'device'} size={14} />
      <span style={{ flex: 1 }}>
        {unreachable
          ? "Can't reach Landed Cloud right now — your data is safe there. Try again in a moment."
          : "Working offline — Landed's server can't be reached, but your data is all on this device."}
      </span>
      <button type="button" className="btn-secondary" onClick={() => hydrate()}>Retry</button>
    </div>
  )
}
