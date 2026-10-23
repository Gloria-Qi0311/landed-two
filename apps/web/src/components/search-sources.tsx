// Find new jobs → which sources look: the agents on the user's computer that
// search the web, cloud agents, and the public sources Landed reads itself
// (job lists, followed companies' boards). The Workflow page shows the agents
// (AgentSourcesPicker) and the public sources as separate rows; the brief card
// in the Agent chat shows them all at once (SearchSourcesPicker). Saved to
// users.automations.job_search.sources (packages/schema/src/automation.ts).
import { cloudAgentSearches, pickSearchAgents, type AgentSources, type SearchSources } from '@landed/schema/automation'
import type { RuntimeAgent } from '../hooks/runtimes'
import { formatRelative } from '../lib/time'
import { mutedLarge as muted } from './ui'

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

/** An agent connected to Landed (ChatGPT, Claude.ai, Codex through its
 *  connector…): it pulls the task itself when it runs, so Landed can't start
 *  it. `lastSeen`: when it last talked to Landed. */
export type CloudAgent = { id: string; name: string; lastSeen?: string | null }

type PickerProps<S extends AgentSources = SearchSources> = {
  /** the agents on the computer that can do it */
  agents: RuntimeAgent[]
  sources: S
  /** connected cloud agents */
  cloud: CloudAgent[]
  disabled?: boolean
  onChange: (next: S) => void
  /** what a computer agent does, for its chip's tooltip */
  doing?: string
}

/** Which agents do it (search, read email): one chip per agent on the
 *  computer and per connected agent. Unticking every one is allowed.
 *  `group`: only one kind (the Workflow page shows them as two rows). */
function AgentChips<S extends AgentSources>({ agents, sources, cloud, disabled, onChange, doing = 'Searches the web', group }: PickerProps<S> & { group?: 'computer' | 'connected' }) {
  const searching = pickSearchAgents(agents, sources)
  const toggleAgent = (id: string, on: boolean) => {
    // Ticked ones that are here, as shown (not the fallback for a computer without them).
    const ids = new Set(sources.agents.filter((a) => agents.some((x) => x.id === a)))
    for (const a of searching) ids.add(a.id)
    if (on) ids.add(id)
    else ids.delete(id)
    onChange({ ...sources, agents: [...ids] })
  }
  const cloudOn = (c: CloudAgent) => cloudAgentSearches(sources, c.id)
  const toggleCloud = (id: string, on: boolean) => {
    // Every cloud agent was off: turning one on leaves the others off.
    const skip = new Set(sources.cloud_agents ? sources.cloud_skip : cloud.map((c) => c.id))
    if (on) skip.delete(id)
    else skip.add(id)
    onChange({ ...sources, cloud_agents: cloud.some((c) => !skip.has(c.id)), cloud_skip: [...skip] })
  }
  return (
    <>
      {group !== 'connected' && agents.map((a) => (
        <Chip key={a.id} on={searching.includes(a)} label={a.label} disabled={disabled}
          title={`${doing} from your computer, with your own subscription; Landed runs it on the schedule`} onChange={(on) => toggleAgent(a.id, on)} />
      ))}
      {group !== 'computer' && cloud.map((c) => (
        <Chip key={c.id} on={cloudOn(c)} label={c.lastSeen ? `${c.name} · ${formatRelative(c.lastSeen)}` : c.name} disabled={disabled}
          title={`${c.name} is connected to Landed: it does this when it runs, on its own schedule${c.lastSeen ? `; last active ${formatRelative(c.lastSeen)}` : '; not active yet'}`} onChange={(on) => toggleCloud(c.id, on)} />
      ))}
    </>
  )
}

/** Who searches, in words. */
function agentsLine(agents: RuntimeAgent[], sources: SearchSources, cloud: CloudAgent[], publicSources: string): string {
  const names = [...pickSearchAgents(agents, sources).map((a) => a.label), ...cloud.filter((c) => cloudAgentSearches(sources, c.id)).map((c) => c.name)]
  if (names.length === 0) {
    return agents.length || cloud.length ? `No agent ticked: only the public sources look.${publicSources}` : `No computer with an agent that can search is online right now.${publicSources}`
  }
  return names.length > 1
    ? `${names.join(' and ')} each search, with your own subscriptions; what they find is merged.${publicSources}`
    : `${names[0]} searches, with your own subscription.${publicSources}`
}

/** Workflow → Agent search / Check email: the agents in two rows, the
 *  computer's (Landed runs them on the schedule) and the connected ones
 *  (they do it when they run). */
export function AgentSourcesPicker<S extends AgentSources>(props: PickerProps<S>) {
  const row = (label: string, hint: string, group: 'computer' | 'connected') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}><b style={{ fontWeight: 600 }}>{label}</b> · {hint}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><AgentChips {...props} group={group} /></div>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {props.agents.length > 0 && row('On your computer', 'Landed runs them on the schedule below', 'computer')}
      {props.cloud.length > 0 && row('Connected agents', "they do it when they run; Landed can't start them", 'connected')}
    </div>
  )
}

/** Every source at once (the brief card in the Agent chat). */
export function SearchSourcesPicker(props: PickerProps) {
  const { sources, disabled, onChange } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <AgentChips {...props} />
        <Chip on={sources.job_lists} label="SimplifyJobs lists" disabled={disabled} title="New-grad and internship lists, checked while Landed is open"
          onChange={(on) => onChange({ ...sources, job_lists: on })} />
        <Chip on={sources.company_boards} label="Company job boards" disabled={disabled} title="Greenhouse, Lever and Ashby boards of companies you follow"
          onChange={(on) => onChange({ ...sources, company_boards: on })} />
      </div>
      <div style={muted}>
        {props.agents.length === 0
          ? 'No computer with an agent that can search is online right now; the lists and job boards still run.'
          : agentsLine(props.agents, sources, props.cloud, ' The lists and job boards cost nothing.')}
      </div>
    </div>
  )
}
