// The search brief the agent proposes in the Agent chat, as a card with one
// button: save it to the Find new jobs automation, turn that on, and search
// now — with the agents and sources ticked on the card (Search with; the
// agent may suggest them, and a schedule, in the same block). Plus the status
// strip for the active search (running / last run) at the top of the chat.
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { SearchBrief, SearchSetup } from '@landed/schema/search-brief'
import { describeSchedule, type Automations, type Schedule, type SearchSources } from '@landed/schema/automation'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { useJobSearch, type SearchRun } from '../lib/job-search'
import type { DbJobSearch } from '../lib/store'
import { useRuntimes } from '../hooks/runtimes'
import { useAgentConnections } from '../hooks/agents'
import { useAutomations, useSetAutomations } from '../hooks/automation'
import { chosenSearchTargets, needsDaemonUpdate, searchComputer, useActiveSearch, useEditBrief, useStartSearch } from '../hooks/search'
import { SearchSourcesPicker } from './search-sources'
import { muted, danger } from './ui'

const BRIEF_KEYS: (keyof SearchBrief)[] = [
  'summary', 'roles', 'seniority', 'locations', 'remote', 'needs_sponsorship', 'salary_min', 'industries',
  'include_companies', 'exclude_companies', 'notes',
]
/** Field by field: the server's jsonb doesn't keep key order. */
const sameBrief = (a: SearchBrief, b: SearchBrief) => BRIEF_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))


function where(b: SearchBrief) {
  const places = b.locations.length ? b.locations.join(', ') : 'Anywhere'
  return b.remote === 'any' ? places : `${places} · ${b.remote === 'onsite' ? 'on-site' : b.remote}`
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div style={{ color: 'var(--fg-muted)' }}>{label}</div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </>
  )
}

function useSearchState() {
  const runtimes = useRuntimes()
  const active = useActiveSearch()
  const runs = useJobSearch((s) => s.runs)
  const start = useStartSearch()
  const { automations } = useAutomations()
  const activeRuns = active ? runs.filter((r) => r.search_id === active.id) : []
  return {
    active,
    activeRuns,
    running: activeRuns.some((r) => r.status === 'running') || start.isPending,
    targets: chosenSearchTargets(runtimes.data, automations),
    outdated: needsDaemonUpdate(runtimes.data),
    start,
  }
}

/** The agent's suggested schedule, on top of the current one. */
function withSuggestion(current: Schedule, suggested: SearchSetup['schedule']): Schedule {
  if (!suggested) return current
  if (suggested.kind === 'interval') return suggested
  return { kind: 'daily', time: suggested.time, days: current.kind === 'daily' ? current.days : [0, 1, 2, 3, 4, 5, 6] }
}

