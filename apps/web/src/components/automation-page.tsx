// Automation — three jobs your agent does on a schedule, each laid out the
// same way: when it runs, what it looks at, and what happens with what it
// finds (packages/schema/src/automation.ts).
//   1. Check email            new emails → application status
//   2. Find new jobs          your criteria → Leads
//   3. Check candidate portals quiet applications → application status
// The only page-level setting is where they run: the user's computer (even
// with Landed closed — lib/automation-sync.ts); connected cloud agents also
// do 1 and 2 on their own schedule. Every other setting belongs to one of
// the three (e.g. "apply email updates automatically" is part of 1).
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  describeSchedule, INTERVAL_HOURS, pickQuietPortals, QUIET_DAY_CHOICES, WEEKDAYS,
  type AutomationKind, type AutomationRun, type Automations, type Schedule,
} from '@landed/schema/automation'
import { parseBrief, type RemotePreference, type SearchBrief } from '@landed/schema/search-brief'
import { Icon } from './primitives'
import { PageHeader } from './shell'
import { EditableList, EditableText } from './editable'
import { formatRelative } from '../lib/time'
import { useStore } from '../lib/store'
import { computerCan, designate, requestRunNow, syncTargets, useAutomationSync, type SyncTarget } from '../lib/automation-sync'
import { taskContext, useAutomations, useSetAutomations } from '../hooks/automation'
import { useAccountPrefs, useSetAutoApply } from '../hooks/inbox'
import { useActiveSearch, useEditBrief } from '../hooks/search'
import { useAgentConnections } from '../hooks/agents'
import { useRuntimes } from '../hooks/runtimes'

const muted = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 } as const
const danger = 'oklch(0.45 0.15 30)'
const card = { background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } as const
const select = { fontSize: 12.5, fontFamily: 'inherit', padding: '3px 6px', borderRadius: 6 } as const

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
      <select aria-label="Schedule" value={current} disabled={disabled} style={select}
        onChange={(e) => onChange(presets.find((p) => p.key === e.target.value)!.schedule(time))}>
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        {!presets.some((p) => p.key === current) && <option value={current}>{describeSchedule(schedule)}</option>}
      </select>
      {schedule.kind === 'daily' && (
        <input type="time" aria-label="Time" value={time} disabled={disabled} style={select}
          onChange={(e) => e.target.value && onChange({ ...schedule, time: e.target.value })} />
      )}
    </span>
  )
}

// ── one automation ────────────────────────────────────────────────────────

