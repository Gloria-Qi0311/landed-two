// Ask Agent — a side panel on Applications (like Feishu Bitable's AI panel):
// chat with your own agent, running on your computer through the Landed
// daemon. Not set up yet → the panel walks you through connecting a
// computer; computer offline → how to start it; ready → just chat. When
// the agent proposes a search brief, it shows as a card: confirm it and
// every connected agent searches; results land in the Leads column.
// The gear switches to agent settings (computer, cloud agents, email updates).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { extractBrief } from '@landed/schema/search-brief'
import { Icon } from './primitives'
import { Markdown } from './markdown'
import { BriefCard, SearchStatus } from './search-brief'
import { PairingError, PairingSteps, RuntimePanel, usePairing } from './runtime-panel'
import { AgentSettings } from './agent-settings'
import { useAuth } from '../lib/auth'
import { useAgentChat } from '../lib/agent-chat'
import { useRuntimes, type Runtime } from '../hooks/runtimes'

export type AgentPanelView = 'chat' | 'settings'

const SUGGESTIONS = [
  'Help me work out what jobs to look for',
  "I'm a product manager with 3 years' experience — which roles fit me?",
]

export function AgentPanel({ view, onView, onClose }: {
  view: AgentPanelView
  onView: (v: AgentPanelView) => void
  onClose: () => void
}) {
  const user = useAuth((s) => s.user)!
  const offline = useAuth((s) => s.offline || s.unreachable)
  const runtimes = useRuntimes()
  const chat = useAgentChat()
  useEffect(() => chat.load(user.id), [user.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // A pairing that never connected (command never run) counts as not set up.
  const paired = (runtimes.data ?? []).filter((r) => !r.revoked_at && r.last_seen_at)
  const ready = paired.find((r) => r.online && r.agents.length > 0)
  const agent = ready?.agents[0]

  return (
    <aside aria-label="Ask Agent" style={{
      width: 420, flexShrink: 0, borderLeft: '0.5px solid var(--border)', background: 'var(--surface)',
      display: 'flex', flexDirection: 'column', minHeight: 0, animation: 'slideIn 160ms ease',
    }}>
      <header style={{ padding: '12px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={15} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{view === 'settings' ? 'Agent settings' : 'Ask Agent'}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: ready ? 'oklch(0.65 0.17 155)' : 'var(--border-strong)' }} />
            {ready && agent ? `${agent.label} on ${ready.name}` : paired.length ? `${paired[0].name} is offline` : 'Not connected yet'}
          </div>
        </div>
        {view === 'chat' && chat.turns.length > 0 && (
          <IconButton title="New chat" onClick={() => chat.newChat()} icon="plus" />
        )}
        <IconButton title={view === 'settings' ? 'Back to chat' : 'Agent settings'} onClick={() => onView(view === 'settings' ? 'chat' : 'settings')}
          icon={view === 'settings' ? 'arrowRight' : 'settings'} active={view === 'settings'} />
        <IconButton title="Close" onClick={onClose} icon="x" />
      </header>

      {view === 'settings' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}><AgentSettings /></div>
      ) : offline ? (
        <Centered>Landed's server can't be reached right now, so your agent can't either. Try again in a moment.</Centered>
      ) : runtimes.isLoading ? (
        <Centered>Loading…</Centered>
      ) : ready && agent ? (
        <Chat runtime={ready} agentId={agent.id} agentLabel={agent.label} />
      ) : paired.length > 0 ? (
        <Offline runtime={paired[0]} />
      ) : (
        <Setup />
      )}
    </aside>
  )
}

function IconButton({ title, onClick, icon, active }: { title: string; onClick: () => void; icon: string; active?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="icon-btn" style={{
      background: active ? 'var(--surface-3)' : 'transparent', border: 'none', color: 'var(--fg-muted)',
      cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex',
    }}>
      <Icon name={icon} size={14} />
    </button>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ padding: 24, fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>{children}</div>
}

/** Not configured yet: explain, then pair a computer right here. */
function Setup() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Connect your own AI agent first</div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        Ask Agent talks to the agent you already use — Claude Code today — running on your computer, on your own
        subscription. Connect that computer once and you can chat here any time: shape your job search, then let the
        agent go find roles for you.
      </div>
      <RuntimePanel />
    </div>
  )
}

/** Paired, but the daemon isn't running. `start` only works on the computer
 *  that ran `connect` (it reuses ~/.landed/config.json), so offer re-pairing
 *  right here for every other case. */
function Offline({ runtime }: { runtime: Runtime }) {
  const [copied, setCopied] = useState(false)
  const { pairing, start, cancel, pending, error } = usePairing()
  const muted = { fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 } as const
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{runtime.name} is offline</div>
      <div style={muted}>
        On {runtime.name}, start the Landed daemon from the Landed repo folder and this panel connects by itself:
      </div>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, padding: '8px 10px', borderRadius: 6, background: 'var(--surface-2)', border: '0.5px solid var(--border)' }}>
        pnpm landed start
      </code>
      <div>
        <button type="button" className="btn-secondary" onClick={async () => { await navigator.clipboard.writeText('pnpm landed start').catch(() => {}); setCopied(true) }}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <div style={{ ...muted, marginTop: 10, paddingTop: 12, borderTop: '0.5px solid var(--border-subtle)' }}>
        It says <b>“Not paired yet”</b>, or you're on a different computer? Connect this one instead — it takes one command.
      </div>
      {error && <PairingError error={error} />}
      {pairing ? <PairingSteps token={pairing.token} onCancel={cancel} /> : (
        <div>
          <button type="button" className="btn-primary" disabled={pending} onClick={start}>
            <Icon name="plus" size={12} /> Connect this computer
          </button>
        </div>
      )}
    </div>
  )
}

