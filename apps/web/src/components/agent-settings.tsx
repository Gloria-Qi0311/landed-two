// Agent settings — the Agent page's settings view: your computer (local
// agents via the Landed daemon), cloud agents — ChatGPT, Claude, Gemini…
// through Landed's MCP connector (OAuth), or with a token over the agent
// protocol (Meta Muse) — and the raw reports. Scheduled work and the
// auto-apply preference live on the Automation page.
import { useState, type FormEvent, type ReactNode } from 'react'
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
    <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        <div style={{ marginLeft: 'auto' }}>{right}</div>
      </div>
      <div style={{ padding: 14 }}>{children}</div>
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

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
          Cloud agents (ChatGPT, Claude, Gemini, Meta Muse…)
        </div>

        <ConnectorCard />

        {created
          ? <SetupPanel created={created} onDone={() => setCreated(null)} />
          : <ConnectForm onCreated={setCreated} />}

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

function ConnectForm({ onCreated }: { onCreated: (c: { connection: AgentConnection; token: string }) => void }) {
  const create = useCreateAgentConnection()
  const [provider, setProvider] = useState<string>(AGENT_PROVIDERS[0].id)
  const [name, setName] = useState('')
  const label = AGENT_PROVIDERS.find((p) => p.id === provider)?.label ?? provider

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const res = await create.mutateAsync({ provider, display_name: name.trim() || label })
    setName('')
    onCreated(res)
  }

  return (
    <Card title="Personal agents (Meta Muse, Manus, OpenClaw…): connect with a key">
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Agent
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ padding: '6px 8px', fontSize: 12.5, fontFamily: 'inherit' }}>
            {AGENT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500, flex: 1, minWidth: 200 }}>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${label} — job search`} maxLength={120}
            style={{ padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit' }} />
        </label>
        <button type="submit" className="btn-primary" disabled={create.isPending} style={{ opacity: create.isPending ? 0.6 : 1 }}>
          <Icon name="plus" size={12} /> {create.isPending ? 'Creating…' : 'Create connection'}
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

const CONNECTOR_STEPS: { name: string; steps: ReactNode }[] = [
  { name: 'Claude (claude.ai, desktop, mobile)', steps: <>Settings → Connectors → <b>Add custom connector</b> → paste the URL → Add, then Connect.</> },
  { name: 'ChatGPT', steps: <>Settings → Apps → Advanced settings → turn on <b>Developer mode</b> → Create app → paste the URL, authentication OAuth.</> },
  { name: 'Gemini', steps: <>gemini.google.com → Settings → <b>Connected apps</b> → Add custom app → paste the URL (personal accounts in the US for now).</> },
  { name: 'Claude Code · Codex · Cursor', steps: <><code>claude mcp add --transport http landed URL</code> · <code>codex mcp add landed --url URL</code> · Cursor: Settings → MCP → Add new MCP server → URL.</> },
]

function ConnectorCard() {
  const url = `${window.location.origin}/mcp`
  return (
    <Card title="Add Landed as a connector">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Muted>
          Any agent that takes remote MCP connectors can work for you here, on your own subscription: it gets Landed's tasks (a job
          search for your confirmed direction; an email check if you turned those on and it can read your mail) and hands results
          back, which land in Leads and on your applications like any agent's. Add this URL as a connector, sign in to Landed when
          it asks, and click Allow.
        </Muted>
        <CopyField value={url} />
        {isPrivateOrigin() && (
          <div style={{
            fontSize: 11.5, padding: '7px 10px', borderRadius: 6, lineHeight: 1.5,
            background: 'oklch(0.97 0.03 70)', border: '0.5px solid oklch(0.86 0.07 70)', color: 'oklch(0.38 0.1 60)',
          }}>
            Agents in the cloud can't reach {window.location.host}. Use Landed's public HTTPS address once it's deployed; agents on this
            computer (Claude Code, Codex, Cursor) can connect to this one now.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CONNECTOR_STEPS.map((s) => (
            <div key={s.name} style={{ fontSize: 12, lineHeight: 1.55 }}>
              <span style={{ fontWeight: 600 }}>{s.name}:</span> <span style={{ color: 'var(--fg-muted)' }}>{s.steps}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>Then ask it — or give it a scheduled task (e.g. every morning):</div>
        <CopyField value={scheduledPrompt()} mono={false} rows={3} />
      </div>
    </Card>
  )
}
