// Agent settings — the Agent page's settings view: your computer (local
// agents via the Landed daemon), cloud agents — ChatGPT, Claude, Gemini…
// through Landed's MCP connector (OAuth), or with a token over the agent
// protocol (Meta Muse) — and the raw reports. Scheduled work and the
// auto-apply preference live on the Workflow page.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from './primitives'
import { useAuth } from '../lib/auth'
import { formatRelative } from '../lib/time'
import { AGENT_PROVIDERS, agentSetupPrompt, isPrivateOrigin, summarizeObservation } from '../lib/agent-prompt'
import { scheduledPrompt } from '@landed/schema/cloud-agent'
import {
  useAgentConnections, useAgentObservations, useCreateAgentConnection, useRevokeAgentConnection,
  type AgentConnection,
} from '../hooks/agents'
import { RuntimePanel } from './runtime-panel'

const TYPE_LABEL: Record<string, string> = {
  job_discovered: 'Job found',
  application_status: 'Status',
  sync_error: 'Error',
}

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', borderRadius: 12, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ marginLeft: 'auto' }}>{right}</div>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>{children}</div>
}

function ErrorText({ message }: { message: string }) {
  return <div role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{message}</div>
}

export function AgentSettings() {
  const user = useAuth((s) => s.user)!
  const connections = useAgentConnections()
  const observations = useAgentObservations(50)
  const [created, setCreated] = useState<{ connection: AgentConnection; token: string } | null>(null)
  const [selected, setSelected] = useState<AgentChoiceId | null>(null)

  const names = new Map((connections.data ?? []).map((c) => [c.id, c.display_name]))
  const active = (connections.data ?? []).filter((c) => !c.revoked_at)

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          flexShrink: 0,
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55,
          background: 'var(--surface-2)', border: '0.5px solid var(--border)', color: 'var(--fg-muted)',
        }}>
          <Icon name={user.cloud_sync ? 'cloud' : 'device'} size={14} />
          <span>
            {user.cloud_sync
              ? 'Agent reports are stored in Landed Cloud with the rest of your data.'
              : "Your data stays on this device. Agents run in the cloud, so Landed's server holds their reports only until this browser picks them up — at most 7 days — then deletes them."}
          </span>
        </div>

        <RuntimePanel />

        <AgentPicker connections={active} selected={selected} onSelect={setSelected} />

        {created ? (
          <SetupPanel created={created} onDone={() => { setCreated(null); setSelected(null) }} />
        ) : selected ? (
          AGENT_CHOICES.find((choice) => choice.id === selected)?.kind === 'token'
            ? <ConnectForm key={selected} initialProvider={selected === 'meta_muse' ? 'meta_muse' : 'other'} onCreated={setCreated} />
            : <ConnectorSetup choice={AGENT_CHOICES.find((choice) => choice.id === selected)!} connections={active} />
        ) : null}

        <Card title={`Connections${active.length ? ` (${active.length} active)` : ''}`}>
          {connections.isLoading && <Muted>Loading…</Muted>}
          {connections.error && <ErrorText message={(connections.error as Error).message} />}
          {connections.data?.length === 0 && <Muted>No agents connected yet.</Muted>}
          {(connections.data?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {connections.data!.map((c, i) => <ConnectionRow key={c.id} connection={c} first={i === 0} />)}
            </div>
          )}
        </Card>

        <Card title="Recent reports" right={<span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Raw — not applied to your pipeline yet</span>}>
          {observations.isLoading && <Muted>Loading…</Muted>}
          {observations.error && <ErrorText message={(observations.error as Error).message} />}
          {observations.data?.length === 0 && <Muted>Nothing reported yet. Reports show up here a minute or so after an agent sends them.</Muted>}
          {(observations.data?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {observations.data!.map((o, i) => (
                <div key={o.id} style={{
                  display: 'grid', gridTemplateColumns: '84px 1fr auto', gap: 10, alignItems: 'center',
                  padding: '8px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--border-subtle)', fontSize: 12,
                }}>
                  <span style={{
                    fontSize: 10.5, fontWeight: 500, padding: '2px 6px', borderRadius: 4, width: 'fit-content',
                    background: o.observation_type === 'sync_error' ? 'oklch(0.97 0.03 30)' : 'var(--surface-2)',
                    border: '0.5px solid var(--border)',
                  }}>{TYPE_LABEL[o.observation_type] ?? o.observation_type}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.payload_json ? summarizeObservation(o) : <span style={{ color: 'var(--fg-muted)' }}>Delivered to a device earlier</span>}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    {o.display_name ?? names.get(o.connection_id) ?? 'agent'} · {formatRelative(o.observed_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
  )
}

function ConnectForm({ initialProvider, onCreated }: {
  initialProvider: string
  onCreated: (c: { connection: AgentConnection; token: string }) => void
}) {
  const create = useCreateAgentConnection()
  const [name, setName] = useState('')
  const label = AGENT_PROVIDERS.find((p) => p.id === initialProvider)?.label ?? initialProvider

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const res = await create.mutateAsync({ provider: initialProvider, display_name: name.trim() || label })
    setName('')
    onCreated(res)
  }

  return (
    <Card title="Create a private connection key">
      <Muted>For Meta Muse, Manus, OpenClaw and agents that connect with an API key. Create it here, then paste the one-time setup message into that agent.</Muted>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500, flex: 1, minWidth: 200 }}>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${label} — job search`} maxLength={120}
            style={{ padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit' }} />
        </label>
        <button type="submit" className="btn-primary" disabled={create.isPending} style={{ opacity: create.isPending ? 0.6 : 1 }}>
          <Icon name="plus" size={12} /> {create.isPending ? 'Creating…' : `Add ${label}`}
        </button>
      </form>
      {create.error && <div style={{ marginTop: 8 }}><ErrorText message={(create.error as Error).message} /></div>}
    </Card>
  )
}

function SetupPanel({ created, onDone }: { created: { connection: AgentConnection; token: string }; onDone: () => void }) {
  const prompt = agentSetupPrompt(created.token)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Card title={`Set up ${created.connection.display_name}`} right={<button type="button" className="btn-secondary" onClick={onDone}>Done</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Muted>
          Paste these instructions into your agent. They include its key, which is shown <strong style={{ color: 'var(--fg)' }}>only this once</strong> —
          if you lose it, revoke this connection and create a new one. The agent gets the same tasks as a connector: a job search for
          your confirmed direction, and an email check if you turned those on and it can read your mail.
          {!useAuth.getState().user?.cloud_sync && " While it's connected, this browser shares your search direction and application list (company, role, stage) with Landed's server so the agent can read them; revoking it deletes them."}
        </Muted>
        {isPrivateOrigin() && (
          <div style={{
            fontSize: 11.5, padding: '7px 10px', borderRadius: 6, lineHeight: 1.5,
            background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
          }}>
            This Landed is running on {window.location.host}, which agents in the cloud can't reach. They need Landed's public HTTPS address.
          </div>
        )}
        <textarea readOnly value={prompt} rows={12} onFocus={(e) => e.currentTarget.select()} style={{
          width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5, padding: 10,
          border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', resize: 'vertical',
        }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy instructions'}</button>
        </div>
      </div>
    </Card>
  )
}

function ConnectionRow({ connection: c, first }: { connection: AgentConnection; first: boolean }) {
  const revoke = useRevokeAgentConnection()
  const [confirming, setConfirming] = useState(false)
  const label = c.provider === 'mcp' ? 'Connector' : AGENT_PROVIDERS.find((p) => p.id === c.provider)?.label ?? c.provider
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center',
      padding: '8px 0', borderTop: first ? 'none' : '0.5px solid var(--border-subtle)', fontSize: 12,
      opacity: c.revoked_at ? 0.55 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{c.display_name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {label} · {c.last_seen_at ? `last seen ${formatRelative(c.last_seen_at)}` : 'not used yet'}
          {!c.revoked_at && !c.scopes.includes('tasks:read') && ' · reports only (made before tasks — create a new one to give it tasks)'}
        </div>
      </div>
      <span style={{ fontSize: 11, color: c.revoked_at ? 'var(--fg-muted)' : 'oklch(0.45 0.13 155)' }}>
        {c.revoked_at ? 'Revoked' : 'Active'}
      </span>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', minWidth: 120 }}>
        {!c.revoked_at && !confirming && (
          <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>Revoke</button>
        )}
        {!c.revoked_at && confirming && <>
          <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className="btn-primary" disabled={revoke.isPending}
            style={{ background: 'oklch(0.5 0.16 30)', borderColor: 'oklch(0.5 0.16 30)' }}
            onClick={() => revoke.mutate(c.id)}>
            {revoke.isPending ? 'Revoking…' : c.provider === 'mcp' ? 'Disconnect' : 'Revoke token'}
          </button>
        </>}
      </div>
    </div>
  )
}


// ── Landed as a connector (MCP + OAuth) ───────────────────────────────────

function CopyField({ value, mono = true, rows }: { value: string; mono?: boolean; rows?: number }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  const style = {
    flex: 1, minWidth: 0, fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontSize: 11.5, lineHeight: 1.5, padding: '6px 10px',
    border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--fg)', resize: 'none' as const,
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      {rows ? <textarea readOnly value={value} rows={rows} style={style} onFocus={(e) => e.currentTarget.select()} />
        : <input readOnly value={value} style={style} onFocus={(e) => e.currentTarget.select()} />}
      <button type="button" className="btn-secondary" onClick={copy} style={{ flexShrink: 0 }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

type AgentChoiceId = 'codex' | 'chatgpt' | 'claude' | 'gemini' | 'meta_muse' | 'other'
type AgentChoice = {
  id: AgentChoiceId
  label: string
  mark: string
  description: string
  kind: 'connector' | 'token'
  match?: RegExp
  steps?: ReactNode
}

const AGENT_CHOICES: AgentChoice[] = [
  {
    id: 'codex', label: 'Codex', mark: 'CX', kind: 'connector', match: /codex/i,
    description: 'One-click on this Mac',
    steps: <><code>codex mcp add landed --url URL</code>, then finish sign-in and click <b>Allow</b>.</>,
  },
  {
    id: 'chatgpt', label: 'ChatGPT', mark: 'GPT', kind: 'connector', match: /chatgpt|openai/i,
    description: 'Custom app with OAuth',
    steps: <>Settings → Apps → Advanced settings → turn on <b>Developer mode</b> → Create app → paste the URL → choose OAuth.</>,
  },
  {
    id: 'claude', label: 'Claude', mark: 'CL', kind: 'connector', match: /claude/i,
    description: 'Claude.ai, desktop or mobile',
    steps: <>Settings → Connectors → <b>Add custom connector</b> → paste the URL → Add → Connect.</>,
  },
  {
    id: 'gemini', label: 'Gemini', mark: 'GM', kind: 'connector', match: /gemini/i,
    description: 'Google custom app',
    steps: <>gemini.google.com → Settings → <b>Connected apps</b> → Add custom app → paste the URL.</>,
  },
  {
    id: 'meta_muse', label: 'Meta Muse', mark: 'MM', kind: 'token',
    description: 'Connect with a private key',
  },
  {
    id: 'other', label: 'Other agent', mark: '+', kind: 'token',
    description: 'Manus, OpenClaw, Cursor…',
  },
]

const choiceConnected = (choice: AgentChoice, connections: AgentConnection[]) => connections.some((connection) => {
  if (choice.kind === 'token') return connection.provider === choice.id
  return connection.provider === 'mcp' && !!choice.match?.test(connection.display_name)
})

function AgentPicker({ connections, selected, onSelect }: {
  connections: AgentConnection[]
  selected: AgentChoiceId | null
  onSelect: (id: AgentChoiceId | null) => void
}) {
  const url = `${window.location.origin}/mcp`
  return (
    <Card title="Add an agent" right={connections.length ? <span style={{ fontSize: 11, color: 'oklch(0.45 0.13 155)' }}>{connections.length} connected</span> : null}>
      <Muted>Pick the agent you use. Landed shows only the next step for that agent; connection URLs and keys stay out of the way.</Muted>
      <div role="list" aria-label="Agents you can add" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))', gap: 8, marginTop: 12,
      }}>
        {AGENT_CHOICES.map((choice) => {
          const connected = choiceConnected(choice, connections)
          const picked = selected === choice.id
          return (
            <button key={choice.id} type="button" role="listitem" aria-pressed={picked}
              onClick={() => onSelect(picked ? null : choice.id)}
              style={{
                minHeight: 88, padding: 12, borderRadius: 9, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'var(--fg)',
                display: 'grid', gridTemplateColumns: '34px 1fr', columnGap: 10, rowGap: 5, alignItems: 'center',
                background: picked ? 'color-mix(in oklch, var(--accent) 7%, var(--surface))' : 'var(--surface-2)',
                border: `1px solid ${picked ? 'var(--accent)' : 'var(--border)'}`,
              }}>
              <span aria-hidden="true" style={{
                gridRow: '1 / span 2', width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
                background: 'var(--surface)', border: '0.5px solid var(--border)', fontSize: choice.mark.length > 2 ? 9 : 11,
                fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--accent)',
              }}>{choice.mark}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, fontWeight: 600 }}>
                {choice.label}
                {connected && <span style={{ fontSize: 10, fontWeight: 500, color: 'oklch(0.45 0.13 155)' }}>Connected</span>}
                {picked && <span style={{ marginLeft: 'auto', color: 'var(--accent)', display: 'flex' }}><Icon name="check" size={12} /></span>}
              </span>
              <span style={{ fontSize: 11, lineHeight: 1.35, color: 'var(--fg-muted)' }}>{choice.description}</span>
            </button>
          )
        })}
      </div>
      <details style={{ marginTop: 12, fontSize: 12 }}>
        <summary style={{ color: 'var(--fg-muted)', cursor: 'pointer', userSelect: 'none' }}>Advanced: connect with a URL or setup prompt</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <CopyField value={url} />
          {isPrivateOrigin() && <PrivateOriginNotice />}
          <div style={{ color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Claude Code: <code>claude mcp add --transport http landed URL</code> · Codex: <code>codex mcp add landed --url URL</code> · Cursor: Settings → MCP → Add new MCP server.
          </div>
          <CopyField value={scheduledPrompt()} mono={false} rows={3} />
        </div>
      </details>
    </Card>
  )
}

function PrivateOriginNotice() {
  return (
    <div style={{
      fontSize: 11.5, padding: '7px 10px', borderRadius: 6, lineHeight: 1.5,
      background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
    }}>
      Agents in the cloud cannot reach {window.location.host}. Use Landed's public HTTPS address; agents on this computer can connect here now.
    </div>
  )
}

const codexConnectLink = (url: string) =>
  `landed://connect-agent?agent=codex&url=${encodeURIComponent(url)}`

function CodexConnect({ url, connected }: { url: string; connected: boolean }) {
  const [opening, setOpening] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  useEffect(() => {
    if (connected) {
      setOpening(false)
      setShowHelp(false)
    }
  }, [connected])
  const open = () => {
    setOpening(true)
    setShowHelp(false)
    window.location.href = codexConnectLink(url)
    setTimeout(() => setShowHelp(true), 7000)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
      background: 'var(--surface-2)', border: '0.5px solid var(--border)', flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          <Icon name="sparkle" size={13} /> Codex on this Mac
          {connected && <span style={{ fontSize: 10.5, color: 'oklch(0.45 0.13 155)', fontWeight: 500 }}>Connected</span>}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5, marginTop: 2 }}>
          Landed for Mac adds the connector and starts sign-in for you. Approve Landed once in the browser; no terminal or pasted URL.
        </div>
      </div>
      <button type="button" className={connected ? 'btn-secondary' : 'btn-primary'} onClick={open}>
        {opening ? 'Opening sign-in…' : connected ? 'Reconnect Codex' : 'Connect Codex'}
      </button>
      {opening && (
        <div style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          In the Landed dialog, click <b>Connect Codex</b>; then sign in and click <b>Allow</b> in the browser.
          {showHelp && <> Nothing opened? Open Landed for Mac once so it can update, then try again.</>}
        </div>
      )}
    </div>
  )
}

function ConnectorSetup({ choice, connections }: { choice: AgentChoice; connections: AgentConnection[] }) {
  const url = `${window.location.origin}/mcp`
  const onMac = /Mac/i.test(navigator.platform || navigator.userAgent)
  const connected = choiceConnected(choice, connections)
  if (choice.id === 'codex' && onMac) {
    return (
      <Card title="Connect Codex">
        <CodexConnect url={url} connected={connected} />
      </Card>
    )
  }
  return (
    <Card title={`${connected ? 'Connect another' : 'Connect'} ${choice.label}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Muted>Copy this address into {choice.label}. After its sign-in window opens, approve Landed once; the connection then appears here automatically.</Muted>
        <CopyField value={url} />
        {isPrivateOrigin() && <PrivateOriginNotice />}
        <div style={{ padding: '9px 11px', borderRadius: 7, background: 'var(--surface-2)', border: '0.5px solid var(--border)', fontSize: 12, lineHeight: 1.55 }}>
          {choice.steps}
        </div>
      </div>
    </Card>
  )
}
