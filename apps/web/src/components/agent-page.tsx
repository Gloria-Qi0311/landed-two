// Agent — its own page (sidebar: Applications → Agent → Automation → My Resume). Chat
// with your own agent, running on your computer through the Landed daemon.
// Past chats are listed on the left (saved in the account's data store —
// lib/agent-chat.ts); pick one up any time. Not set up yet → connect a
// computer here; computer offline → past chats stay readable. When the
// agent proposes a search brief, it shows as a card: confirm it and every
// connected agent searches; results land in the Leads column. The page also
// carries Landed's questions ("did you apply?", "no
// news for 3 weeks" → portal check). ?view=settings shows agent settings.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { extractBrief } from '@landed/schema/search-brief'
import { extractApplications } from '@landed/schema/reported-application'
import { extractAnswers } from '@landed/schema/application-answers'
import { Icon } from './primitives'
import { Markdown } from './markdown'
import { PageHeader } from './shell'
import { EditableText } from './editable'
import { BriefCard, SearchStatus } from './search-brief'
import { PanelQuestions } from './panel-questions'
import { PairingError, PairingSteps, RuntimePanel, usePairing } from './runtime-panel'
import { AgentSettings } from './agent-settings'
import { ReportedApplicationsCard } from './reported-applications'
import { ReportedAnswersCard } from './reported-answers'
import { DuplicatesReview } from './duplicates'
import { imagesFrom, MAX_CHAT_IMAGES, prepareImage, type Attachment } from '../lib/chat-images'
import { useAuth } from '../lib/auth'
import { formatRelative } from '../lib/time'
import { deleteConversation, renameConversation, useAgentChat, type Turn } from '../lib/agent-chat'
import type { DbConversation } from '../lib/store'
import { useConversations } from '../hooks/conversations'
import { canRun, useRuntimes, type Runtime, type RuntimeAgent } from '../hooks/runtimes'

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
  const offline = useAuth((s) => s.offline || s.unreachable)
  const runtimes = useRuntimes()
  const conversations = useConversations()
  const activeId = useAgentChat((s) => s.activeId)
  const live = useAgentChat((s) => s.live)

  // A pairing that never connected (command never run) counts as not set up.
  const paired = (runtimes.data ?? []).filter((r) => !r.revoked_at && r.last_seen_at)
  // Every agent that can chat, on every online computer; the user picks one
  // (Claude Code, Codex, Gemini CLI…), remembered on this device.
  const choices = paired.filter((r) => r.online).flatMap((runtime) => runtime.agents.filter((a) => canRun(a, 'chat')).map((agent) => ({ runtime, agent })))
  const [preferred, setPreferred] = useState(readChatAgent)
  const pick = choices.find((c) => `${c.runtime.id}:${c.agent.id}` === preferred) ?? choices[0]
  const ready = pick?.runtime
  const agent = pick?.agent
  const saved = (conversations.data ?? []).find((c) => c.id === activeId)
  const hasChat = !!activeId && !!(live[activeId] || saved)

  return (
    <>
      <PageHeader
        title={view === 'settings' ? 'Agent settings' : 'Agent'}
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: ready ? 'oklch(0.65 0.17 155)' : 'var(--border-strong)' }} />
            {ready && agent && choices.length > 1 ? (
              <AgentPicker choices={choices} value={`${ready.id}:${agent.id}`} onChange={(v) => { setPreferred(v); writeChatAgent(v) }} />
            ) : ready && agent ? `${agent.label} on ${ready.name}, with your own subscription` : paired.length ? `${paired[0].name} is offline` : 'Not connected yet'}
          </span>
        }
        actions={
          <button className="btn-secondary" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}>
            <Icon name={view === 'settings' ? 'sparkle' : 'settings'} size={13} /> {view === 'settings' ? 'Back to chat' : 'Settings'}
          </button>
        }
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {view === 'settings' ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}><div style={COLUMN}><AgentSettings /></div></div>
        ) : (
          <>
            <ConversationList conversations={conversations.data ?? []} loading={conversations.isLoading} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {offline ? (
                <Centered>Landed's server can't be reached right now, so your agent can't either. Try again in a moment.</Centered>
              ) : runtimes.isLoading ? (
                <Centered>Loading…</Centered>
              ) : ready && agent ? (
                <Chat runtime={ready} agentId={agent.id} agentLabel={agent.label} saved={saved} />
              ) : hasChat ? (
                // Past chats stay readable while the computer is away.
                <Chat runtime={null} agentId="" agentLabel="your agent" saved={saved} />
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
        )}
      </div>
    </>
  )
}