/** A labeled line of a card: When / Looks at / Then / Needs. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 10, alignItems: 'baseline', paddingLeft: 44 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function AutomationCard({ kind, icon, title, flow, presets, designated, blocker, children }: {
  kind: AutomationKind
  icon: string
  title: string
  /** what goes in → what comes out */
  flow: string
  presets: Preset[]
  designated: SyncTarget | null
  /** why it can't run yet (and what to do), if so */
  blocker: ReactNode | null
  children: ReactNode
}) {
  const { automations, loaded } = useAutomations()
  const set = useSetAutomations()
  const sync = useAutomationSync()
  const a = automations[kind]
  const state = sync.output?.state[kind]
  const runs = (sync.output?.runs ?? []).filter((r) => r.kind === kind).slice(0, 5)
  const queued = sync.runNow.includes(kind)
  const save = (next: Partial<Automations[AutomationKind]>) => set.mutate({ ...automations, [kind]: { ...a, ...next } })
  const cantRun = !designated || !!blocker || state?.running || queued

  return (
    <section style={card}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', border: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ ...muted, fontSize: 11.5 }}>{flow}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', flexShrink: 0 }}>
          <input type="checkbox" checked={a.enabled} disabled={!loaded || set.isPending} onChange={(e) => save({ enabled: e.target.checked })} />
          {a.enabled ? 'On' : 'Off'}
        </label>
      </div>

      <Row label="When">
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <SchedulePicker schedule={a.schedule} presets={presets} disabled={!loaded} onChange={(schedule) => save({ schedule })} />
          <span style={{ ...muted, flex: 1 }}>
            {state?.running || queued
              ? 'Running now…'
              : a.enabled && state?.next_run_at ? `Next: ${when(state.next_run_at)}` : a.enabled ? 'Scheduled' : 'Off'}
            {state?.last_success_at && ` · last ran ${formatRelative(state.last_success_at)}`}
          </span>
          <button type="button" className="btn-secondary" disabled={cantRun} onClick={() => requestRunNow(kind)} style={{ opacity: cantRun ? 0.6 : 1 }}>
            <Icon name="refresh" size={12} /> Run now
          </button>
        </span>
      </Row>
      {children}
      {blocker && <Row label="Needs"><span style={{ color: danger }}>{blocker}</span></Row>}
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
  const { automations } = useAutomations()
  const runtimes = useRuntimes()
  const sync = useAutomationSync()
  const targets = syncTargets(runtimes.data ?? [])
  const designated = designate(targets, automations)
  const anyPaired = (runtimes.data ?? []).some((r) => !r.revoked_at && r.last_seen_at)
  const outdated = (runtimes.data ?? []).some((r) => r.online && r.agents.length && !r.agents.some((a) => a.kinds?.includes('automation_sync')))
  const cloud = (useAgentConnections().data ?? []).filter((c) => !c.revoked_at && c.scopes.includes('tasks:read'))
  const cloudLine = cloud.length
    ? `${cloud.map((c) => c.display_name).join(', ')} also ${cloud.length === 1 ? 'does' : 'do'} this when ${cloud.length === 1 ? 'it runs' : 'they run'}, on ${cloud.length === 1 ? 'its' : 'their'} own schedule.`
    : null

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle={designated
          ? `Your agent does these on schedule — ${designated.agent.label} on ${designated.runtime.name}, even with Landed closed`
          : anyPaired ? 'Your computer is offline — scheduled work resumes when it’s back' : 'Connect your computer on the Agent page to run these'}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}>
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {outdated && !designated && (
            <div style={{ ...muted, color: danger }}>
              The Landed daemon on your computer needs an update for scheduled work: open Landed for Mac again (or run <code>pnpm landed start</code>).
            </div>
          )}
          {sync.error && <div style={{ ...muted, color: danger }}>Couldn't reach your computer: {sync.error}</div>}
          <EmailCard designated={designated} targets={targets} cloudLine={cloudLine} />
          <SearchCard designated={designated} targets={targets} cloudLine={cloudLine} />
          <PortalCard designated={designated} targets={targets} />
        </div>
      </div>
    </>
  )
}

type CardProps = { designated: SyncTarget | null; targets: SyncTarget[]; cloudLine?: string | null }

/** The agent on the computer that runs the schedule, if it can do `kind`. */
function runner(designated: SyncTarget | null, kind: AutomationKind) {
  if (!designated || !computerCan(designated, kind)) return null
  return designated.runtime.agents.find((a) => a.kinds?.includes(kind)) ?? null
}

// 1 ── email ───────────────────────────────────────────────────────────────

function EmailCard({ designated, targets, cloudLine }: CardProps) {
  const agent = runner(designated, 'email_check')
  const queued = useAutomationSync((s) => s.runNow.includes('email_check') || !!s.output?.state.email_check?.running)
  const elsewhere = !agent && targets.some((t) => computerCan(t, 'email_check'))
  return (
    <AutomationCard
      kind="email_check" icon="inbox" title="Check email" flow="New emails → application status"
      presets={[...INTERVALS, ...DAILY.slice(0, 2)]} designated={designated}
      blocker={agent || elsewhere ? null : <>Your agent can't read email yet. Connect Gmail in Claude (claude.ai → Settings → Connectors); your computer picks it up within 30 minutes.</>}
    >
      <Row label="Looks at">
        Emails received since the last check (each run starts an hour before the previous one, so nothing falls in between),
        read-only{agent?.mail ? ` (${agent.mail}, through ${agent.label})` : ''}: confirmations, assessments, interviews and their times,
        rejections, offers. It never sends, labels or deletes anything.
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, ...muted }}>
          Think it missed something?
          <button type="button" className="btn-secondary" disabled={!designated || !agent || queued}
            onClick={() => requestRunNow('email_check', { rescanDays: 30 })}
            style={{ fontSize: 11.5, padding: '1px 8px', opacity: !designated || !agent || queued ? 0.6 : 1 }}>
            Re-read the last 30 days
          </button>
          <span>Emails it has seen before are recognized, not applied twice.</span>
        </span>
      </Row>
      <Row label="Then"><AutoApplyChoice /></Row>
      {cloudLine && <Row label="Also">{cloudLine}</Row>}
    </AutomationCard>
  )
}

