// "Your computer" on the Agents page: pair the Landed daemon, see which local
// agents it found, and talk to one to check the whole path works. Tasks run
// on the user's machine with their own subscription; Landed only relays.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { runOnComputer, usePairRuntime, useRemoveRuntime, useRuntimes, type Runtime } from '../hooks/runtimes'

const muted = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 } as const

export function RuntimePanel() {
  const [pairing, setPairing] = useState<{ runtime: Runtime; token: string } | null>(null)
  const runtimes = useRuntimes({ poll: !!pairing })
  const pair = usePairRuntime()
  const list = (runtimes.data ?? []).filter((r) => !r.revoked_at)
  const pairedNow = pairing && list.find((r) => r.id === pairing.runtime.id && r.online)
  const online = list.filter((r) => r.online && r.agents.length > 0)

  useEffect(() => {
    if (pairedNow) setPairing(null)
  }, [pairedNow])

  return (
    <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="device" size={14} />
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Your computer</div>
        {!pairing && (
          <button type="button" className="btn-secondary" style={{ marginLeft: 'auto' }} disabled={pair.isPending}
            onClick={async () => setPairing(await pair.mutateAsync(navigator.platform.startsWith('Mac') ? 'My Mac' : 'My computer'))}>
            <Icon name="plus" size={12} /> Connect this computer
          </button>
        )}
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={muted}>
          Run Landed's AI work with the agents already on your computer — Claude Code today, Codex and Gemini CLI next.
          It uses your own subscription, so there's no extra cost, and the work happens on your machine; Landed only passes messages through.
        </div>
        {pair.error && <div role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{(pair.error as Error).message}</div>}
        {pairing && <PairingSteps token={pairing.token} onCancel={() => setPairing(null)} />}
        {list.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {list.map((r, i) => <RuntimeRow key={r.id} runtime={r} first={i === 0} />)}
          </div>
        )}
        {online.length > 0 && <TryIt runtime={online[0]} />}
      </div>
    </section>
  )
}

function PairingSteps({ token, onCancel }: { token: string; onCancel: () => void }) {
  const command = `pnpm landed connect --server ${window.location.origin} --token ${token}`
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 500 }}>Run this in a terminal on the computer, from the Landed repo folder:</div>
      <code style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '8px 10px', borderRadius: 6, background: 'var(--surface)', border: '0.5px solid var(--border)', wordBreak: 'break-all' }}>
        {command}
      </code>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn-primary" onClick={async () => { await navigator.clipboard.writeText(command).catch(() => {}); setCopied(true) }}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginLeft: 'auto' }}>Waiting for your computer to connect…</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        The command includes this computer's key, shown only now. Needs Node 23.6+ and Claude Code installed and signed in. Keep the terminal open — or run <code>pnpm landed start</code> any time later.
      </div>
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

type Turn = { role: 'user' | 'agent'; text: string; tools?: string[]; error?: boolean; pending?: boolean }

/** A tiny chat to prove the round trip: browser → Landed → your computer → Claude Code → back. */
function TryIt({ runtime }: { runtime: Runtime }) {
  const agent = runtime.agents[0]
  const [conversationId] = useState(() => crypto.randomUUID())
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const busy = turns.some((t) => t.pending)
  const stop = useRef<() => void>(() => {})
  useEffect(() => () => stop.current(), [])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const message = draft.trim()
    if (!message || busy) return
    setDraft('')
    setTurns((t) => [...t, { role: 'user', text: message }, { role: 'agent', text: '', pending: true }])
    const update = (fn: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)))
    stop.current = await runOnComputer(runtime.id, agent.id, 'chat', { conversation_id: conversationId, message }, (ev) => {
      if (ev.type === 'delta') update((t) => ({ ...t, text: t.text + ev.text }))
      if (ev.type === 'tool') update((t) => ({ ...t, tools: [...(t.tools ?? []), ev.name] }))
      if (ev.type === 'done') update((t) => ({ ...t, text: ev.text || t.text, pending: false }))
      if (ev.type === 'error') update((t) => ({ ...t, text: ev.message, error: true, pending: false }))
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '0.5px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 500 }}>Try it — talk to {agent.label} on {runtime.name}</div>
      {turns.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {turns.map((t, i) => (
            <div key={i} style={{
              alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '7px 10px', borderRadius: 8,
              fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              background: t.role === 'user' ? 'var(--surface-3)' : t.error ? 'oklch(0.97 0.03 30)' : 'var(--surface-2)',
              color: t.error ? 'oklch(0.45 0.15 30)' : 'var(--fg)', border: '0.5px solid var(--border)',
            }}>
              {t.tools?.length ? <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginBottom: 3 }}>used {[...new Set(t.tools)].join(', ')}</div> : null}
              {t.text || (t.pending ? '…' : '')}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. I'm a PM looking for AI roles in SF — where should I start?"
          style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit' }} />
        <button type="submit" className="btn-primary" disabled={busy || !draft.trim()} style={{ opacity: busy || !draft.trim() ? 0.6 : 1 }}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