export function BriefCard({ brief, setup, latest }: { brief: SearchBrief; setup: SearchSetup | null; latest: boolean }) {
  const { active, running, outdated, start } = useSearchState()
  const runtimes = useRuntimes()
  const { automations, loaded } = useAutomations()
  const setAutomations = useSetAutomations()
  const saveBrief = useEditBrief()
  const cloud = (useAgentConnections().data ?? []).filter((c) => !c.revoked_at && c.scopes.includes('tasks:read')).map((c) => c.display_name)
  const choices = searchComputer(runtimes.data, automations).map((t) => t.agent)
  const confirmed = !!active && sameBrief(active.brief, brief)
  const stale = !latest && !confirmed

  // What the card will save: the current Search with, or what the agent
  // suggested (only agents that are here).
  const suggested = setup?.search_with?.filter((id) => choices.some((a) => a.id === id)) ?? []
  const [sources, setSources] = useState<SearchSources | null>(null)
  const draft: SearchSources = sources ?? { ...automations.job_search.sources!, ...(suggested.length ? { agents: suggested } : {}) }
  const schedule = withSuggestion(automations.job_search.schedule, setup?.schedule ?? null)
  const job = automations.job_search
  const busy = running || setAutomations.isPending || saveBrief.isPending

  const save = async () => {
    const next: Automations = { ...automations, job_search: { ...job, enabled: true, schedule, sources: draft } }
    await setAutomations.mutateAsync(next)
    const targets = chosenSearchTargets(runtimes.data, next)
    if (targets.length) start.mutate({ brief, existingId: confirmed ? active!.id : undefined, targets })
    else if (!confirmed) await saveBrief.mutateAsync(brief)
  }

  return (
    <div style={{
      marginTop: 8, borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)',
      opacity: stale ? 0.6 : 1, overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
        <Icon name="target" size={12} /> Search brief
        {confirmed && <span style={{ marginLeft: 'auto', fontWeight: 500, color: 'oklch(0.45 0.13 155)', display: 'flex', alignItems: 'center', gap: 3 }}><Icon name="check" size={11} /> Confirmed</span>}
        {stale && <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--fg-muted)' }}>Earlier draft</span>}
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 550, lineHeight: 1.45 }}>{brief.summary}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', columnGap: 10, rowGap: 4, fontSize: 11.5, lineHeight: 1.45 }}>
          <Field label="Roles">{brief.roles.join(' · ')}</Field>
          {brief.seniority && <Field label="Level">{brief.seniority}</Field>}
          <Field label="Where">{where(brief)}</Field>
          {brief.needs_sponsorship !== null && <Field label="Visa">{brief.needs_sponsorship ? 'Needs sponsorship' : 'No sponsorship needed'}</Field>}
          {brief.salary_min && <Field label="Salary">{brief.salary_min}+</Field>}
          {brief.industries.length > 0 && <Field label="Industries">{brief.industries.join(', ')}</Field>}
          {brief.include_companies.length > 0 && <Field label="Look at">{brief.include_companies.join(', ')}</Field>}
          {brief.exclude_companies.length > 0 && <Field label="Skip">{brief.exclude_companies.join(', ')}</Field>}
          {brief.notes && <Field label="Notes">{brief.notes}</Field>}
        </div>

        {confirmed && (
          <div style={muted}>
            Saved to <Link to="/automation">Find new jobs</Link>{job.enabled ? ` — on, ${describeSchedule(job.schedule).toLowerCase()}` : ' (turned off)'}. New jobs land in the
            Leads column; run it again from the bar at the top.
          </div>
        )}
        {!stale && !confirmed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Search with</div>
              <SearchSourcesPicker agents={choices} sources={draft} cloud={cloud} disabled={busy || !loaded} onChange={setSources} />
            </div>
            <div>
              <button type="button" className="btn-primary" disabled={busy || !loaded} style={{ opacity: busy || !loaded ? 0.6 : 1 }} onClick={() => void save()}>
                <Icon name="search" size={12} />
                {running ? 'Searching…' : 'Save to Find new jobs & search now'}
              </button>
            </div>
            <div style={muted}>
              {`Turns on Find new jobs (${describeSchedule(schedule).toLowerCase()}) with these criteria; change either on the Automation page.`}
              {choices.length === 0 && (outdated
                ? ' The Landed daemon on your computer needs an update to search; the lists and job boards still run.'
                : ' Your agents search once your computer is back online.')}
            </div>
            {(start.error ?? setAutomations.error) && <div role="alert" style={{ ...muted, color: danger }}>{((start.error ?? setAutomations.error) as Error).message}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function runLine(r: SearchRun) {
  if (r.status === 'running') {
    const steps = [r.searches && `${r.searches} search${r.searches === 1 ? '' : 'es'}`, r.pages && `${r.pages} page${r.pages === 1 ? '' : 's'} read`].filter(Boolean)
    return `${r.label}: searching${steps.length ? ` — ${steps.join(' · ')}` : '…'}`
  }
  if (r.status === 'error') return `${r.label}: ${r.error ?? 'failed'}`
  const res = r.result!
  return `${r.label}: found ${res.found}${res.found ? ` — ${res.added} new in Leads${res.merged ? `, ${res.merged} already there` : ''}${res.already_applied ? `, ${res.already_applied} already in your pipeline` : ''}` : ''}`
}

function lastRunLine(s: DbJobSearch) {
  const r = s.last_run_result
  if (!s.last_run_at || !r) return 'Not searched yet.'
  const when = formatRelative(s.last_run_at)
  if (r.agents.length === 0) return `Last search ${when} didn't finish${r.failed?.length ? ` (${r.failed.join(', ')})` : ''}.`
  return `Last search ${when}: found ${r.found}, ${r.added} new in Leads.`
}

/** The active search at the top of the chat: what it is, and its run. */
export function SearchStatus() {
  const { active, activeRuns, running, targets, start } = useSearchState()
  if (!active) return null
  return (
    <div style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
      <span style={{ marginTop: 2, color: running ? 'var(--accent)' : 'var(--fg-muted)', animation: running ? 'pulse 1.6s ease-in-out infinite' : undefined }}>
        <Icon name="search" size={13} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={active.brief.summary}>
          {active.brief.summary}
        </div>
        {activeRuns.length > 0
          ? activeRuns.map((r) => (
              <div key={r.id} style={{ ...muted, color: r.status === 'error' ? danger : muted.color }}>{runLine(r)}</div>
            ))
          : <div style={muted}>{lastRunLine(active)}</div>}
        {activeRuns.some((r) => r.status === 'done' && r.summary) && (
          <div style={{ ...muted, marginTop: 2 }}>{activeRuns.find((r) => r.summary)!.summary}</div>
        )}
      </div>
      {!running && targets.length > 0 && (
        <button type="button" className="btn-secondary" style={{ flexShrink: 0, padding: '3px 8px', fontSize: 11.5 }}
          onClick={() => start.mutate({ brief: active.brief, existingId: active.id, targets })}>
          <Icon name="refresh" size={11} /> Search again
        </button>
      )}
    </div>
  )
}
