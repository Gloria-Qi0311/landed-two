// The search brief the agent proposes in the Ask Agent chat, as a card with
// one button: confirm it and search with every agent on the user's online
// computers. Plus the status strip for the active search (running / last
// run) at the top of the chat.
import type { ReactNode } from 'react'
import type { SearchBrief } from '@landed/schema/search-brief'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { useJobSearch, type SearchRun } from '../lib/job-search'
import type { DbJobSearch } from '../lib/store'
import { useRuntimes } from '../hooks/runtimes'
import { needsDaemonUpdate, searchTargets, useActiveSearch, useStartSearch } from '../hooks/search'

const BRIEF_KEYS: (keyof SearchBrief)[] = [
  'summary', 'roles', 'seniority', 'locations', 'remote', 'needs_sponsorship', 'salary_min', 'industries',
  'include_companies', 'exclude_companies', 'notes',
]
/** Field by field: the server's jsonb doesn't keep key order. */
const sameBrief = (a: SearchBrief, b: SearchBrief) => BRIEF_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))

const muted = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 } as const
const danger = 'oklch(0.45 0.15 30)'

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
  const activeRuns = active ? runs.filter((r) => r.search_id === active.id) : []
  return {
    active,
    activeRuns,
    running: activeRuns.some((r) => r.status === 'running') || start.isPending,
    targets: searchTargets(runtimes.data),
    outdated: needsDaemonUpdate(runtimes.data),
    start,
  }
}

export function BriefCard({ brief, latest }: { brief: SearchBrief; latest: boolean }) {
  const { active, running, targets, outdated, start } = useSearchState()
  const confirmed = !!active && sameBrief(active.brief, brief)
  const stale = !latest && !confirmed

  return (
    <div style={{
      marginTop: 6, border: '0.5px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)',
      opacity: stale ? 0.6 : 1, overflow: 'hidden',
    }}>
      <div style={{ padding: '9px 12px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600 }}>
        <Icon name="target" size={12} /> Search brief
        {confirmed && <span style={{ marginLeft: 'auto', fontWeight: 500, color: 'oklch(0.45 0.13 155)', display: 'flex', alignItems: 'center', gap: 3 }}><Icon name="check" size={11} /> Confirmed</span>}
        {stale && <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--fg-muted)' }}>Earlier draft</span>}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>{brief.summary}</div>
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

        {!stale && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
            <div>
              <button type="button" className={confirmed ? 'btn-secondary' : 'btn-primary'}
                disabled={running || targets.length === 0}
                style={{ opacity: running || targets.length === 0 ? 0.6 : 1 }}
                onClick={() => start.mutate({ brief, existingId: confirmed ? active!.id : undefined, targets })}>
                <Icon name="search" size={12} />
                {running ? 'Searching…' : confirmed ? 'Search again' : 'Confirm & search'}
              </button>
            </div>
            <div style={muted}>
              {targets.length > 0
                ? `Searches with ${targets.map((t) => `${t.agent.label} on ${t.runtime.name}`).join(', ')}. New jobs land in the Leads column.`
                : outdated
                  ? 'The Landed daemon on your computer needs an update to search: stop it and run `pnpm landed start` again.'
                  : 'Your computer is offline — start the Landed daemon to search.'}
            </div>
            {start.error && <div role="alert" style={{ ...muted, color: danger }}>{(start.error as Error).message}</div>}
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
    <div style={{ padding: '9px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--surface-2)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
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
