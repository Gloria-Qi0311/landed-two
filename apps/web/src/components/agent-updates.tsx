// Agent updates on the Applications page: what agents changed from email
// (applied automatically by default, each undoable) and the few updates
// Landed can't decide alone — which application an email is about, low
// confidence, or re-opening a closed application.
// Rules: packages/observation-processor, docs/observation-processor.md.
import { useState, type ReactNode } from 'react'
import { Icon, StageBadge } from './primitives'
import { formatRelative } from '../lib/time'
import { AGENT_PROVIDERS } from '../lib/agent-prompt'
import { STAGE_LABELS } from '../data'
import { canUndo, isPanelQuestion } from '../lib/inbox'
import { useApplications, useCompanies } from '../hooks/queries'
import { useSuggestionActions, useSuggestions } from '../hooks/inbox'
import type { DbSuggestion } from '../lib/store'

type AppShape = { id: string; companyId: string; role: string; stage: string }
type CompanyShape = { id: string; name: string }

const providerLabel = (id?: string | null) => AGENT_PROVIDERS.find((p) => p.id === id)?.label ?? id ?? 'An agent'
const STATUS_TEXT: Record<string, string> = {
  applied: 'application received', recruiter_response: 'recruiter replied', assessment: 'online assessment',
  interview: 'interview invitation',
  rejected: 'rejection', offer: 'offer', other: 'update',
}

function Evidence({ s }: { s: DbSuggestion }) {
  const e = s.evidence ?? {}
  const parts = [
    e.subject ? `“${e.subject}”` : null,
    e.sender_domain ? `from ${e.sender_domain}` : null,
    e.received_at ? formatRelative(e.received_at) : null,
  ].filter(Boolean)
  return (
    <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Icon name="inbox" size={11} />
      <span>
        {e.source === 'portal'
          ? <>{providerLabel(s.provider)} looked at the candidate portal{e.sender_domain ? ` (${e.sender_domain})` : ''}{e.subject ? `: “${e.subject}”` : ''}</>
          : <>{providerLabel(s.provider)} read {e.source ? `a ${e.source} email` : 'an email'}{parts.length ? ': ' : ''}{parts.join(' · ')}</>}
      </span>
      {s.confidence != null && <span style={{ fontFamily: 'var(--font-mono)' }}>· {Math.round(s.confidence * 100)}% sure</span>}
      {s.observation_ids.length > 1 && <span>· reported {s.observation_ids.length}×</span>}
    </div>
  )
}

/** One row: what happened on the left, the decision on the right — compact,
 *  so a couple of pending items don't push the board off screen. */
function Card({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8,
      padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>{children}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>{footer}</div>
    </section>
  )
}

function PendingCard({ s, apps, companies, label }: {
  s: DbSuggestion
  apps: AppShape[]
  companies: CompanyShape[]
  label: (id: string | null) => string | null
}) {
  const { accept, reject } = useSuggestionActions()
  const [pick, setPick] = useState('')
  const busy = accept.isPending || reject.isPending
  const app = apps.find((a) => a.id === s.application_id)
  const error = accept.error ?? reject.error

  let headline: ReactNode
  let acceptLabel = 'Accept'
  if (s.kind === 'stage_change') {
    headline = <>
      <span style={{ fontWeight: 500 }}>{label(s.application_id) ?? `${s.company_name} · ${s.role ?? ''}`}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {app && <StageBadge stage={app.stage} />}<Icon name="arrowRight" size={11} />{s.proposed_stage && <StageBadge stage={s.proposed_stage} />}
      </span>
    </>
    acceptLabel = 'Move it'
  } else if (s.kind === 'new_application') {
    headline = <>
      <span style={{ fontWeight: 500 }}>New application? {s.company_name}{s.role ? ` · ${s.role}` : ''}</span>
      {s.proposed_stage && <StageBadge stage={s.proposed_stage} />}
    </>
    acceptLabel = 'Add to pipeline'
  } else if (s.kind === 'ambiguous') {
    const candidates = apps.filter((a) => s.candidate_ids.includes(a.id))
    headline = <>
      <span style={{ fontWeight: 500 }}>{s.company_name}: {STATUS_TEXT[s.status] ?? s.status} — which application is this?</span>
      <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ padding: '4px 8px', fontSize: 12, fontFamily: 'inherit' }}>
        <option value="">Choose…</option>
        {candidates.map((a) => <option key={a.id} value={a.id}>{a.role} ({a.stage})</option>)}
      </select>
    </>
    acceptLabel = 'Apply'
  } else {
    headline = <span style={{ fontWeight: 500 }}>{label(s.application_id) ?? s.company_name}: {STATUS_TEXT[s.status] ?? s.status}</span>
    acceptLabel = 'Got it'
  }

  return (
    <Card footer={<>
      {error && <span role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{(error as Error).message}</span>}
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => reject.mutate(s.id)}>
        {s.kind === 'note' ? 'Dismiss' : 'Not right'}
      </button>
      <button type="button" className="btn-primary" disabled={busy || (s.kind === 'ambiguous' && !pick)}
        style={{ opacity: busy || (s.kind === 'ambiguous' && !pick) ? 0.6 : 1 }}
        onClick={() => accept.mutate({ s, applicationId: pick || undefined })}>
        {acceptLabel}
      </button>
    </>}>
      <div style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{headline}</div>
      <Evidence s={s} />
      {s.evidence?.summary && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', fontStyle: 'italic' }}>{s.evidence.summary}</div>}
    </Card>
  )
}