function AutoApplyChoice() {
  const prefs = useAccountPrefs()
  const set = useSetAutoApply()
  const on = prefs.data?.auto_apply_updates ?? true
  const disabled = prefs.isLoading || set.isPending
  const option = (value: boolean, label: string, hint: string) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
      <input type="radio" name="auto-apply" checked={on === value} disabled={disabled} onChange={() => set.mutate(value)} style={{ marginTop: 3 }} />
      <span>{label} <span style={muted}>— {hint}</span></span>
    </label>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {option(true, 'Update applications right away', 'when an email says it plainly; undo any change from Applications')}
      {option(false, 'Ask me first', 'every change waits in "Needs your input"')}
      <span style={muted}>Unclear ones (which application? how sure?) always wait for you. This also applies to what cloud agents report.</span>
    </div>
  )
}

// 2 ── job search ──────────────────────────────────────────────────────────

function SearchCard({ designated, targets, cloudLine }: CardProps) {
  const navigate = useNavigate()
  const search = useActiveSearch()
  const agent = runner(designated, 'job_search')
  const anyAgent = targets.some((t) => computerCan(t, 'job_search'))
  return (
    <AutomationCard
      kind="job_search" icon="search" title="Find new jobs" flow="Your criteria → Leads"
      presets={[INTERVALS[INTERVALS.length - 1], ...DAILY]} designated={designated}
      blocker={search ? null : (
        <>Add the roles to look for below, or <button type="button" className="btn-secondary" style={{ fontSize: 11.5, padding: '1px 8px' }} onClick={() => navigate('/agent')}>work them out with your agent</button></>
      )}
    >
      <Row label="Criteria"><Criteria brief={search?.brief ?? null} /></Row>
      <Row label="Then">
        New postings land in the <b>Leads</b> column, soonest deadline first; ones already there (or already applied to) are merged, not repeated.
        {agent ? ` Searched by ${agent.label}.` : !anyAgent && designated ? ' No agent on your computer can search the web yet.' : ''}
      </Row>
      {cloudLine && <Row label="Also">{cloudLine}</Row>}
    </AutomationCard>
  )
}

const REMOTE: { value: RemotePreference; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'remote', label: 'Remote' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'On-site' },
]

/** The search criteria (the active brief), editable in place. An edit makes
 *  a new active search; changing roles or places rewrites the summary. */
