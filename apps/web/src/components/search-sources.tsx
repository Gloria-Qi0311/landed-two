// Find new jobs → which sources look: the agents on the user's computer that
// search the web, cloud agents, and the public sources Landed reads itself
// (job lists, followed companies' boards). The Workflow page shows the agents
// (AgentSourcesPicker) and the public sources as separate rows; the brief card
// in the Agent chat shows them all at once (SearchSourcesPicker). Saved to
// users.automations.job_search.sources (packages/schema/src/automation.ts).
import { cloudAgentSearches, pickSearchAgents, type AgentSources, type SearchSources } from '@landed/schema/automation'
import type { RuntimeAgent } from '../hooks/runtimes'
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

/** A connected cloud agent (ChatGPT, Claude.ai…): it pulls the search itself. */
export type CloudAgent = { id: string; name: string }

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
 *  computer and per cloud agent. Unticking every one is allowed. */
function AgentChips<S extends AgentSources>({ agents, sources, cloud, disabled, onChange, doing = 'Searches the web' }: PickerProps<S>) {
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
      {agents.map((a) => (
        <Chip key={a.id} on={searching.includes(a)} label={a.label} disabled={disabled}
          title={`${doing} from your computer, with your own subscription`} onChange={(on) => toggleAgent(a.id, on)} />
      ))}
      {cloud.map((c) => (
        <Chip key={c.id} on={cloudOn(c)} label={c.name} disabled={disabled}
          title={`${c.name} (cloud agent): it does this on its own schedule`} onChange={(on) => toggleCloud(c.id, on)} />
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

/** Workflow → Find jobs → Agent search: the agents only, as chips. */
export function AgentSourcesPicker<S extends AgentSources>(props: PickerProps<S>) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><AgentChips {...props} /></div>
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