function Chat({ runtime, agentId, agentLabel }: { runtime: Runtime; agentId: string; agentLabel: string }) {
  const { turns, send } = useAgentChat()
  const [draft, setDraft] = useState('')
  const busy = turns.some((t) => t.pending)
  const scroller = useRef<HTMLDivElement>(null)
  const last = turns[turns.length - 1]
  // Only the newest brief in the conversation can be confirmed.
  let latestBrief = -1
  turns.forEach((t, i) => {
    if (t.role === 'agent' && !t.error && !t.pending && extractBrief(t.text).brief) latestBrief = i
  })

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns.length, last?.text])

  const submit = (text = draft) => {
    if (!text.trim() || busy) return
    setDraft('')
    void send(runtime.id, agentId, text)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; never send mid-IME composition (Chinese/Japanese input).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <>
      <SearchStatus />
      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {turns.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
              You're talking to {agentLabel} on {runtime.name}. Start with what you're looking for — it'll ask what it needs.
            </div>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => submit(s)} className="btn-secondary"
                style={{ justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal', lineHeight: 1.4 }}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} style={{
            alignSelf: t.role === 'user' ? 'flex-end' : 'stretch', maxWidth: t.role === 'user' ? '85%' : '100%',
            padding: t.role === 'user' ? '7px 10px' : '2px 0', borderRadius: 8, fontSize: 12.5,
            background: t.role === 'user' ? 'var(--surface-3)' : 'transparent',
            color: t.error ? 'oklch(0.45 0.15 30)' : 'var(--fg)', whiteSpace: t.role === 'user' ? 'pre-wrap' : undefined,
          }}>
            {t.tools?.length ? (
              <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="search" size={10} /> {[...new Set(t.tools)].map((n) => (n === 'WebSearch' ? 'searched the web' : n === 'WebFetch' ? 'read a page' : n)).join(' · ')}
              </div>
            ) : null}
            {t.role === 'agent' && !t.error ? <AgentReply text={t.text} latest={i === latestBrief} /> : t.text}
          </div>
        ))}
      </div>
      <div style={{ padding: 10, borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} rows={2}
          placeholder={`Message ${agentLabel}…`}
          style={{ flex: 1, resize: 'none', padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit', lineHeight: 1.5, maxHeight: 140 }} />
        <button type="button" className="btn-primary" onClick={() => submit()} disabled={busy || !draft.trim()}
          style={{ opacity: busy || !draft.trim() ? 0.6 : 1 }}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </>
  )
}

/** An agent reply: Markdown, with a proposed search brief shown as a card. */
function AgentReply({ text, latest }: { text: string; latest: boolean }) {
  if (!text) return <span style={{ color: 'var(--fg-muted)' }}>Thinking…</span>
  const reply = extractBrief(text)
  return (
    <>
      {reply.text && <Markdown text={reply.text} />}
      {reply.drafting && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Writing up your search brief…</div>}
      {reply.brief && <BriefCard brief={reply.brief} latest={latest} />}
    </>
  )
}