function Criteria({ brief }: { brief: SearchBrief | null }) {
  const edit = useEditBrief()
  const base: SearchBrief = brief ?? {
    summary: '', roles: [], seniority: null, locations: [], remote: 'any', needs_sponsorship: null, salary_min: null,
    industries: [], include_companies: [], exclude_companies: [], notes: null,
  }
  const save = (patch: Partial<SearchBrief>, resummarize = false) => {
    const next = parseBrief({ ...base, ...patch, ...(resummarize ? { summary: undefined } : {}) })
    if (next) edit.mutate(next)
  }
  const line = (label: string, field: ReactNode) => (
    <>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ minWidth: 0 }}>{field}</span>
    </>
  )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', columnGap: 10, rowGap: 3, alignItems: 'baseline' }}>
      {line('Roles', <EditableList separator=";" label="Roles" items={base.roles} placeholder="e.g. Product Manager; Product Analyst" onSave={(roles) => save({ roles }, true)} />)}
      {brief && <>
        {line('Where', <EditableList separator=";" label="Locations" items={base.locations} placeholder="Anywhere" onSave={(locations) => save({ locations }, true)} />)}
        {line('Work style', (
          <select aria-label="Remote" value={base.remote} style={select} onChange={(e) => save({ remote: e.target.value as RemotePreference })}>
            {REMOTE.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        ))}
        {line('Level', <EditableText label="Level" value={base.seniority} placeholder="Any level" onSave={(v) => save({ seniority: v || null })} />)}
        {line('Visa', (
          <select aria-label="Visa sponsorship" value={String(base.needs_sponsorship)} style={select}
            onChange={(e) => save({ needs_sponsorship: e.target.value === 'null' ? null : e.target.value === 'true' })}>
            <option value="null">Doesn't matter</option>
            <option value="true">Needs sponsorship</option>
            <option value="false">No sponsorship needed</option>
          </select>
        ))}
        {line('Min salary', <EditableText label="Minimum salary" value={base.salary_min} placeholder="Any" onSave={(v) => save({ salary_min: v || null })} />)}
        {line('Industries', <EditableList separator=";" label="Industries" items={base.industries} placeholder="Any" onSave={(industries) => save({ industries })} />)}
        {line('Look at first', <EditableList separator=";" label="Companies to look at first" items={base.include_companies} placeholder="None" onSave={(include_companies) => save({ include_companies })} />)}
        {line('Skip', <EditableList separator=";" label="Companies to skip" items={base.exclude_companies} placeholder="None" onSave={(exclude_companies) => save({ exclude_companies })} />)}
        {line('Notes', <EditableText label="Notes" value={base.notes} placeholder="Anything else" multiline onSave={(v) => save({ notes: v || null })} />)}
      </>}
      {edit.error && <span style={{ gridColumn: '1 / -1', ...muted, color: danger }}>{(edit.error as Error).message}</span>}
    </div>
  )
}

// 3 ── candidate portals ───────────────────────────────────────────────────

function PortalCard({ designated, targets }: CardProps) {
  const { automations } = useAutomations()
  const set = useSetAutomations()
  const { store, ready } = useStore()
  const quiet = automations.portal_check.quiet_days ?? 14
  const agent = runner(designated, 'portal_check')
  const elsewhere = !agent && targets.some((t) => computerCan(t, 'portal_check'))
  // Which applications qualify right now (the computer also skips ones it
  // looked at recently).
  const candidates = useQuery({
    queryKey: ['applications', 'portal-candidates', quiet],
    enabled: ready,
    queryFn: async () => {
      const ctx = await taskContext(store, null)
      return { quiet: pickQuietPortals(ctx.portal_apps, quiet, {}, Date.now()), withPortal: ctx.portal_apps.length }
    },
  })
  const [showAll, setShowAll] = useState(false)
  const names = candidates.data?.quiet.map((a) => a.company) ?? []

  return (
    <AutomationCard
      kind="portal_check" icon="external" title="Check candidate portals" flow="Applications that went quiet → application status"
      presets={[DAILY[2], DAILY[1], DAILY[0]]} designated={designated}
      blocker={agent || elsewhere ? null : <>Your agent can't use Chrome yet. Connect the Claude in Chrome extension to Claude Code; your computer picks it up within 30 minutes.</>}
    >
      <Row label="Looks at">
        Applications with a portal link and no news for{' '}
        <select aria-label="Days without news" value={quiet} style={select}
          onChange={(e) => set.mutate({ ...automations, portal_check: { ...automations.portal_check, quiet_days: Number(e.target.value) } })}>
          {QUIET_DAY_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
        {' '}— up to 5 per run, quietest first. It opens each portal in your Chrome and reads the status: read-only, it never clicks, types or signs in.
        <span style={{ display: 'block', ...muted }}>
          {candidates.data && (names.length
            ? <>Right now: {(showAll ? names : names.slice(0, 3)).join(', ')}{names.length > 3 && !showAll && (
                <> <button type="button" onClick={() => setShowAll(true)} style={{ font: 'inherit', color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>+{names.length - 3} more</button></>
              )}.</>
            : candidates.data.withPortal ? 'Right now none — every application with a portal link has had news recently.' : 'None of your applications has a portal link yet (add one on an application).')}
          {' '}Tip: use a Chrome profile that's only signed in to job sites.
        </span>
      </Row>
      <Row label="Then">
        Asks you before changing a stage — portal pages are less clear than emails — except a confirmed submission, which updates on its own.
        Portals that need you to sign in are listed in the run.
      </Row>
    </AutomationCard>
  )
}
