// Agent settings — the gear view of the Ask Agent panel: your computer
// (local agents via the Landed daemon), cloud agents (Meta Muse, …) that
// report over the agent protocol, email watching by your own agent, whether
// email updates apply automatically, and the raw reports.
import { useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from './primitives'
import { useAuth } from '../lib/auth'
import { formatRelative } from '../lib/time'
import { AGENT_PROVIDERS, agentSetupPrompt, isPrivateOrigin, summarizeObservation } from '../lib/agent-prompt'
import {
  useAgentConnections, useAgentObservations, useCreateAgentConnection, useRevokeAgentConnection,
  type AgentConnection,
} from '../hooks/agents'
import { useAccountPrefs, useSetAutoApply } from '../hooks/inbox'
import { RuntimePanel } from './runtime-panel'
import { EmailWatchSetting } from './email-watch'

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

        <Card title="Email watching"><EmailWatchSetting /></Card>

        <AutoApplySetting />

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
          Cloud agents (Meta Muse, …)
        </div>

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
    <Card title="Connect an agent">
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
          Paste these instructions into your agent. They include its token, which is shown <strong style={{ color: 'var(--fg)' }}>only this once</strong> —
          if you lose it, revoke this connection and create a new one.
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
  const label = AGENT_PROVIDERS.find((p) => p.id === c.provider)?.label ?? c.provider
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center',
      padding: '8px 0', borderTop: first ? 'none' : '0.5px solid var(--border-subtle)', fontSize: 12,
      opacity: c.revoked_at ? 0.55 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{c.display_name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {label} · {c.last_seen_at ? `last report ${formatRelative(c.last_seen_at)}` : 'no reports yet'}
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
            {revoke.isPending ? 'Revoking…' : 'Revoke token'}
          </button>
        </>}
      </div>
    </div>
  )
}

function AutoApplySetting() {
  const prefs = useAccountPrefs()
  const set = useSetAutoApply()
  const offline = useAuth((s) => s.offline)
  const on = prefs.data?.auto_apply_updates ?? true
  return (
    <Card title="Email updates">
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12, lineHeight: 1.5, cursor: offline ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={on} disabled={offline || prefs.isLoading || set.isPending}
          onChange={(e) => set.mutate(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontWeight: 500 }}>Apply updates from email automatically</span>
          <span style={{ display: 'block', color: 'var(--fg-muted)' }}>
            When an agent is confident about an email — application received, interview, rejection, offer — Landed updates
            your board right away and you can undo it from the Applications page. Updates it can't place (which application?
            low confidence?) always ask first. Turn this off to approve every change yourself.
          </span>
        </span>
      </label>
      {set.error && <div style={{ marginTop: 6 }}><ErrorText message={(set.error as Error).message} /></div>}
    </Card>
  )
}
