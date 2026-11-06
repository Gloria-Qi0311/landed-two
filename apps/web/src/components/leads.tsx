// What a Leads card says about a lead (#94; docs/leads-model.md): its fit
// score and the reason that counts most, and, unfolded, every reason, what
// the hard filters made of it, where it was found and when it was posted.
// Plus the folded sections under the column: leads the filters hid and
// leads whose posting closed, and the postings the user's agent judged the
// same job as a card (#146), each with Split.
import { useMemo, useState, type ReactNode, type SyntheticEvent } from 'react'
import { isPutBack } from '@landed/supply'
import type { DbJobLead } from '../lib/store'
import { useJobLeads } from '../hooks/inbox'
import { useSplitDuplicate } from '../hooks/dedupe'
import { useRankSettings } from '../hooks/rank'
import { agentRanked, queueFit } from '../lib/fit'
import { Icon } from './primitives'

/** Keeps a click or key on a control inside a draggable card from starting a drag. */
const stop = (e: SyntheticEvent) => e.stopPropagation()
export const insideCard = { onPointerDown: stop, onKeyDown: stop }

const PROVIDER_LABELS: Record<string, string> = { meta_muse: 'Muse', claude: 'Claude', codex: 'Codex' }

/** Who found a lead: "Claude", "Lever · Acme", "SimplifyJobs New Grad". */
export const sourceLabel = (provider: string | undefined) => (provider ? PROVIDER_LABELS[provider] ?? provider : 'agent')

/** The same, on the company's own card: "Lever · Acme" is just "Lever". */
export const sourceOn = (lead: Pick<DbJobLead, 'company_name'>, provider: string | undefined) =>
  sourceLabel(provider).replace(` · ${lead.company_name}`, '')

/** "today", "3 days ago", "Sep 2" (a while back). */
export function ago(date: string, now: Date = new Date()): string {
  const at = new Date(date.length === 10 ? `${date}T00:00:00` : date)
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

/** "today", "2d ago", "Sep 2": for a card's footer. */
export function agoShort(date: string, now: Date = new Date()): string {
  const long = ago(date, now)
  const m = long.match(/^(\d+) days ago$/)
  return m ? `${m[1]}d ago` : long
}

// Strong fits stand out; weak ones recede.
const FIT_TONES = {
  strong: { color: 'oklch(0.42 0.12 155)', background: 'oklch(0.96 0.035 155)' },
  fair: { color: 'var(--fg)', background: 'var(--surface-2)' },
  weak: { color: 'var(--fg-muted)', background: 'var(--surface-2)' },
} as const
const fitTone = (score: number) => (score >= 0.8 ? FIT_TONES.strong : score >= 0.6 ? FIT_TONES.fair : FIT_TONES.weak)

/** "86% fit" and the reason that counts most. Nothing before a search scores it. */
export function FitLine({ lead }: { lead: DbJobLead }) {
  const counts = useRankSettings()
  const fit = queueFit(lead, counts)
  if (!fit) return null
  const pct = Math.round(fit.score * 100)
  const byAgent = agentRanked(lead, counts)
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <span title={byAgent ? `How well it fits your search and resume: Landed's rules and ${lead.rank!.by}` : 'How well it fits your search and resume'} style={{
        ...fitTone(fit.score), fontSize: 10.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
        padding: '1px 6px', borderRadius: 4, flexShrink: 0,
      }}>{pct}% fit</span>
      {fit.reasons[0] && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {fit.reasons[0]}
        </span>
      )}
    </div>
  )
}

/** The postings hidden under this lead because the user's agent judged
 *  them the same job, each with why and Split. */
export function SameJobLine({ lead }: { lead: DbJobLead }) {
  const all = useJobLeads().data
  const hidden = useMemo(() => (all ?? []).filter((l) => l.dedupe?.same_as === lead.id), [all, lead.id])
  const split = useSplitDuplicate()
  if (hidden.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {hidden.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 10.5, color: 'var(--fg-muted)' }}>
          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }} title={d.dedupe?.reason ?? undefined}>
            {d.dedupe?.by ?? 'Your agent'}: same job as “{d.title}”{d.location ? ` in ${d.location}` : ''}, found by {sourceOn(d, d.sources[0]?.provider)}
          </span>
          <button type="button" className="btn-ghost" {...insideCard} disabled={split.isPending}
            onClick={(e) => { stop(e); split.mutate(d) }} title="Not the same job: show it as its own lead"
            style={{ fontSize: 10.5, padding: '1px 4px', flexShrink: 0 }}>
            Split
          </button>
        </div>
      ))}
    </div>
  )
}

function screenText(lead: DbJobLead): string {
  if (!lead.screen) return 'Not checked yet'
  if (isPutBack(lead.screen)) return 'You put this back'
  if (lead.screen.pass) return 'Nothing rules you out'
  return lead.screen.reasons.join(' ')
}

const detailLabel = { fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' } as const
const detailText = { fontSize: 11.5, color: 'var(--fg)', lineHeight: 1.45 } as const

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={detailLabel}>{label}</span>
      {children}
    </div>
  )
}

/** Everything behind the score, unfolded on the card. */
export function LeadDetails({ lead, id }: { lead: DbJobLead; id: string }) {
  const sources = [...new Map(lead.sources.map((s) => [sourceLabel(s.provider), s])).entries()]
  const byAgent = agentRanked(lead, useRankSettings())
  return (
    <div id={id} {...insideCard} onClick={stop} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 7, cursor: 'auto' }}>
      {byAgent && (
        <Detail label={`${lead.rank!.by}: ${Math.round(lead.rank!.score * 100)}%`}>
          <ul style={{ ...detailText, margin: 0, paddingLeft: 14, listStyle: 'disc' }}>
            {lead.rank!.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Detail>
      )}
      {lead.fit && (
        <Detail label={byAgent ? `Landed's rules: ${Math.round(lead.fit.score * 100)}%` : 'Why this score'}>
          <ul style={{ ...detailText, margin: 0, paddingLeft: 14, listStyle: 'disc' }}>
            {lead.fit.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Detail>
      )}
      <Detail label="Hard filters"><span style={detailText}>{screenText(lead)}</span></Detail>
      <Detail label="Found by">
        {sources.map(([label, s]) => <span key={label} style={detailText}>{label} · {ago(s.seen_at)}</span>)}
      </Detail>
      <Detail label="Posted"><span style={detailText}>{lead.posted_at ? ago(lead.posted_at) : "The posting doesn't say"}</span></Detail>
    </div>
  )
}

/** A folded list under the Leads column: a toggle, then one row per lead. */
export function FoldedLeads({ label, leads, children }: { label: string; leads: DbJobLead[]; children: (lead: DbJobLead) => ReactNode }) {
  const [open, setOpen] = useState(false)
  if (leads.length === 0) return null
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}
        style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        {label} · {leads.length}
      </button>
      {open && (
        <div style={{ background: 'var(--surface)', borderRadius: 10, boxShadow: 'var(--shadow-sm)', overflow: 'hidden', flexShrink: 0 }}>
          {leads.map((lead, i) => (
            <div key={lead.id} style={{ padding: '9px 12px', borderTop: i ? '1px solid var(--border-subtle)' : 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {children(lead)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A folded row's first line: the lead, and what can be done with it. */
export function FoldedRow({ lead, children }: { lead: DbJobLead; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontSize: 12.5, fontWeight: 550, color: 'var(--fg)', flex: 1, minWidth: 0 }}>
        {lead.company_name} · {lead.title}
      </span>
      {children}
    </div>
  )
}
