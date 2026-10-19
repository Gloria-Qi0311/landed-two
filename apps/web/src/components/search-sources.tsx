// Find new jobs → Search with: which agents on the user's computer search,
// and the other sources (public job lists, followed companies' boards, cloud
// agents). On the Automation page and on the brief card in the Agent chat;
// saved to users.automations.job_search.sources (packages/schema/src/automation.ts).
import { pickSearchAgents, type SearchSources } from '@landed/schema/automation'
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

export function SearchSourcesPicker({ agents, sources, cloud, disabled, onChange }: {
  /** the agents on the computer that searches */
  agents: RuntimeAgent[]
  sources: SearchSources
  /** connected cloud agents' names */
  cloud: string[]
  disabled?: boolean
  onChange: (next: SearchSources) => void
}) {
  const searching = pickSearchAgents(agents, sources)
  const toggleAgent = (id: string, on: boolean) => {
    const ids = new Set(sources.agents.filter((a) => agents.some((x) => x.id === a)))
    if (on) ids.add(id)
    else ids.delete(id)
    onChange({ ...sources, agents: [...ids] })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {agents.map((a) => (
          <Chip key={a.id} on={searching.includes(a)} label={a.label} disabled={disabled}
            title="Searches the web with your own subscription" onChange={(on) => toggleAgent(a.id, on)} />
        ))}
        <Chip on={sources.job_lists} label="SimplifyJobs lists" disabled={disabled} title="New-grad and internship lists, checked while Landed is open"
          onChange={(on) => onChange({ ...sources, job_lists: on })} />
        <Chip on={sources.company_boards} label="Company job boards" disabled={disabled} title="Greenhouse, Lever and Ashby boards of companies you follow"
          onChange={(on) => onChange({ ...sources, company_boards: on })} />
        {cloud.length > 0 && (
          <Chip on={sources.cloud_agents} label={cloud.length === 1 ? cloud[0] : `Cloud agents (${cloud.length})`} disabled={disabled}
            title={`${cloud.join(', ')}: they run the search on their own schedule`} onChange={(on) => onChange({ ...sources, cloud_agents: on })} />
        )}
      </div>
      <div style={muted}>
        {agents.length === 0
          ? 'No computer with an agent that can search is online right now; the lists and job boards still run.'
          : searching.length > 1
            ? `${searching.map((a) => a.label).join(' and ')} each search, with your own subscription; what they find is merged. The lists and job boards cost nothing.`
            : `${searching[0].label} searches, with your own subscription${sources.agents.length === 0 ? ' (none ticked, so the first that can)' : ''}. The lists and job boards cost nothing.`}
      </div>
    </div>
  )
}
