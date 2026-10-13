// Automation — Landed's recurring agent work, each on a schedule the user
// sets. The user's computer runs it (even with Landed closed) and keeps the
// results until Landed is open again (lib/automation-sync.ts). Also home to
// the "apply updates automatically" preference, and to why portal checks
// aren't on a schedule.
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  describeSchedule, INTERVAL_HOURS, WEEKDAYS,
  type AutomationKind, type AutomationRun, type Automations, type Schedule,
} from '@landed/schema/automation'
import { Icon } from './primitives'
import { PageHeader } from './shell'
import { formatRelative } from '../lib/time'
import { designate, requestRunNow, syncTargets, useAutomationSync } from '../lib/automation-sync'
import { useAutomations, useSetAutomations } from '../hooks/automation'
import { useAccountPrefs, useSetAutoApply } from '../hooks/inbox'
import { useActiveSearch } from '../hooks/search'
import { browserAgent } from '../hooks/portal'
import { canRun, useRuntimes } from '../hooks/runtimes'

const muted = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 } as const
const danger = 'oklch(0.45 0.15 30)'
const card = { background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } as const

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── schedule picker ───────────────────────────────────────────────────────

type Preset = { key: string; label: string; schedule: (time: string) => Schedule }
const DAILY: Preset[] = [
  { key: 'daily', label: 'Every day at…', schedule: (time) => ({ kind: 'daily', time, days: [0, 1, 2, 3, 4, 5, 6] }) },
  { key: 'weekdays', label: 'Weekdays at…', schedule: (time) => ({ kind: 'daily', time, days: WEEKDAYS }) },
  { key: 'weekly', label: 'Every Monday at…', schedule: (time) => ({ kind: 'daily', time, days: [1] }) },
]
const INTERVALS: Preset[] = INTERVAL_HOURS.map((h) => ({ key: `h${h}`, label: h === 1 ? 'Every hour' : `Every ${h} hours`, schedule: () => ({ kind: 'interval', hours: h }) }))

function presetOf(s: Schedule): string {
  if (s.kind === 'interval') return `h${s.hours}`
  if (s.days.length === 7) return 'daily'
  if (s.days.join() === WEEKDAYS.join()) return 'weekdays'
  return 'weekly'
}

function SchedulePicker({ schedule, presets, onChange, disabled }: { schedule: Schedule; presets: Preset[]; onChange: (s: Schedule) => void; disabled?: boolean }) {
  const time = schedule.kind === 'daily' ? schedule.time : '09:00'
  const current = presetOf(schedule)
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select aria-label="Schedule" value={current} disabled={disabled}
        onChange={(e) => onChange(presets.find((p) => p.key === e.target.value)!.schedule(time))}
        style={{ fontSize: 12.5, fontFamily: 'inherit', padding: '4px 6px', borderRadius: 6 }}>
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        {!presets.some((p) => p.key === current) && <option value={current}>{describeSchedule(schedule)}</option>}
      </select>
      {schedule.kind === 'daily' && (
        <input type="time" aria-label="Time" value={time} disabled={disabled}
          onChange={(e) => e.target.value && onChange({ ...schedule, time: e.target.value })}
          style={{ fontSize: 12.5, fontFamily: 'inherit', padding: '3px 6px', borderRadius: 6 }} />
      )}
    </span>
  )
}

// ── one automation ────────────────────────────────────────────────────────

function AutomationCard({ kind, icon, title, description, presets, blocker }: {
  kind: AutomationKind
  icon: string
  title: string
  description: string
  presets: Preset[]
  /** why it can't run yet (and what to do), if so */
  blocker: ReactNode | null
}) {
  const { automations, loaded } = useAutomations()
  const set = useSetAutomations()
  const sync = useAutomationSync()
  const runtimes = useRuntimes()
  const designated = designate(syncTargets(runtimes.data ?? []), automations)
  const a = automations[kind]
  const state = sync.output?.state[kind]
  const runs = (sync.output?.runs ?? []).filter((r) => r.kind === kind).slice(0, 5)
  const queued = sync.runNow.includes(kind)
  const save = (next: Partial<Automations[AutomationKind]>) =>
    set.mutate({ ...automations, [kind]: { ...a, ...next } })

  return (
    <section style={card}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={muted}>{description}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', flexShrink: 0 }}>
          <input type="checkbox" checked={a.enabled} disabled={!loaded || set.isPending} onChange={(e) => save({ enabled: e.target.checked })} />
          {a.enabled ? 'On' : 'Off'}
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingLeft: 44 }}>
        <SchedulePicker schedule={a.schedule} presets={presets} disabled={!loaded} onChange={(schedule) => save({ schedule })} />
        <span style={{ ...muted, flex: 1 }}>
          {state?.running || queued
            ? 'Running now…'
            : a.enabled && state?.next_run_at
              ? `Next: ${when(state.next_run_at)}`
              : a.enabled ? 'Scheduled' : 'Off'}
          {state?.last_success_at && ` · last ran ${formatRelative(state.last_success_at)}`}
        </span>
        <button type="button" className="btn-secondary" disabled={!designated || !!blocker || state?.running || queued}
          onClick={() => requestRunNow(kind)} style={{ opacity: !designated || blocker || state?.running || queued ? 0.6 : 1 }}>
          <Icon name="refresh" size={12} /> Run now
        </button>
      </div>

      {blocker && <div style={{ ...muted, paddingLeft: 44, color: danger }}>{blocker}</div>}
      {runs.length > 0 && <RunList runs={runs} />}
      {set.error && <div role="alert" style={{ ...muted, color: danger, paddingLeft: 44 }}>{(set.error as Error).message}</div>}
    </section>
  )
}

