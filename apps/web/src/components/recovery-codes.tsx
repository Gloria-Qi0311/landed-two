import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { Dialog, ErrorBox, Note } from './cloud'

type RecoveryStatus = { remaining: number; created_at: string | null }
type GeneratedCodes = { codes: string[]; created_at: string }

export function RecoveryCodesDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<RecoveryStatus>('/recovery-codes').then(setStatus).catch((err) => setError(err.message))
  }, [])

  const generate = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<GeneratedCodes>('/recovery-codes', { password })
      setCodes(result.codes)
      setStatus({ remaining: result.codes.length, created_at: result.created_at })
      setPassword('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const content = codes?.join('\n') ?? ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
    } catch (err) {
      setError((err as Error).message || 'Could not copy the codes')
    }
  }
  const download = () => {
    const blob = new Blob([
      `Landed recovery codes\nGenerated ${new Date().toLocaleString()}\n\n${content}\n\nEach code works once. Keep this file somewhere private.\n`,
    ], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'landed-recovery-codes.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog
      icon="refresh"
      title="Recovery codes"
      onClose={onClose}
      width={480}
      footer={codes ? <>
        <button type="button" className="btn-secondary" onClick={download}>Download .txt</button>
        <button type="button" className="btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy all codes'}</button>
      </> : <>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="recovery-codes-form" className="btn-primary" disabled={busy || !password}
          style={{ opacity: busy || !password ? 0.6 : 1 }}>
          {busy ? 'Generating…' : status?.remaining ? 'Replace recovery codes' : 'Generate recovery codes'}
        </button>
      </>}
    >
      {codes ? <>
        <div><strong>Save these somewhere private now.</strong> Landed will not show them again.</div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 12px', padding: 12,
          background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 8,
          fontFamily: 'var(--font-mono)', fontSize: 12, userSelect: 'all',
        }}>
          {codes.map((code) => <div key={code}>{code}</div>)}
        </div>
        <Note>Each code can reset your password once. Generating another set invalidates this entire set.</Note>
      </> : <>
        <div style={{ color: 'var(--fg-muted)' }}>
          Recovery codes let you regain access even when email delivery is unavailable. Only hashed copies are stored on the server.
        </div>
        {status && (status.remaining > 0
          ? <Note>
              You have <strong style={{ color: 'var(--fg)' }}>{status.remaining} unused code{status.remaining === 1 ? '' : 's'}</strong>
              {status.created_at ? ` from ${new Date(status.created_at).toLocaleDateString()}` : ''}.
              {' '}Replacing them invalidates every old code.
            </Note>
          : <Note>You do not have recovery codes yet.</Note>)}
        <form id="recovery-codes-form" onSubmit={generate} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="recovery-current-password" style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>
            Confirm your current password
          </label>
          <input id="recovery-current-password" type="password" autoComplete="current-password" required autoFocus
            value={password} onChange={(event) => setPassword(event.target.value)}
            style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }} />
        </form>
      </>}
      {error && <ErrorBox message={error} />}
    </Dialog>
  )
}
