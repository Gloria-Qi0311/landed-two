// Workflow — the work Landed does for the user, laid out like My Resume: a
// list of steps grouped by stage in the middle column, the selected step on
// the right (who does it, when, its switch, what it needs, recent runs).
//   What to look for           the search criteria (the active brief)
//   1 Find jobs                agent search, job lists, company boards,
//                              remove duplicates, rank → Leads
//   2 Apply                    after the user approves in Leads: auto apply,
//                              mark as applied
//   3 Keep up to date          check email, check candidate portals
// A stage's switch sits on its heading in the list; a step with its own sits
// on its page. The selected step is the URL's hash (/workflow#email), so other
// pages link straight to one. The settings stay users.automations
// (packages/schema/src/automation.ts); a step gains its own executor or
// schedule as a field there when it gets one. Scheduled steps run on the
// user's computer (even with Landed closed — lib/automation-sync.ts);
// connected cloud agents also search and read email on their own schedule.
// Auto apply runs event-first in the open browser; already-open application
// tabs continue if Landed closes.
import { Children, useEffect, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AUTO_APPLY_CONCURRENCY, cloudAgentOn, cloudAgentSearches, DEFAULT_EMAIL_READERS, describeSchedule, INTERVAL_HOURS, pickAgents, pickQuietPortals, QUIET_DAY_CHOICES, WEEKDAYS,
  type Abilities, type AutomationKind, type AutomationRun, type Automations, type Schedule,
} from '@landed/schema/automation'
import { parseBrief, type RemotePreference, type SearchBrief } from '@landed/schema/search-brief'
import { ATS_LABELS } from '@landed/supply'
import { Icon } from './primitives'
import { PageHeader } from './shell'
import { EditableList, EditableText } from './editable'
import { AgentSourcesPicker } from './search-sources'
import { formatRelative } from '../lib/time'
import { useStore } from '../lib/store'
import { computerCan, designate, requestRecheck, requestRunNow, syncTargets, useAutomationSync, type SyncTarget } from '../lib/automation-sync'
import { taskContext, useAutomations, useSetAutomations } from '../hooks/automation'
import { useAccountPrefs, useSetAutoApply } from '../hooks/inbox'
import { searchComputer, chosenSearchTargets, useActiveSearch, useEditBrief } from '../hooks/search'
import { useFollowedBoards, useSupplyRefresh } from '../hooks/supply'
import { useAgentConnections } from '../hooks/agents'
import { useRuntimes } from '../hooks/runtimes'
import { requestAutoApplyRun, useAutoApplyControl } from '../hooks/auto-apply'
import { card, danger, muted, mutedLarge } from './ui'

const ok = 'oklch(0.45 0.13 155)'
const smallBtn = { fontSize: 11.5, padding: '3px 10px' } as const

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
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select aria-label="Schedule" value={current} disabled={disabled} style={{ fontSize: 12.5 }}
        onChange={(e) => onChange(presets.find((p) => p.key === e.target.value)!.schedule(time))}>
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        {!presets.some((p) => p.key === current) && <option value={current}>{describeSchedule(schedule)}</option>}
      </select>
      {schedule.kind === 'daily' && (
        <input type="time" aria-label="Time" value={time} disabled={disabled} style={{ fontSize: 12.5 }}
          onChange={(e) => e.target.value && onChange({ ...schedule, time: e.target.value })} />
      )}
    </span>
  )
}

// ── small pieces ──────────────────────────────────────────────────────────

function Switch({ on, label, disabled, onChange, small = false }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void; small?: boolean }) {
  return (
    <input type="checkbox" className="switch" aria-label={`${label}: ${on ? 'on' : 'off'}`} checked={on} disabled={disabled}
      onClick={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.checked)}
      style={small ? { transform: 'scale(0.8)', transformOrigin: 'right center' } : undefined} />
  )
}

/** What a step needs before it can run (red), or what the computer is checking. */
function Needs({ children, waiting = false }: { children: ReactNode; waiting?: boolean }) {
  return <div style={{ ...mutedLarge, color: waiting ? 'var(--fg-muted)' : danger }}>{children}</div>
}

/** A white card of settings, one row each: what it is on the left, the control on the right. */
function Settings({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean)
  return (
    <section style={card}>
      {title && <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>}
      <div>
        {rows.map((row, i) => <div key={i} style={{ borderTop: i > 0 || title ? '1px solid var(--border-subtle)' : 'none' }}>{row}</div>)}
      </div>
    </section>
  )
}

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 0.7fr) minmax(240px, 1.6fr)', gap: 16, alignItems: 'start', padding: '10px 0', fontSize: 12.5 }}>
      <div>
        <div style={{ fontWeight: 500, color: 'var(--fg)' }}>{label}</div>
        {help && <div style={muted}>{help}</div>}
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
}

/** The right side: the step's title, what it does, its controls, then its settings. */
function Pane({ title, help, controls, children }: { title: string; help: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{title}</div>
          <div style={mutedLarge}>{help}</div>
        </div>
        {controls && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 2 }}>{controls}</div>}
      </div>
      {children}
    </div>
  )
}

/** A switch with its label, for a pane's head. */
function LabeledSwitch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', color: on ? 'var(--fg)' : 'var(--fg-muted)' }}>
      {label} {on ? 'on' : 'off'}
      <Switch on={on} label={label} disabled={disabled} onChange={onChange} />
    </label>
  )
}

function RunNow({ disabled, busy, onClick }: { disabled: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn-secondary" disabled={disabled} onClick={onClick} style={{ ...smallBtn, opacity: disabled ? 0.6 : 1 }}>
      <Icon name="refresh" size={11} /> {busy ? 'Running…' : 'Run now'}
    </button>
  )
}