function RunList({ runs }: { runs: AutomationRun[] }) {
  const stored = useAutomationSync((s) => s.stored)
  return (
    <div style={{ marginLeft: 44, borderTop: '0.5px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: r.status === 'ok' ? 'oklch(0.65 0.17 155)' : r.status === 'running' ? 'var(--accent)' : 'oklch(0.62 0.17 28)' }} />
          <span style={{ color: 'var(--fg-muted)', width: 150, flexShrink: 0 }}>{when(r.started_at)}</span>
          <span style={{ flex: 1, minWidth: 0, color: r.status === 'error' ? danger : 'var(--fg)' }}>
            {r.status === 'running' ? 'Running…' : r.status === 'error' ? r.error : [r.summary, stored[r.id]?.text].filter(Boolean).join(' → ')}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── page ──────────────────────────────────────────────────────────────────

export function AutomationPage() {
  const navigate = useNavigate()
  const { automations } = useAutomations()
  const runtimes = useRuntimes()
  const sync = useAutomationSync()
  const designated = designate(syncTargets(runtimes.data ?? []), automations)
  const mailAgent = (runtimes.data ?? []).flatMap((r) => (r.revoked_at ? [] : r.agents)).find((a) => a.mail && canRun(a, 'email_check'))
  const search = useActiveSearch()
  const anyPaired = (runtimes.data ?? []).some((r) => !r.revoked_at && r.last_seen_at)
  const outdated = (runtimes.data ?? []).some((r) => r.online && r.agents.length && !r.agents.some((a) => canRun(a, 'automation_sync')))

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle={designated
          ? `Runs on ${designated.agent.label} on ${designated.runtime.name} — on schedule, even with Landed closed`
          : anyPaired ? 'Your computer is offline — scheduled work resumes when it’s back' : 'Connect your computer on the Agent page to run these'}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}>
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {outdated && !designated && (
            <div style={{ ...muted, color: danger }}>
              The Landed daemon on your computer needs an update for scheduled work: stop it and run <code>pnpm landed start</code> again.
            </div>
          )}
          {sync.error && <div style={{ ...muted, color: danger }}>Couldn't reach your computer: {sync.error}</div>}

          <AutomationCard
            kind="email_check" icon="inbox"
            title="Check email for application updates"
            description="Your agent reads new emails since the last check (read-only) and moves applications along: confirmations, assessments, interviews with their times, rejections, offers."
            presets={[...INTERVALS, ...DAILY.slice(0, 2)]}
            blocker={mailAgent ? null : <>Your agent can't read email yet. Connect Gmail in Claude (claude.ai → Settings → Connectors); your computer picks it up within 30 minutes.</>}
          />

          <AutomationCard
            kind="job_search" icon="search"
            title="Search for new jobs"
            description={search ? `With your search direction: ${search.brief.summary}. New postings land in the Leads column; ones you've seen before are merged.` : 'With the search direction you confirm with your agent. New postings land in the Leads column.'}
            presets={[INTERVALS[INTERVALS.length - 1], ...DAILY]}
            blocker={search ? null : (
              <>No search direction yet. <button type="button" className="btn-secondary" style={{ fontSize: 11.5, padding: '1px 8px' }} onClick={() => navigate('/agent')}>Set one with your agent</button></>
            )}
          />

          <AutoApplyCard />
          <PortalCheckCard />
        </div>
      </div>
    </>
  )
}

function AutoApplyCard() {
  const prefs = useAccountPrefs()
  const set = useSetAutoApply()
  const on = prefs.data?.auto_apply_updates ?? true
  return (
    <section style={card}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5, lineHeight: 1.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={on} disabled={prefs.isLoading || set.isPending} onChange={(e) => set.mutate(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Apply email updates automatically</span>
          <span style={{ display: 'block', ...muted }}>
            When an email clearly says what happened, Landed updates your board right away, and you can undo it from Applications.
            Anything unclear (which application? how sure?) always waits for you. Turn this off to approve every change.
          </span>
        </span>
      </label>
    </section>
  )
}

function PortalCheckCard() {
  const agent = browserAgent(useRuntimes().data)
  return (
    <section style={{ ...card, background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="external" size={14} /> Candidate portal checks</div>
      <div style={muted}>
        Not on a schedule on purpose: these drive your Chrome. When an application has had no news for 3 weeks, the Agent page offers to
        have your agent look at its portal — read-only (it can open and read pages, never click, type or sign in) and only when you click.
        {agent ? ` Ready: ${agent.agent.label} on ${agent.runtime.name} can use ${agent.browser}.` : ' To enable it, connect the Claude in Chrome extension to Claude Code.'}
        {' '}Tip: use a Chrome profile that's only signed in to job sites.
      </div>
    </section>
  )
}