// ── which agent to chat with ─────────────────────────────────────────────

const CHAT_AGENT_KEY = 'landed:chat-agent'
function readChatAgent(): string | null {
  try {
    return localStorage.getItem(CHAT_AGENT_KEY)
  } catch {
    return null
  }
}
function writeChatAgent(value: string) {
  try {
    localStorage.setItem(CHAT_AGENT_KEY, value)
  } catch {
    // private window: just this visit
  }
}

function AgentPicker({ choices, value, onChange }: {
  choices: { runtime: Runtime; agent: RuntimeAgent }[]; value: string; onChange: (value: string) => void
}) {
  const several = new Set(choices.map((c) => c.runtime.id)).size > 1
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select
        aria-label="Agent to chat with"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ font: 'inherit', fontSize: 12, color: 'var(--fg)', background: 'transparent', border: '0.5px solid var(--border)', borderRadius: 6, padding: '1px 4px' }}
      >
        {choices.map((c) => (
          <option key={`${c.runtime.id}:${c.agent.id}`} value={`${c.runtime.id}:${c.agent.id}`}>
            {c.agent.label}{several ? ` on ${c.runtime.name}` : ''}
          </option>
        ))}
      </select>
      <span>{several ? 'with your own subscription' : `on ${choices[0].runtime.name}, with your own subscription`}</span>
    </span>
  )
}

// ── chat history ──────────────────────────────────────────────────────────

const DAY = 86_400_000
function groupOf(iso: string): string {
  const startOfToday = new Date(new Date().toDateString()).getTime()
  const t = Date.parse(iso)
  if (t >= startOfToday) return 'Today'
  if (t >= startOfToday - DAY) return 'Yesterday'
  if (t >= startOfToday - 7 * DAY) return 'Previous 7 days'
  if (t >= startOfToday - 30 * DAY) return 'Previous 30 days'
  return 'Older'
}

function ConversationList({ conversations, loading }: { conversations: DbConversation[]; loading: boolean }) {
  const activeId = useAgentChat((s) => s.activeId)
  const live = useAgentChat((s) => s.live)
  const open = useAgentChat((s) => s.open)
  const newChat = useAgentChat((s) => s.newChat)
  const groups = useMemo(() => {
    const out: { label: string; items: DbConversation[] }[] = []
    for (const c of conversations) {
      const label = groupOf(c.updated_at)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [conversations])

  return (
    <aside aria-label="Chats" style={{ width: 248, flexShrink: 0, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 10px 8px' }}>
        <button type="button" className={activeId ? 'btn-secondary' : 'btn-primary'} onClick={newChat} style={{ width: '100%', justifyContent: 'center' }}>
          <Icon name="plus" size={13} /> New chat
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 10px' }}>
        {loading && <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: 8 }}>Loading…</div>}
        {!loading && conversations.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '8px 6px', lineHeight: 1.5 }}>Your chats will show up here.</div>
        )}
        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '8px 8px 4px' }}>{g.label}</div>
            {g.items.map((c) => (
              <ConversationItem key={c.id} conv={c} active={c.id === activeId}
                replying={!!live[c.id]?.turns.some((t) => t.pending)}
                title={live[c.id]?.title ?? c.title} onOpen={() => open(c)} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

function ConversationItem({ conv, active, replying, title, onOpen }: {
  conv: DbConversation; active: boolean; replying: boolean; title: string; onOpen: () => void
}) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className="sidebar-item conversation-item" title={`${title} · ${formatRelative(conv.updated_at)}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
        background: active ? 'var(--surface)' : 'transparent', boxShadow: active ? 'var(--shadow-sm)' : 'none',
        color: active ? 'var(--fg)' : 'var(--fg-muted)', fontWeight: active ? 550 : 400,
      }}>
      {replying && <span title="Replying…" style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--accent)', flexShrink: 0, animation: 'pulse 1.6s ease-in-out infinite' }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <button type="button" className="icon-btn conversation-delete" title="Delete chat" aria-label="Delete chat"
        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete “${title}”?`)) void deleteConversation(conv.id) }}
        style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}>
        <Icon name="x" size={11} />
      </button>
    </div>
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
        Landed talks to the agent you already use — Claude Code, Codex, Gemini CLI, Copilot, Cursor and other ACP
        agents — running on your computer, on your own subscription. Connect your computer once (one click on a Mac) and chat here any time: shape your job search,
        then let the agent go find roles for you.
      </div>
      <RuntimePanel />
    </div>
  )
}