/** When a scheduled step runs next, and when it last ran. */
function useScheduleState(kind: AutomationKind) {
  const { automations } = useAutomations()
  const sync = useAutomationSync()
  const state = sync.output?.state[kind]
  const queued = sync.runNow.includes(kind)
  const running = !!state?.running || queued
  const text = running ? 'Running now…'
    : !automations[kind].enabled ? 'Off'
      : state?.next_run_at ? `Next ${when(state.next_run_at)}` : 'Scheduled'
  return { running, text: `${text}${state?.last_success_at ? ` · last ran ${formatRelative(state.last_success_at)}` : ''}` }
}

/** A run that had nothing to do because none of the computer's agents is
 *  ticked: the user's choice, not news. Older Landed for Mac versions logged
 *  one each time ("Skipped: …", "No agent ticked…"); they're left out. */
const skipped = (r: AutomationRun) => r.status === 'ok' && /^(Skipped:|No agent ticked)/.test(r.summary ?? '')

function RecentRuns({ kind }: { kind: AutomationKind }) {
  const stored = useAutomationSync((s) => s.stored)
  // Select the stored list as is (a new filtered array each time would re-render forever).
  const all = useAutomationSync((s) => s.output?.runs)
  const runs = (all ?? []).filter((r: AutomationRun) => r.kind === kind && !skipped(r)).slice(0, 8)
  return (
    <section style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Recent runs</div>
      {runs.length === 0 ? <div style={muted}>No runs yet.</div> : (
        <div>
          {runs.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '7px 0', borderTop: '1px solid var(--border-subtle)' }}>
              <span title={skipped(r) ? 'Skipped' : undefined} style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: skipped(r) ? 'var(--border)' : r.status === 'ok' ? 'oklch(0.65 0.17 155)' : r.status === 'running' ? 'var(--accent)' : 'oklch(0.62 0.17 28)' }} />
              <span style={{ color: 'var(--fg-muted)', width: 150, flexShrink: 0 }}>{when(r.started_at)}</span>
              <span style={{ flex: 1, minWidth: 0, color: r.status === 'error' ? danger : 'var(--fg)' }}>
                {r.status === 'running' ? 'Running…' : r.status === 'error' ? r.error : [r.summary, stored[r.id]?.text].filter(Boolean).join(' → ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── everything the list and the panes read ────────────────────────────────

/** The agent on the computer that runs the schedule, if it can do `kind`. */
function runner(designated: SyncTarget | null, kind: AutomationKind) {
  if (!designated || !computerCan(designated, kind)) return null
  return designated.runtime.agents.find((a) => a.kinds?.includes(kind)) ?? null
}

type Connection = 'ok' | 'checking' | 'confirming' | 'missing'

/** Whether the computers' agents reach a connector (Gmail, Chrome). While
 *  they don't, the computers look again as soon as the user comes back to the
 *  page (they connect it in claude.ai or Chrome, then return), and every
 *  minute while it's open, instead of at their half-hourly check. */
function useConnection(which: 'mail' | 'chrome', targets: SyncTarget[], reached: boolean): Connection {
  const qc = useQueryClient()
  const abilities = useAutomationSync((s) => s.abilities)
  const recheckAt = useAutomationSync((s) => s.recheckAt)
  const seen = targets.map((t) => abilities[t.runtime.id]).filter((a): a is Abilities => !!a)
  const found = seen.some((a) => (which === 'mail' ? a.mail === 'ready' : a.chrome))
  const waiting = !reached && !found && targets.length > 0
  // The computer found it: its agents' new abilities are on the server now.
  useEffect(() => { if (found && !reached) void qc.invalidateQueries({ queryKey: ['runtimes'] }) }, [found, reached, qc])
  useEffect(() => {
    if (!waiting) return
    const visible = () => document.visibilityState === 'visible'
    const back = () => { if (visible()) requestRecheck(true) }
    back()
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    const timer = setInterval(() => { if (visible()) requestRecheck(false) }, 60_000)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
      clearInterval(timer)
    }
  }, [waiting])
  if (reached || found) return 'ok'
  if (which === 'mail' && seen.some((a) => a.mail === 'confirming')) return 'confirming'
  // Only computers that report what they reach answer a recheck (an older Landed for Mac doesn't).
  const looked = recheckAt !== null && seen.some((a) => !!a.checked_at && Date.parse(a.checked_at) >= recheckAt)
  if (seen.length && recheckAt !== null && !looked && Date.now() - recheckAt < 2 * 60_000) return 'checking'
  return 'missing'
}

function useWorkflow() {
  const { automations, loaded } = useAutomations()
  const set = useSetAutomations()
  const runtimes = useRuntimes().data
  const sync = useAutomationSync()
  const targets = syncTargets(runtimes ?? [])
  const designated = designate(targets, automations)
  const cloud = (useAgentConnections().data ?? []).filter((c) => !c.revoked_at && c.scopes.includes('tasks:read'))
  const search = useActiveSearch()
  const boards = useFollowedBoards().data ?? []
  const supply = useSupplyRefresh()
  const choices = searchComputer(runtimes, automations).map((t) => t.agent)
  const searchers = chosenSearchTargets(runtimes, automations).map((t) => t.agent.label)
  const anyAgent = targets.some((t) => computerCan(t, 'job_search'))
  // Who reads email: the computer's agents that can (Claude Code once its
  // mail connector is found; listed before that so it can be ticked) and the
  // cloud agents, each ticked on its own.
  const readers = automations.email_check.readers ?? DEFAULT_EMAIL_READERS
  const mailAgents = designated ? designated.runtime.agents.filter((a) => a.kinds?.includes('email_check') || a.id === 'claude') : []
  const localReaders = pickAgents(mailAgents, readers)
  const emailAgent = localReaders.length ? runner(designated, 'email_check') : null
  // No computer agent ticked: nothing on the computer to wait for.
  const mail = useConnection('mail', targets, localReaders.length === 0 || !!emailAgent || targets.some((t) => computerCan(t, 'email_check')))
  const portalAgent = runner(designated, 'portal_check')
  const chrome = useConnection('chrome', targets, !!portalAgent || targets.some((t) => computerCan(t, 'portal_check')))
  const auto = {
    ready: useAutoApplyControl((s) => s.ready),
    busy: useAutoApplyControl((s) => s.busy),
    queued: useAutoApplyControl((s) => s.queued),
    active: useAutoApplyControl((s) => s.active),
    blocked: useAutoApplyControl((s) => s.blocked),
    awaiting: useAutoApplyControl((s) => s.awaiting_confirmation),
    note: useAutoApplyControl((s) => s.note),
    lastStarted: useAutoApplyControl((s) => s.last_started_at),
  }
  const save = (next: Automations) => set.mutate(next)
  return {
    automations, loaded, set, save, sync, targets, designated, cloud, search, boards, supply, choices, searchers, anyAgent,
    emailAgent, mail, readers, mailAgents, localReaders, portalAgent, chrome, auto,
    anyPaired: (runtimes ?? []).some((r) => !r.revoked_at && r.last_seen_at),
    outdated: (runtimes ?? []).some((r) => r.online && r.agents.length && !r.agents.some((a) => a.kinds?.includes('automation_sync'))),
  }
}
type W = ReturnType<typeof useWorkflow>

// ── the steps ─────────────────────────────────────────────────────────────

type StepId = 'criteria' | 'agents' | 'lists' | 'boards' | 'dedupe' | 'rank' | 'apply' | 'applied' | 'email' | 'portals'
const STEP_IDS: StepId[] = ['criteria', 'agents', 'lists', 'boards', 'dedupe', 'rank', 'apply', 'applied', 'email', 'portals']
/** Older links (#find, #track) still land on a step. */
const ALIASES: Record<string, StepId> = { find: 'agents', track: 'email' }

type Dot = 'on' | 'off' | 'needs'
type Status = { dot: Dot; text: string }

/** "Claude Code every 3 hours · ChatGPT on its own": the schedule is only
 *  for the computer's agents; cloud agents run when they run. */
function whoAndWhen(local: string[], cloud: string[], schedule: string): string {
  const mine = local.length ? `${local.join(', ')} ${schedule}` : ''
  const theirs = cloud.length ? `${cloud.join(', ')} on ${cloud.length === 1 ? 'its' : 'their'} own` : ''
  return [mine, theirs].filter(Boolean).join(' · ')
}

function statuses(w: W): Record<StepId, Status> {
  const a = w.automations
  const find = a.job_search
  const sources = find.sources!
  const findOff: Status = { dot: 'off', text: 'Off' }
  const sched = (s: Schedule) => describeSchedule(s).replace(/^Every /, 'every ')
  return {
    criteria: w.search ? { dot: 'on', text: w.search.brief.roles.join(' · ') || 'Set' } : { dot: 'needs', text: 'Not set yet' },
    agents: (() => {
      if (!find.enabled) return findOff
      const cloud = w.cloud.filter((c) => cloudAgentSearches(sources, c.id)).map((c) => c.display_name)
      const text = whoAndWhen(w.searchers, cloud, sched(find.schedule))
      if (text) return { dot: 'on' as const, text }
      return sources.agents.length === 0 ? { dot: 'off' as const, text: 'No agent ticked' } : { dot: 'needs' as const, text: 'No agent online' }
    })(),
    lists: !find.enabled || !sources.job_lists ? findOff : { dot: 'on', text: 'SimplifyJobs · every 6 hours' },
    boards: !find.enabled || !sources.company_boards ? findOff : { dot: 'on', text: `${w.boards.length} ${w.boards.length === 1 ? 'company' : 'companies'} · every 6 hours` },
    dedupe: !find.enabled ? findOff : { dot: 'on', text: 'Landed AI · each batch' },
    rank: !find.enabled ? findOff : { dot: 'on', text: 'Landed AI · each batch' },
    apply: !a.auto_apply.enabled ? { dot: 'off', text: 'Off' }
      : !w.auto.ready ? { dot: 'needs', text: a.auto_apply.executor === 'extension' ? 'Needs the extension here' : 'Needs the selected agent connected' }
        : w.auto.blocked > 0 ? { dot: 'needs', text: `${w.auto.blocked} ${w.auto.blocked === 1 ? 'needs' : 'need'} you` }
          : { dot: 'on', text: `When you approve · up to ${a.auto_apply.max_concurrent}` },
    applied: { dot: 'on', text: 'When the portal confirms' },
    email: (() => {
      if (!a.email_check.enabled) return { dot: 'off' as const, text: `Off · ${sched(a.email_check.schedule)}` }
      const cloudReaders = w.cloud.filter((c) => cloudAgentOn(w.readers, c.id)).map((c) => c.display_name)
      if (w.localReaders.length && w.mail === 'missing') return { dot: 'needs' as const, text: 'Needs your email connected' }
      const text = whoAndWhen(w.localReaders.map((x) => x.label), cloudReaders, sched(a.email_check.schedule))
      return text ? { dot: 'on' as const, text } : { dot: 'off' as const, text: 'No agent ticked' }
    })(),
    portals: !a.portal_check.enabled ? { dot: 'off', text: `Off · ${sched(a.portal_check.schedule)}` }
      : w.chrome === 'missing' ? { dot: 'needs', text: 'Needs Chrome connected' }
        : { dot: 'on', text: `${w.portalAgent?.label ?? 'Your agent'} · ${sched(a.portal_check.schedule)}` },
  }
}

// ── page ──────────────────────────────────────────────────────────────────

export function WorkflowPage() {
  const w = useWorkflow()
  const navigate = useNavigate()
  const { hash } = useLocation()
  const all = statuses(w)
  const picked = hash.slice(1)
  const fromHash = ALIASES[picked] ?? STEP_IDS.find((id) => id === picked)
  // Nothing picked: what to look for until there is a search, else the first
  // step that needs the user, else agent search.
  const active: StepId = fromHash
    ?? (!w.search ? 'criteria' : (['agents', 'apply', 'email', 'portals'] as StepId[]).find((id) => all[id].dot === 'needs') ?? 'agents')
  const select = (id: StepId) => navigate({ hash: id }, { replace: true })

  return (
    <>
      <PageHeader
        title="Workflow"
        subtitle={w.designated
          ? `How new jobs reach you and what happens after you approve · scheduled steps run on ${w.designated.runtime.name}, even with Landed closed`
          : w.anyPaired ? 'How new jobs reach you and what happens after you approve · your computer is offline'
            : 'How new jobs reach you and what happens after you approve · connect your computer on the Agent page for the scheduled steps'}
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <StepsList w={w} all={all} active={active} onSelect={select} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 40px', minWidth: 0 }}>
          {w.outdated && !w.designated && (
            <div style={{ ...mutedLarge, color: danger, marginBottom: 12 }}>
              Landed for Mac on your computer needs an update for scheduled steps: open it again (or run <code>pnpm landed start</code>).
            </div>
          )}
          {w.sync.error && <div style={{ ...mutedLarge, color: danger, marginBottom: 12 }}>Couldn't reach your computer: {w.sync.error}</div>}
          {w.set.error && <div role="alert" style={{ ...mutedLarge, color: danger, marginBottom: 12 }}>Couldn't save that change: {(w.set.error as Error).message}</div>}
          <StepPane id={active} w={w} onSelect={select} />
        </div>
      </div>
    </>
  )
}

// ── the middle column ─────────────────────────────────────────────────────

const railLabel = { fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 10px 6px', display: 'flex', alignItems: 'center', gap: 6 } as const
const DOT: Record<Dot, string> = { on: 'oklch(0.65 0.17 155)', off: 'var(--border)', needs: 'oklch(0.62 0.17 28)' }

function StepsList({ w, all, active, onSelect }: { w: W; all: Record<StepId, Status>; active: StepId; onSelect: (id: StepId) => void }) {
  const item = (id: StepId, icon: string, title: string) => (
    <RailItem key={id} active={active === id} icon={icon} title={title} status={all[id]} onClick={() => onSelect(id)} />
  )
  const a = w.automations
  return (
    <aside style={{ width: 250, flexShrink: 0, borderRight: '0.5px solid var(--border)', background: 'var(--surface-2)', padding: 10, overflowY: 'auto' }}>
      <div style={railLabel}>What to look for</div>
      {item('criteria', 'target', 'Search criteria')}

      <div style={railLabel}>
        1 · Find jobs
        <span style={{ marginLeft: 'auto', display: 'flex' }}>
          <Switch small on={a.job_search.enabled} label="Find jobs" disabled={!w.loaded || w.set.isPending} onChange={(enabled) => w.save({ ...a, job_search: { ...a.job_search, enabled } })} />
        </span>
      </div>
      {item('agents', 'sparkle', 'Agent search')}
      {item('lists', 'table', 'Job lists')}
      {item('boards', 'cards', 'Company boards')}
      {item('dedupe', 'filter', 'Remove duplicates')}
      {item('rank', 'sort', 'Rank')}

      <div style={railLabel}>
        2 · Apply
        <span style={{ marginLeft: 'auto', display: 'flex' }}>
          <Switch small on={a.auto_apply.enabled} label="Auto apply" disabled={!w.loaded || w.set.isPending} onChange={(enabled) => w.save({ ...a, auto_apply: { ...a.auto_apply, enabled } })} />
        </span>
      </div>
      <div style={{ ...muted, padding: '0 10px 6px' }}>After you approve a job in Leads</div>
      {item('apply', 'wand', 'Auto apply')}
      {item('applied', 'check', 'Mark as applied')}

      <div style={railLabel}>3 · Keep up to date</div>
      {item('email', 'inbox', 'Check email')}
      {item('portals', 'external', 'Check candidate portals')}
    </aside>
  )
}

function RailItem({ active, icon, title, status, onClick }: { active: boolean; icon: string; title: string; status: Status; onClick: () => void }) {
  return (
    <div onClick={onClick} className="sidebar-item" role="button" tabIndex={0} aria-current={active ? 'true' : undefined}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{
        padding: '8px 10px', borderRadius: 6, marginBottom: 4, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3,
        background: active ? 'var(--surface)' : 'transparent', border: `0.5px solid ${active ? 'var(--border)' : 'transparent'}`,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name={icon} size={12} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span title={status.dot === 'needs' ? 'Needs you' : status.dot === 'on' ? 'On' : 'Off'} style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: DOT[status.dot] }} />
      </div>
      <div style={{ fontSize: 10.5, color: status.dot === 'needs' ? danger : 'var(--fg-muted)', paddingLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.text}</div>
    </div>
  )
}

// ── the right side ────────────────────────────────────────────────────────

/** The built-in executor: Landed's own logic, in the browser. */
const LANDED_AI = <span>Landed AI <span style={muted}>· built in, no tokens</span></span>

/** Who does a step that an agent will also be able to do: Landed AI for now.
 *  The agents on the user's computer are listed but not selectable until
 *  that step's agent layer ships (#146 duplicates, #147 ranking); it then
 *  stores the choice in its own field of users.automations. */
function ExecutorSelect({ w, label, soon }: { w: W; label: string; soon: string }) {
  const agents = [...new Map(w.targets.flatMap((t) => t.runtime.agents).map((a) => [a.id, a])).values()]
  return (
    <>
      <select aria-label={label} value="landed" style={{ fontSize: 12.5, alignSelf: 'flex-start' }} onChange={() => {}}>
        <option value="landed">Landed AI (default)</option>
        {agents.map((a) => <option key={a.id} value={a.id} disabled>{a.label} · coming soon</option>)}
      </select>
      <span style={muted}>{soon}</span>
    </>
  )
}

function StepPane({ id, w, onSelect }: { id: StepId; w: W; onSelect: (id: StepId) => void }) {
  switch (id) {
    case 'criteria': return <CriteriaPane />
    case 'agents': return <AgentsPane w={w} onSelect={onSelect} />
    case 'lists': return <ListsPane w={w} />
    case 'boards': return <BoardsPane w={w} />
    case 'dedupe': return <DedupePane w={w} />
    case 'rank': return <RankPane w={w} />
    case 'apply': return <ApplyPane w={w} />
    case 'applied': return <AppliedPane />
    case 'email': return <EmailPane w={w} />
    case 'portals': return <PortalsPane w={w} />
  }
}

/** Find jobs is one stage: its switch and Run now on each of its steps. */
function FindControls({ w }: { w: W }) {
  const a = w.automations
  const state = useScheduleState('job_search')
  const cantRun = !w.designated || !w.search || state.running
  return (
    <>
      <RunNow disabled={cantRun} onClick={() => { requestRunNow('job_search'); w.supply.refresh?.() }} />
      <LabeledSwitch on={a.job_search.enabled} label="Find jobs" disabled={!w.loaded || w.set.isPending}
        onChange={(enabled) => w.save({ ...a, job_search: { ...a.job_search, enabled } })} />
    </>
  )
}

function CriteriaPane() {
  const navigate = useNavigate()
  return (
    <Pane title="What to look for" help="Find jobs searches for these: your agents, the job lists and the company boards alike. Click a line to change it."
      controls={<button type="button" className="btn-secondary" onClick={() => navigate('/agent')} style={smallBtn}>Work them out with your agent</button>}>
      <section style={card}><Criteria /></section>
    </Pane>
  )
}

function AgentsPane({ w, onSelect }: { w: W; onSelect: (id: StepId) => void }) {
  const a = w.automations.job_search
  const state = useScheduleState('job_search')
  const setSources = (sources: typeof a.sources) => w.save({ ...w.automations, job_search: { ...a, sources } })
  return (
    <Pane title="Agent search" help="Your agents search the web for postings that fit what you're looking for, including ones no list has yet: the ones on your computer on the schedule below, connected agents whenever they run. Each uses your own subscription, and what they find is merged."
      controls={<FindControls w={w} />}>
      {!w.search && <Needs>Add the roles to look for first. <button type="button" className="btn-secondary" style={smallBtn} onClick={() => onSelect('criteria')}>What to look for</button></Needs>}
      {!w.anyAgent && w.designated && <Needs>No agent on your computer can search the web yet.</Needs>}

      <Settings>
        <Field label="Done by" help="Each ticked agent searches. Untick them all and only the job lists and company boards look.">
          {w.choices.length || w.cloud.length
            ? <AgentSourcesPicker agents={w.choices} sources={a.sources!} cloud={w.cloud.map((c) => ({ id: c.id, name: c.display_name, lastSeen: c.last_seen_at }))} disabled={w.set.isPending} onChange={setSources} />
            : <span style={muted}>No agent online that can search. Connect your computer on the Agent page.</span>}
        </Field>
        <Field label="When" help="For the agents on your computer. Connected agents search when they run, on their own schedule.">
          <SchedulePicker schedule={a.schedule} presets={[...INTERVALS.filter((p) => ['h3', 'h6', 'h12'].includes(p.key)), ...DAILY]} disabled={!w.loaded}
            onChange={(schedule) => w.save({ ...w.automations, job_search: { ...a, schedule } })} />
          <span style={muted}>{w.searchers.length ? state.text : 'Not used: no agent on your computer is ticked. Connected agents search when they run.'}</span>
        </Field>
      </Settings>
      <RecentRuns kind="job_search" />
    </Pane>
  )
}

function ListsPane({ w }: { w: W }) {
  const a = w.automations.job_search
  const sources = a.sources!
  return (
    <Pane title="Job lists" help="SimplifyJobs publishes new-grad and internship lists as data, with posting dates and which are closed. Landed reads them itself."
      controls={<FindControls w={w} />}>
      <Settings>
        <Field label="Use these lists"><span><Switch on={sources.job_lists} label="Job lists" disabled={w.set.isPending} onChange={(job_lists) => w.save({ ...w.automations, job_search: { ...a, sources: { ...sources, job_lists } } })} /></span></Field>
        <Field label="Done by">{LANDED_AI}</Field>
        <Field label="When"><span>Every 6 hours while Landed is open, and right after you change what to look for</span></Field>
        <Field label="What's kept"><span>Open postings from the last 30 days with one of your roles in the title, in one of your places. The new-grad list, the internship list or both, from the level you're looking for.</span></Field>
      </Settings>
    </Pane>
  )
}

function BoardsPane({ w }: { w: W }) {
  const a = w.automations.job_search
  const sources = a.sources!
  return (
    <Pane title="Company boards" help="The Greenhouse, Lever and Ashby job boards of companies you follow. Landed reads them itself."
      controls={<FindControls w={w} />}>
      <Settings>
        <Field label="Check these boards"><span><Switch on={sources.company_boards} label="Company boards" disabled={w.set.isPending} onChange={(company_boards) => w.save({ ...w.automations, job_search: { ...a, sources: { ...sources, company_boards } } })} /></span></Field>
        <Field label="Done by">{LANDED_AI}</Field>
        <Field label="When"><span>Every 6 hours while Landed is open</span></Field>
        <Field label="What's kept"><span>Postings with one of your roles and places, at your level, newest first, at most 15 a board.</span></Field>
      </Settings>
      <section style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Companies followed</div>
        <div style={muted}>Companies under Look at first, ones you applied to, and ones you approved a lead from. × moves one to Skip. Worked out in this browser, never sent anywhere.</div>
        {w.search ? <FollowedCompanies brief={w.search.brief} /> : <span style={muted}>Add what to look for first.</span>}
      </section>
    </Pane>
  )
}

function DedupePane({ w }: { w: W }) {
  return (
    <Pane title="Remove duplicates" help="Each new batch of postings is matched against your leads and applications, so every job shows up once."
      controls={<FindControls w={w} />}>
      <Settings>
        <Field label="Done by">
          <ExecutorSelect w={w} label="Who removes duplicates" soon="Soon your own agent can judge the close calls (same company, similar title). Until then Landed AI does it." />
        </Field>
        <Field label="When"><span>Each new batch</span></Field>
        <Field label="Same job when"><span>It's the same posting or link, or the same company with the same or a nearly identical title. One lead keeps every source that found it.</span></Field>
        <Field label="Already applied"><span>A job you've applied to doesn't come back as a lead.</span></Field>
      </Settings>
    </Pane>
  )
}

function RankPane({ w }: { w: W }) {
  return (
    <Pane title="Rank" help="Leads are ordered by how worth applying to they are, highest first."
      controls={<FindControls w={w} />}>
      <Settings>
        <Field label="Done by">
          <ExecutorSelect w={w} label="Who ranks" soon="Soon your own agent can rank: it reads each posting against your resume and writes its reasons. Until then Landed AI ranks." />
        </Field>
        <Field label="When"><span>Each new batch</span></Field>
        <Field label="Fit"><span>How well the title, place and skills match what you're looking for and your resume. Each card shows its reasons.</span></Field>
        <Field label="Urgency"><span>How soon it closes: its deadline, else when it was posted.</span></Field>
        <Field label="Filtered out"><span>Postings that rule you out in so many words (graduation date, sponsorship, clearance) are hidden from Leads. You can put any back.</span></Field>
      </Settings>
    </Pane>
  )
}

function ApplyPane({ w }: { w: W }) {
  const navigate = useNavigate()
  const a = w.automations.auto_apply
  const save = (next: Partial<typeof a>) => w.save({ ...w.automations, auto_apply: { ...a, ...next } })
  const { auto } = w
  const selectedAgent = a.executor === 'extension' ? null : w.cloud.find((c) => c.id === a.executor) ?? null
  const status = auto.active ? `Applying to ${auto.active} now`
    : auto.queued ? `${auto.queued} approved ${auto.queued === 1 ? 'job is' : 'jobs are'} ready`
      : auto.awaiting ? `${auto.awaiting} waiting for the portal's confirmation`
        : 'No approved jobs are waiting'
  return (
    <Pane title="Auto apply" help="When you approve a job in Leads, Landed applies to it: the right resume, the form filled, your agent's check, and Submit only when every check passes. Approving is the go-ahead for that one job only."
      controls={<>
        <RunNow disabled={auto.busy} busy={auto.busy} onClick={requestAutoApplyRun} />
        <LabeledSwitch on={a.enabled} label="Auto apply" disabled={!w.loaded || w.set.isPending} onChange={(enabled) => save({ enabled })} />
      </>}>
      {!auto.ready && <Needs>{a.executor === 'extension'
        ? 'Install or reload the Landed browser extension in this browser before approved jobs can start.'
        : 'The selected personal agent is no longer connected. Reconnect it or choose another executor.'}</Needs>}
      {auto.blocked > 0 && (
        <Needs>
          {auto.blocked} approved {auto.blocked === 1 ? 'application needs' : 'applications need'} you.{' '}
          <button type="button" className="btn-secondary" onClick={() => navigate('/applications')} style={smallBtn}>Open Applications</button>
        </Needs>
      )}
      <Settings>
        <Field label="Done by" help={a.executor === 'extension'
          ? 'The extension uses this signed-in browser; once a tab is open, it keeps going if you leave Landed.'
          : 'The selected personal agent receives one approved job, its resume and your shared Landed context.'}>
          <select aria-label="Auto apply executor" value={a.executor} disabled={!w.loaded || w.set.isPending} style={{ fontSize: 12.5, alignSelf: 'flex-start' }}
            onChange={(event) => save({ executor: event.target.value })}>
            <option value="extension">Landed extension</option>
            {w.cloud.map((connection) => <option key={connection.id} value={connection.id}>{connection.display_name}</option>)}
            {!selectedAgent && a.executor !== 'extension' && <option value={a.executor}>Disconnected agent</option>}
          </select>
          <span style={muted}>{a.executor === 'extension'
            ? 'Fills in this browser; your local agent reviews the form.'
            : `${selectedAgent?.display_name ?? 'This agent'} uses your resume and saved answers. Missing questions come back to Needs your input and become shared answers after you reply.`}</span>
        </Field>
        <Field label="When"><span>When you approve a job in Leads, highest priority first</span></Field>
        <Field label="At most">
          <select aria-label="Maximum simultaneous applications" value={a.max_concurrent} disabled={!w.loaded || w.set.isPending} style={{ fontSize: 12.5, alignSelf: 'flex-start' }}
            onChange={(event) => save({ max_concurrent: Number(event.target.value) })}>
            {AUTO_APPLY_CONCURRENCY.map((count) => <option key={count} value={count}>{count} at a time</option>)}
          </select>
        </Field>
        <Field label="Right now"><span>{status}{auto.lastStarted && <span style={muted}> · last started {formatRelative(auto.lastStarted)}</span>}</span></Field>
        <Field label="Stops for you"><span>Sign-in, account creation, a CAPTCHA, missing answers or files, review flags or an unclear final button stop only that job, and the application says why.</span></Field>
      </Settings>
      {auto.note && <div role="status" style={muted}>{auto.note}</div>}
    </Pane>
  )
}

function AppliedPane() {
  return (
    <Pane title="Mark as applied" help="Once a portal shows its confirmation page, the application moves to Applied on its own.">
      <Settings>
        <Field label="Done by">{LANDED_AI}</Field>
        <Field label="When"><span>When the portal shows its confirmation page, dated then</span></Field>
        <Field label="No confirmation"><span>It waits as “Submitted · waiting for confirmation” until an email or a portal check confirms it.</span></Field>
      </Settings>
    </Pane>
  )
}

/** A scheduled status step's own switch and Run now. */
function StepControls({ w, kind, label, blocked }: { w: W; kind: 'email_check' | 'portal_check'; label: string; blocked: boolean }) {
  const a = w.automations[kind]
  const state = useScheduleState(kind)
  return (
    <>
      <RunNow disabled={!w.designated || blocked || state.running} onClick={() => requestRunNow(kind)} />
      <LabeledSwitch on={a.enabled} label={label} disabled={!w.loaded || w.set.isPending} onChange={(enabled) => w.save({ ...w.automations, [kind]: { ...a, enabled } })} />
    </>
  )
}

function EmailPane({ w }: { w: W }) {
  const a = w.automations.email_check
  const state = useScheduleState('email_check')
  const agent = w.emailAgent
  const signedOut = w.targets.some((t) => t.runtime.agents.some((x) => x.id === 'claude' && x.auth === 'signed_out'))
  const cantRescan = !w.designated || !agent || state.running
  return (
    <Pane title="Check email" help="Reads the email you received since the last check (confirmations, tests, interviews and their times, rejections, offers) and updates your applications. Read-only: it never sends, labels or deletes anything."
      controls={<StepControls w={w} kind="email_check" label="Check email" blocked={w.mail !== 'ok'} />}>
      {w.mail === 'checking' && <Needs waiting>Checking whether your agent can read your email…</Needs>}
      {w.mail === 'confirming' && <Needs waiting>Your email is connected in Claude. Making sure your agent can read it: this takes a moment.</Needs>}

      {w.mail === 'missing' && w.localReaders.length > 0 && (signedOut
        ? <Needs>Claude Code is signed out. Run <code>claude auth login</code> in Terminal, finish signing in, then come back to this page: Landed checks again right away.</Needs>
        : <Needs>Your agent can't read email yet. Run <code>claude auth login</code> in Terminal, connect Gmail in Claude (Settings → Connectors), then come back to this page: Landed checks again right away.</Needs>)}
      <Settings>
        <Field label="Done by" help="Each ticked agent reads it. Untick them all and nobody checks email.">
          {w.mailAgents.length || w.cloud.length
            ? <AgentSourcesPicker agents={w.mailAgents} sources={w.readers} cloud={w.cloud.map((c) => ({ id: c.id, name: c.display_name, lastSeen: c.last_seen_at }))} doing="Reads your email"
                disabled={w.set.isPending} onChange={(readers) => w.save({ ...w.automations, email_check: { ...a, readers } })} />
            : <span style={muted}>An agent on your computer that can read your email, or a connected agent</span>}
          {agent?.mail && <span style={{ ...muted, color: ok }}>{agent.label} reads {agent.mail}, read-only</span>}
        </Field>
        <Field label="When" help="For the agent on your computer. Connected agents read it when they run, on their own schedule.">
          <SchedulePicker schedule={a.schedule} presets={[...INTERVALS, ...DAILY.slice(0, 2)]} disabled={!w.loaded}
            onChange={(schedule) => w.save({ ...w.automations, email_check: { ...a, schedule } })} />
          <span style={muted}>{w.localReaders.length ? state.text : 'Not used: no agent on your computer is ticked'}</span>
        </Field>
        <Field label="Then"><AutoApplyChoice /></Field>
        <Field label="Missed something?" help="Emails it has seen before are recognized, not applied twice">
          <button type="button" className="btn-secondary" disabled={cantRescan} onClick={() => requestRunNow('email_check', { rescanDays: 30 })}
            style={{ ...smallBtn, alignSelf: 'flex-start', opacity: cantRescan ? 0.6 : 1 }}>
            Re-read the last 30 days
          </button>
        </Field>
      </Settings>
      <RecentRuns kind="email_check" />
    </Pane>
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
      <span style={muted}>Unclear ones (which application? how sure?) always wait for you.</span>
    </div>
  )
}

function PortalsPane({ w }: { w: W }) {
  const { store, ready } = useStore()
  const a = w.automations.portal_check
  const state = useScheduleState('portal_check')
  const agent = w.portalAgent
  const quiet = a.quiet_days ?? 14
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
  const names = candidates.data?.quiet.map((x) => x.company) ?? []
  return (
    <Pane title="Check candidate portals" help="Opens the portals of applications that went quiet in your Chrome and reads their status. Read-only: it never clicks, types or signs in."
      controls={<StepControls w={w} kind="portal_check" label="Check portals" blocked={w.chrome !== 'ok'} />}>
      {w.chrome === 'checking' && <Needs waiting>Checking whether your agent can use Chrome…</Needs>}
      {w.chrome === 'missing' && <Needs>Your agent can't use Chrome yet. Connect the Claude in Chrome extension to Claude Code, then come back to this page: Landed checks again right away.</Needs>}
      <Settings>
        <Field label="Done by" help="Tip: use a Chrome profile that's only signed in to job sites">
          {agent ? <span style={{ color: agent.browser ? ok : undefined }}>{agent.label}{agent.browser && ` · ${agent.browser}, read-only`}</span> : <span style={muted}>An agent on your computer that can use Chrome</span>}
        </Field>
        <Field label="When">
          <SchedulePicker schedule={a.schedule} presets={[DAILY[2], DAILY[1], DAILY[0]]} disabled={!w.loaded}
            onChange={(schedule) => w.save({ ...w.automations, portal_check: { ...a, schedule } })} />
          <span style={muted}>{state.text}</span>
        </Field>
        <Field label="Looks at" help="Up to 5 a run, quietest first">
          <span>
            Applications with a portal link and no news for{' '}
            <select aria-label="Days without news" value={quiet} style={{ fontSize: 12.5 }} onChange={(e) => w.save({ ...w.automations, portal_check: { ...a, quiet_days: Number(e.target.value) } })}>
              {QUIET_DAY_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </span>
          <span style={muted}>
            {candidates.data && (names.length
              ? `Right now: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`
              : candidates.data.withPortal ? 'Right now none: every application with a portal link has had news recently.' : 'None of your applications has a portal link yet (add one on an application).')}
          </span>
        </Field>
        <Field label="Then"><span>Asks you before changing a stage, except a confirmed submission, which updates on its own. Portals that need you to sign in are listed in the run.</span></Field>
      </Settings>
      <RecentRuns kind="portal_check" />
    </Pane>
  )
}

// ── what to look for ──────────────────────────────────────────────────────

const REMOTE: { value: RemotePreference; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'remote', label: 'Remote' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'On-site' },
]

/** The search criteria (the active brief), editable in place. An edit makes
 *  a new active search; changing roles or places rewrites the summary. */
function Criteria() {
  const brief = useActiveSearch()?.brief ?? null
  const edit = useEditBrief()
  const base: SearchBrief = brief ?? {
    summary: '', roles: [], seniority: null, locations: [], remote: 'any', needs_sponsorship: null, salary_min: null,
    industries: [], include_companies: [], exclude_companies: [], notes: null,
  }
  const save = (patch: Partial<SearchBrief>, resummarize = false) => {
    const next = parseBrief({ ...base, ...patch, ...(resummarize ? { summary: undefined } : {}) })
    if (next) edit.mutate(next)
  }
  const rows: ReactNode[] = [
    <Field key="roles" label="Roles"><EditableList separator=";" label="Roles" items={base.roles} placeholder="e.g. Product Manager; Product Analyst" onSave={(roles) => save({ roles }, true)} /></Field>,
  ]
  if (brief) rows.push(
    <Field key="where" label="Where"><EditableList separator=";" label="Locations" items={base.locations} placeholder="Anywhere" onSave={(locations) => save({ locations }, true)} /></Field>,
    <Field key="style" label="Work style">
      <select aria-label="Remote" value={base.remote} style={{ fontSize: 12.5, alignSelf: 'flex-start' }} onChange={(e) => save({ remote: e.target.value as RemotePreference })}>
        {REMOTE.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
    </Field>,
    <Field key="level" label="Level"><EditableText label="Level" value={base.seniority} placeholder="Any level" onSave={(v) => save({ seniority: v || null })} /></Field>,
    <Field key="visa" label="Visa">
      <select aria-label="Visa sponsorship" value={String(base.needs_sponsorship)} style={{ fontSize: 12.5, alignSelf: 'flex-start' }}
        onChange={(e) => save({ needs_sponsorship: e.target.value === 'null' ? null : e.target.value === 'true' })}>
        <option value="null">Doesn't matter</option>
        <option value="true">Needs sponsorship</option>
        <option value="false">No sponsorship needed</option>
      </select>
    </Field>,
    <Field key="salary" label="Min salary"><EditableText label="Minimum salary" value={base.salary_min} placeholder="Any" onSave={(v) => save({ salary_min: v || null })} /></Field>,
    <Field key="industries" label="Industries"><EditableList separator=";" label="Industries" items={base.industries} placeholder="Any" onSave={(industries) => save({ industries })} /></Field>,
    <Field key="first" label="Look at first"><EditableList separator=";" label="Companies to look at first" items={base.include_companies} placeholder="None" onSave={(include_companies) => save({ include_companies })} /></Field>,
    <Field key="skip" label="Skip"><EditableList separator=";" label="Companies to skip" items={base.exclude_companies} placeholder="None" onSave={(exclude_companies) => save({ exclude_companies })} /></Field>,
    <Field key="notes" label="Notes"><EditableText label="Notes" value={base.notes} placeholder="Anything else" multiline onSave={(v) => save({ notes: v || null })} /></Field>,
  )
  return (
    <div>
      {rows.map((row, i) => <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>{row}</div>)}
      {edit.error && <span style={{ ...muted, color: danger }}>{(edit.error as Error).message}</span>}
    </div>
  )
}

/** The board's public page, so a wrong guess (another company with the
 *  same name) is easy to spot (review of #104). */
function boardPage(b: { ats: 'greenhouse' | 'lever' | 'ashby'; board: string }): string {
  return b.ats === 'greenhouse' ? `job-boards.greenhouse.io/${b.board}` : b.ats === 'lever' ? `jobs.lever.co/${b.board}` : `jobs.ashbyhq.com/${b.board}`
}

/** The companies whose own job boards are checked (lib/boards.ts); × moves
 *  one to Skip. */
function FollowedCompanies({ brief }: { brief: SearchBrief }) {
  const boards = useFollowedBoards()
  const edit = useEditBrief()
  const list = boards.data ?? []
  const skip = (company: string) => {
    const next = parseBrief({ ...brief, exclude_companies: [...brief.exclude_companies, company] })
    if (next) edit.mutate(next)
  }
  if (list.length === 0) return <span style={muted}>None yet.</span>
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {list.map((b) => (
        <span key={`${b.ats}:${b.board}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 4px 1px 8px', borderRadius: 999, background: 'var(--surface-2)', fontSize: 12 }}
          title={`${b.from === 'search' ? 'From "Look at first"' : b.from === 'application' ? 'You applied here' : 'You approved a lead here'} · ${boardPage(b)}`}>
          {b.company} <span style={{ color: 'var(--fg-muted)' }}>· {ATS_LABELS[b.ats]}</span>
          <button type="button" className="btn-ghost" aria-label={`Stop checking ${b.company}`} title="Move to Skip"
            disabled={edit.isPending} onClick={() => skip(b.company)} style={{ padding: 1, display: 'flex' }}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
    </span>
  )
}
