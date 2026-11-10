// Find new jobs / Check email → which agents on the user's computer do it.
// The Workflow page shows them as chips (AgentSourcesPicker); the public
// sources (job lists, followed companies' boards) are rows of their own.
// Saved to users.automations (packages/schema/src/automation.ts).
import { pickSearchAgents, type AgentSources } from '@landed/schema/automation'
import type { RuntimeAgent } from '../hooks/runtimes'

function Chip({ on, label, title, disabled, onChange }: { on: boolean; label: string; title?: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 8px', borderRadius: 999, fontSize: 12,
      background: on ? 'var(--accent-soft)' : 'var(--surface-2)', color: 'var(--fg)', cursor: disabled ? 'default' : 'pointer',
    }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
      {label}
    </label>
  )
}

type PickerProps<S extends AgentSources> = {
  /** the agents on the computer that can do it */
  agents: RuntimeAgent[]
  sources: S
  disabled?: boolean
  onChange: (next: S) => void
  /** what a computer agent does, for its chip's tooltip */
  doing?: string
}

/** Which agents do it (search, read email): one chip per agent on the
 *  computer. Unticking every one is allowed. */
function AgentChips<S extends AgentSources>({ agents, sources, disabled, onChange, doing = 'Searches the web' }: PickerProps<S>) {
  const searching = pickSearchAgents(agents, sources)
  const toggleAgent = (id: string, on: boolean) => {
    // Ticked ones that are here, as shown (not the fallback for a computer without them).
    const ids = new Set(sources.agents.filter((a) => agents.some((x) => x.id === a)))
    for (const a of searching) ids.add(a.id)
    if (on) ids.add(id)
    else ids.delete(id)
    onChange({ ...sources, agents: [...ids] })
  }
  return (
    <>
      {agents.map((a) => (
        <Chip key={a.id} on={searching.includes(a)} label={a.label} disabled={disabled}
          title={`${doing} from your computer, with your own subscription; Landed runs it on the schedule`} onChange={(on) => toggleAgent(a.id, on)} />
      ))}
    </>
  )
}

/** Workflow → Agent search / Check email: the computer's agents (Landed
 *  runs them on the schedule). */
export function AgentSourcesPicker<S extends AgentSources>(props: PickerProps<S>) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}><b style={{ fontWeight: 600 }}>On your computer</b> · Landed runs them on the schedule below</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><AgentChips {...props} /></div>
    </div>
  )
}
