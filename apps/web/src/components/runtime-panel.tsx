// "Your computer": pair the Landed daemon and see which local agents it
// found. Used by the Agent page (setup state + settings). Tasks run on
// the user's machine with their own subscription; Landed only relays.
import { useEffect, useState } from 'react'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { usePairRuntime, useRemoveRuntime, useRuntimes, type Runtime } from '../hooks/runtimes'

const muted = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 } as const

/** Pair a new computer: creates the key, then polls until the daemon connects. */
export function usePairing() {
  const [pairing, setPairing] = useState<{ runtime: Runtime; token: string } | null>(null)
  const runtimes = useRuntimes({ poll: !!pairing })
  const pair = usePairRuntime()
  const pairedNow = pairing && runtimes.data?.find((r) => r.id === pairing.runtime.id && r.online)

  useEffect(() => {
    if (pairedNow) setPairing(null)
  }, [pairedNow])

  return {
    pairing,
    start: async () => setPairing(await pair.mutateAsync(navigator.platform.startsWith('Mac') ? 'My Mac' : 'My computer')),
    cancel: () => setPairing(null),
    pending: pair.isPending,
    error: pair.error as Error | null,
  }
}

export function RuntimePanel() {
  const { pairing, start, cancel, pending, error } = usePairing()
  const runtimes = useRuntimes()
  const list = (runtimes.data ?? []).filter((r) => !r.revoked_at)

  return (
    <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="device" size={14} />
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Your computer</div>
        {!pairing && (
          <button type="button" className="btn-secondary" style={{ marginLeft: 'auto' }} disabled={pending} onClick={start}>
            <Icon name="plus" size={12} /> Connect this computer
          </button>
        )}
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={muted}>
          Run Landed's AI work with the agents already on your computer — Claude Code today, Codex and Gemini CLI next.
          It uses your own subscription, so there's no extra cost, and the work happens on your machine; Landed only passes messages through.
        </div>
        {error && <PairingError error={error} />}
        {pairing && <PairingSteps token={pairing.token} onCancel={cancel} />}
        {list.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {list.map((r, i) => <RuntimeRow key={r.id} runtime={r} first={i === 0} />)}
          </div>
        )}
      </div>
    </section>
  )
}

export function PairingError({ error }: { error: Error }) {
  return <div role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{error.message}</div>
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
const MAC_DOWNLOAD = '/api/downloads/landed-mac.zip'

/** The link Landed for Mac handles (apps/daemon/src/mac.ts: it asks the user,
 *  then pairs and starts the background service). */
export const connectLink = (token: string) =>
  `landed://connect?server=${encodeURIComponent(window.location.origin)}&token=${encodeURIComponent(token)}`

/** Pairing, one click on a Mac: open Landed for Mac with the new key. If it
 *  isn't installed yet, offer the one-time download; a terminal stays an option. */
export function PairingSteps({ token, onCancel }: { token: string; onCancel: () => void }) {
  const command = `pnpm landed connect --server ${window.location.origin} --token ${token}`
  const [copied, setCopied] = useState(false)
  const [stuck, setStuck] = useState(!isMac)
  const [terminal, setTerminal] = useState(!isMac)
  const open = () => { window.location.href = connectLink(token) }

  useEffect(() => {
    if (!isMac) return
    open()
    const timer = setTimeout(() => setStuck(true), 7000)
    return () => clearTimeout(timer)
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const box = { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)' } as const
  return (
    <div style={box}>
      {isMac && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 500 }}>
          <span style={{ display: 'flex', color: 'var(--accent)', animation: 'pulse 1.6s ease-in-out infinite' }}><Icon name="device" size={14} /></span>
          Opening Landed on this Mac — click <b>Connect</b> in the dialog.
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ marginLeft: 'auto', fontSize: 11.5 }}>Cancel</button>
        </div>
      )}
      {isMac && stuck && (
        <div style={{ ...muted, display: 'flex', flexDirection: 'column', gap: 8, borderTop: '0.5px solid var(--border-subtle)', paddingTop: 10 }}>
          <div style={{ color: 'var(--fg)', fontWeight: 500 }}>Nothing opened? Get Landed for Mac — it's a one-time step:</div>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>
              <a className="btn-primary" href={MAC_DOWNLOAD} download style={{ textDecoration: 'none', display: 'inline-flex', fontSize: 12 }}>
                <Icon name="download" size={12} /> Download Landed for Mac
              </a>
            </li>
            <li>Open the downloaded <b>Landed</b> app. It runs quietly in the background from then on, starts with your Mac, and never needs a terminal.
              The first time, macOS may say it can't check the app: choose <b>Open</b>, or go to System Settings → Privacy &amp; Security → <b>Open Anyway</b>.</li>
            <li><button type="button" className="btn-secondary" onClick={open} style={{ fontSize: 12 }}>Try connecting again</button></li>
          </ol>
        </div>
      )}
      {isMac && (
        <button type="button" onClick={() => setTerminal(!terminal)} style={{ ...muted, fontSize: 11.5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline' }}>
          {terminal ? 'Hide the terminal option' : 'Prefer a terminal? (Landed repo checkout)'}
        </button>
      )}
      {terminal && (
        <>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{isMac ? 'Or run this' : 'Run this'} in a terminal on the computer, from the Landed repo folder:</div>
          <code style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '8px 10px', borderRadius: 6, background: 'var(--surface)', border: '0.5px solid var(--border)', wordBreak: 'break-all' }}>
            {command}
          </code>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className={isMac ? 'btn-secondary' : 'btn-primary'} onClick={async () => { await navigator.clipboard.writeText(command).catch(() => {}); setCopied(true) }}>
              {copied ? 'Copied' : 'Copy command'}
            </button>
            {!isMac && <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>}
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginLeft: 'auto' }}>Waiting for your computer to connect…</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            The command includes this computer's key, shown only now. Needs Node 20+ and Claude Code installed and signed in.
          </div>
        </>
      )}
    </div>
  )
}

function RuntimeRow({ runtime: r, first }: { runtime: Runtime; first: boolean }) {
  const remove = useRemoveRuntime()
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: first ? 'none' : '0.5px solid var(--border-subtle)', fontSize: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: r.online ? 'oklch(0.65 0.17 155)' : 'var(--border-strong)' }} />
          {r.name}
          <span style={{ fontWeight: 400, color: r.online ? 'oklch(0.45 0.13 155)' : 'var(--fg-muted)', fontSize: 11 }}>
            {r.online ? 'Online' : r.last_seen_at ? `Offline · seen ${formatRelative(r.last_seen_at)}` : 'Waiting to connect'}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
          {r.agents.length ? r.agents.map((a) => `${a.label}${a.version ? ` ${a.version.split(' ')[0]}` : ''}`).join(' · ') : 'No agents reported yet'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {!confirming
          ? <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>Remove</button>
          : <>
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>Keep</button>
              <button type="button" className="btn-primary" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}
                style={{ background: 'oklch(0.5 0.16 30)', borderColor: 'oklch(0.5 0.16 30)' }}>Disconnect</button>
            </>}
      </div>
    </div>
  )
}