const STAGE_LABEL: Record<string, string> = STAGE_LABELS

/** What accepting did, in words: "→ Phone Screen", "· added as Offer", or nothing for notes. */
function recentOutcome(s: DbSuggestion) {
  if (s.state === 'rejected' || s.kind === 'note' || !s.proposed_stage) return ''
  const stage = STAGE_LABEL[s.proposed_stage] ?? s.proposed_stage
  return s.kind === 'new_application' ? ` · added as ${stage}` : ` → ${stage}`
}

const STATE_TEXT: Record<string, string> = {
  accepted: 'Accepted', rejected: 'Dismissed', auto_applied: 'Applied automatically', undone: 'Undone',
}

function RecentRow({ s, first, label }: { s: DbSuggestion; first: boolean; label: (id: string | null) => string | null }) {
  const { undo } = useSuggestionActions()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: first ? 'none' : '0.5px solid var(--border-subtle)', fontSize: 12 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label(s.application_id) ?? `${s.company_name}${s.role ? ` · ${s.role}` : ''}`}
        <span style={{ color: 'var(--fg-muted)' }}> — {STATUS_TEXT[s.status] ?? s.status}{recentOutcome(s)}</span>
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        {s.kind === 'note' && s.state === 'auto_applied' ? 'Noted' : STATE_TEXT[s.state] ?? s.state} · {formatRelative(s.resolved_at ?? s.created_at)}
      </span>
      <span style={{ minWidth: 52, textAlign: 'right' }}>
        {canUndo(s) && (
          <button type="button" className="btn-secondary" disabled={undo.isPending} onClick={() => undo.mutate(s)}>Undo</button>
        )}
      </span>
    </div>
  )
}

const RECENT_DAYS = 7

/** Top-of-Applications strip. Renders nothing when there's nothing to show. */
export function AgentUpdatesBar() {
  // Landed's own questions are asked on the Agent page instead.
  const suggestions = (useSuggestions().data ?? []).filter((s) => !isPanelQuestion(s))
  const apps = (useApplications().data ?? []) as AppShape[]
  const companies = (useCompanies().data ?? []) as CompanyShape[]
  const [open, setOpen] = useState(false)
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000
  const pending = suggestions.filter((s) => s.state === 'pending')
  const recent = suggestions.filter((s) => s.state !== 'pending' && Date.parse(s.resolved_at ?? s.created_at) >= cutoff)
  if (pending.length === 0 && recent.length === 0) return null

  const label = (appId: string | null) => {
    const a = apps.find((x) => x.id === appId)
    if (!a) return null
    return `${companies.find((c) => c.id === a.companyId)?.name ?? ''} · ${a.role}`
  }
  const auto = recent.filter((s) => s.state === 'auto_applied').length

  return (
    <div style={{ padding: '10px 28px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {pending.length > 0 && (
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Needs your input ({pending.length})
        </div>
      )}
      {pending.map((s) => <PendingCard key={s.id} s={s} apps={apps} companies={companies} label={label} />)}
      {recent.length > 0 && (
        <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10 }}>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{
            width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg)', fontFamily: 'inherit', textAlign: 'left',
          }}>
            <Icon name="wand" size={13} />
            <span style={{ fontWeight: 500 }}>Your agents updated {recent.length} application{recent.length === 1 ? '' : 's'} this week</span>
            {auto > 0 && <span style={{ color: 'var(--fg-muted)' }}>· {auto} automatically, all undoable</span>}
            <span style={{ marginLeft: 'auto', display: 'flex' }}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} stroke={2} /></span>
          </button>
          {open && (
            <div style={{ padding: '0 12px', borderTop: '0.5px solid var(--border)' }}>
              {recent.map((s, i) => <RecentRow key={s.id} s={s} first={i === 0} label={label} />)}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** Count for the sidebar badge. */
/** Sidebar count: updates waiting in "Needs your input" (the panel's own
 *  questions are counted on the sidebar's Agent item instead). */
export function usePendingUpdateCount() {
  return (useSuggestions().data ?? []).filter((s) => s.state === 'pending' && !isPanelQuestion(s)).length
}