/** Paired, but not connected right now. With Landed for Mac it comes back
 *  on its own when that Mac is on; otherwise connect (this) computer again. */
function Offline({ runtime }: { runtime: Runtime }) {
  const { pairing, start, cancel, pending, error } = usePairing()
  const muted = { fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 } as const
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{runtime.name} is offline</div>
      <div style={muted}>
        If Landed for Mac is installed on {runtime.name}, it reconnects by itself as soon as that Mac is on and awake —
        nothing to do here. On this computer, or if it isn't installed there, connect it now:
      </div>
      {error && <PairingError error={error} />}
      {pairing ? <PairingSteps token={pairing.token} onCancel={cancel} /> : (
        <div>
          <button type="button" className="btn-primary" disabled={pending} onClick={start}>
            <Icon name="device" size={12} /> Connect this computer
          </button>
        </div>
      )}
    </div>
  )
}

function Chat({ runtime, agentId, agentLabel, saved }: {
  /** null: the computer is away — the chat is read-only */
  runtime: Runtime | null
  agentId: string
  agentLabel: string
  saved: DbConversation | undefined
}) {
  const activeId = useAgentChat((s) => s.activeId)
  const live = useAgentChat((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const send = useAgentChat((s) => s.send)
  const turns: Turn[] = live?.turns ?? saved?.turns ?? []
  const title = live?.title ?? saved?.title
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
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
  }, [activeId, turns.length, last?.text])

  const submit = (text = draft) => {
    if ((!text.trim() && attachments.length === 0) || busy || !runtime) return
    setDraft('')
    setAttachments([])
    setAttachError(null)
    void send(runtime.id, agentId, text, saved, attachments)
  }
  // Screenshots: the paperclip, paste (⌘V) or drop.
  const attach = async (files: File[]) => {
    if (!files.length || !runtime) return
    const room = MAX_CHAT_IMAGES - attachments.length
    setAttachError(files.length > room ? `Up to ${MAX_CHAT_IMAGES} screenshots per message.` : null)
    try {
      const ready = await Promise.all(files.slice(0, Math.max(0, room)).map(prepareImage))
      setAttachments((a) => [...a, ...ready].slice(0, MAX_CHAT_IMAGES))
    } catch (e) {
      setAttachError((e as Error).message)
    }
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
      <div style={{ padding: '14px 28px 12px', borderBottom: saved || turns.length ? '1px solid var(--border-subtle)' : 'none' }}>
        <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {saved && title && (
            <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <EditableText label="chat title" value={title} onSave={(t) => t && void renameConversation(saved, t)} />
              </span>
            </div>
          )}
          <SearchStatus />
        </div>
      </div>
      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: '14px 28px' }}>
        <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {turns.length === 0 && runtime && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
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
              alignSelf: t.role === 'user' ? 'flex-end' : 'stretch', maxWidth: t.role === 'user' ? '80%' : '100%',
              padding: t.role === 'user' ? '9px 14px' : '2px 0', borderRadius: t.role === 'user' ? '16px 16px 4px 16px' : 0,
              fontSize: 13.5, lineHeight: 1.6,
              background: t.role === 'user' ? 'var(--surface)' : 'transparent', boxShadow: t.role === 'user' ? 'var(--shadow-sm)' : 'none',
              color: t.error ? 'oklch(0.45 0.15 30)' : 'var(--fg)', whiteSpace: t.role === 'user' ? 'pre-wrap' : undefined,
            }}>
              {t.tools?.length ? (
                <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="search" size={10} /> {[...new Set(t.tools)].map((n) => (n === 'WebSearch' ? 'searched the web' : n === 'WebFetch' ? 'read a page' : n)).join(' · ')}
                </div>
              ) : null}
              {t.images?.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: t.text ? 6 : 0 }}>
                  {t.images.map((img, k) => <img key={k} src={img.thumb} alt={img.name} title={img.name} style={{ height: 72, borderRadius: 6, border: '0.5px solid var(--border)', display: 'block' }} />)}
                </div>
              ) : null}
              {t.role === 'agent' && !t.error ? <AgentReply text={t.text} pending={!!t.pending} latest={i === latestBrief} /> : t.text}
            </div>
          ))}
          <PanelQuestions />
        </div>
      </div>
      <div
        style={{ padding: '8px 28px 20px', background: dragging ? 'var(--accent-soft)' : undefined }}
        onDragOver={(e) => { if (runtime && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void attach(imagesFrom(e.dataTransfer)) }}
      >
        <div style={{ ...COLUMN, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(attachments.length > 0 || attachError || dragging) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {attachments.map((a, k) => (
                <span key={k} style={{ position: 'relative', display: 'inline-flex' }}>
                  <img src={a.thumb} alt={a.name} style={{ height: 56, borderRadius: 6, border: '0.5px solid var(--border)' }} />
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((list) => list.filter((_, j) => j !== k))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: '0.5px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
              {dragging && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Drop screenshots to attach</span>}
              {attachError && <span role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{attachError}</span>}
            </div>
          )}
          <div className="composer" style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--surface)', borderRadius: 16, boxShadow: 'var(--shadow-md)', padding: '8px 8px 8px 14px' }}>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
              onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} rows={2} disabled={!runtime}
              onPaste={(e) => { const files = imagesFrom(e.clipboardData); if (files.length) { e.preventDefault(); void attach(files) } }}
              placeholder={runtime ? `Message ${agentLabel}… — paste or drop screenshots too` : 'Your computer is offline — start Landed on it to continue this chat'}
              style={{ resize: 'none', padding: '4px 0', fontSize: 13.5, lineHeight: 1.55, maxHeight: 200, border: 'none', boxShadow: 'none', background: 'transparent' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button type="button" className="btn-ghost" aria-label="Attach screenshots" title="Attach screenshots (or paste / drop them)"
                disabled={!runtime || busy || attachments.length >= MAX_CHAT_IMAGES} onClick={() => picker.current?.click()}
                style={{ marginLeft: -8, opacity: !runtime || busy || attachments.length >= MAX_CHAT_IMAGES ? 0.5 : 1 }}>
                <Icon name="image" size={15} /> Screenshot
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>{runtime ? 'Enter to send · Shift+Enter for a new line' : ''}</span>
              <button type="button" className="btn-primary" aria-label="Send" onClick={() => submit()} disabled={busy || (!draft.trim() && !attachments.length) || !runtime}
                style={{ borderRadius: 10, padding: '6px 14px', opacity: busy || (!draft.trim() && !attachments.length) || !runtime ? 0.45 : 1 }}>
                {busy ? '…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** An agent reply: Markdown, with a proposed search brief shown as a card. */
function AgentReply({ text, latest, pending }: { text: string; latest: boolean; pending: boolean }) {
  if (!text) return <span style={{ color: 'var(--fg-muted)' }}>{pending ? 'Thinking…' : '(no reply)'}</span>
  const reply = extractBrief(text)
  const apps = extractApplications(reply.text)
  const read = extractAnswers(apps.text)
  // "Find my duplicates": the agent can't see the applications, so it asks
  // Landed to show them (an empty ```landed-dedupe block).
  const dedupe = /```landed-dedupe[^\n]*\n?[\s\S]*?```/.test(read.text)
  const visible = dedupe ? read.text.replace(/```landed-dedupe[^\n]*\n?[\s\S]*?```/g, '').trim() : read.text
  return (
    <>
      {visible && <Markdown text={visible} />}
      {dedupe && !pending && <DuplicatesReview emptyText="No duplicates — every application here looks distinct." />}
      {reply.drafting && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Writing up your search brief…</div>}
      {apps.drafting && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Reading your applications…</div>}
      {read.drafting && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Reading your answers…</div>}
      {reply.brief && <BriefCard brief={reply.brief} latest={latest} />}
      {apps.applications.length > 0 && <ReportedApplicationsCard applications={apps.applications} />}
      {read.answers && !pending && <ReportedAnswersCard answers={read.answers} />}
    </>
  )
}
