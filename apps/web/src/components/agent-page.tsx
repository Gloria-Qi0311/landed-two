// Agent — its own page (sidebar: Applications → Agent → My Resume). Chat
// with your own agent, running on your computer through the Landed daemon.
// Not set up yet → connect a computer here; computer offline → how to
// start it; ready → just chat. When the agent proposes a search brief, it
// shows as a card: confirm it and every connected agent searches; results
// land in the Leads column. The page also carries email watching and
// Landed's questions ("did you apply?", "no news for 3 weeks" → portal
// check). ?view=settings shows agent settings (computer, cloud agents,
// email updates).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { extractBrief } from '@landed/schema/search-brief'
import { Icon } from './primitives'
import { Markdown } from './markdown'
import { PageHeader } from './shell'
import { BriefCard, SearchStatus } from './search-brief'
import { EmailStatus } from './email-watch'
import { PanelQuestions } from './panel-questions'
import { PairingError, PairingSteps, RuntimePanel, usePairing } from './runtime-panel'
import { AgentSettings } from './agent-settings'
import { useAuth } from '../lib/auth'
import { useAgentChat } from '../lib/agent-chat'
import { useRuntimes, type Runtime } from '../hooks/runtimes'

const SUGGESTIONS = [
  'Help me work out what jobs to look for',
  "I'm a product manager with 3 years' experience — which roles fit me?",
]

/** Content column: readable width, centered on wide screens. */
const COLUMN = { width: '100%', maxWidth: 760, margin: '0 auto' } as const

export function AgentPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'settings' ? 'settings' : 'chat'
  const setView = (v: 'chat' | 'settings') => setParams(v === 'settings' ? { view: 'settings' } : {}, { replace: true })
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
    <>
      <PageHeader
        title={view === 'settings' ? 'Agent settings' : 'Agent'}
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: ready ? 'oklch(0.65 0.17 155)' : 'var(--border-strong)' }} />
            {ready && agent ? `${agent.label} on ${ready.name}, with your own subscription` : paired.length ? `${paired[0].name} is offline` : 'Not connected yet'}
          </span>
        }
        actions={
          <>
            {view === 'chat' && chat.turns.length > 0 && (
              <button className="btn-secondary" onClick={() => chat.newChat()}><Icon name="plus" size={13} /> New chat</button>
            )}
            <button className="btn-secondary" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}>
              <Icon name={view === 'settings' ? 'sparkle' : 'settings'} size={13} /> {view === 'settings' ? 'Back to chat' : 'Settings'}
            </button>
          </>
        }
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'settings' ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}><div style={COLUMN}><AgentSettings /></div></div>
        ) : offline ? (
          <Centered>Landed's server can't be reached right now, so your agent can't either. Try again in a moment.</Centered>
        ) : runtimes.isLoading ? (
          <Centered>Loading…</Centered>
        ) : ready && agent ? (
          <Chat runtime={ready} agentId={agent.id} agentLabel={agent.label} />
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}>
            <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Questions don't need an agent — ask them in every state. */}
              <PanelQuestions />
              {paired.length > 0 ? <Offline runtime={paired[0]} /> : <Setup />}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ padding: '24px 28px' }}><div style={{ ...COLUMN, fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>{children}</div></div>
}

/** Not configured yet: explain, then pair a computer right here. */
function Setup() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Connect your own AI agent first</div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        Landed talks to the agent you already use — Claude Code today — running on your computer, on your own
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{runtime.name} is offline</div>
      <div style={muted}>
        On {runtime.name}, start the Landed daemon from the Landed repo folder and this page connects by itself:
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
      <div style={{ padding: '12px 28px 0' }}>
        <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SearchStatus />
          <EmailStatus />
        </div>
      </div>
      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: '14px 28px' }}>
       <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            padding: t.role === 'user' ? '8px 12px' : '2px 0', borderRadius: 10, fontSize: 13,
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
        <PanelQuestions />
       </div>
      </div>
      <div style={{ padding: '10px 28px 16px', borderTop: '0.5px solid var(--border)' }}>
       <div style={{ ...COLUMN, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} rows={2}
          placeholder={`Message ${agentLabel}…`}
          style={{ flex: 1, resize: 'none', padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5, maxHeight: 180, borderRadius: 10 }} />
        <button type="button" className="btn-primary" onClick={() => submit()} disabled={busy || !draft.trim()}
          style={{ opacity: busy || !draft.trim() ? 0.6 : 1 }}>
          {busy ? '…' : 'Send'}
        </button>
       </div>
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
