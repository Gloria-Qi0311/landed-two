// Job leads — the "to apply" list: jobs agents found, deduplicated across
// agents and URL variants (packages/observation-processor). Adding one to
// the pipeline creates an application; dismissing hides it for good (a
// re-report of the same job merges into the dismissed lead).
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CompanyMark, Icon } from './primitives'
import { PageHeader } from './shell'
import { formatRelative } from '../lib/time'
import { AGENT_PROVIDERS } from '../lib/agent-prompt'
import { useJobLeads, useLeadActions } from '../hooks/inbox'
import type { DbJobLead } from '../lib/store'

function hueOf(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

const providerLabel = (id?: string) => AGENT_PROVIDERS.find((p) => p.id === id)?.label ?? id ?? 'agent'

export function LeadsPage() {
  const leads = useJobLeads()
  const all = leads.data ?? []
  const fresh = all.filter((l) => l.status === 'new')
  const inPipeline = all.filter((l) => l.status === 'saved' || l.status === 'already_applied')
  const dismissed = all.filter((l) => l.status === 'dismissed')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Job leads"
        subtitle="Jobs your agents found, deduplicated across agents. Add the ones you want to your pipeline."
      />
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 28px 28px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 980 }}>
        {leads.isLoading && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Loading…</div>}
        {leads.error && <div role="alert" style={{ fontSize: 12, color: 'oklch(0.45 0.15 30)' }}>{(leads.error as Error).message}</div>}

        {leads.isSuccess && all.length === 0 && (
          <div style={{ padding: 24, border: '0.5px dashed var(--border)', borderRadius: 10, background: 'var(--surface)', fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            No leads yet. <Link to="/agents" style={{ color: 'var(--accent)' }}>Connect an agent</Link> and ask it to look for jobs
            that match what you're after — what it finds shows up here, with duplicates merged.
          </div>
        )}

        {fresh.length > 0 && (
          <Section title={`New (${fresh.length})`}>
            {fresh.map((l, i) => <LeadRow key={l.id} lead={l} first={i === 0} />)}
          </Section>
        )}
        {leads.isSuccess && all.length > 0 && fresh.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>You're all caught up — no new leads.</div>
        )}

        {inPipeline.length > 0 && (
          <Collapsible title={`Already in your pipeline (${inPipeline.length})`}>
            {inPipeline.map((l, i) => <LeadRow key={l.id} lead={l} first={i === 0} />)}
          </Collapsible>
        )}
        {dismissed.length > 0 && (
          <Collapsible title={`Dismissed (${dismissed.length})`}>
            {dismissed.map((l, i) => <LeadRow key={l.id} lead={l} first={i === 0} />)}
          </Collapsible>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10 }}>
      <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', fontSize: 12.5, fontWeight: 600 }}>{title}</div>
      <div style={{ padding: '0 14px' }}>{children}</div>
    </section>
  )
}

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10 }}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{
        width: '100%', padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', fontFamily: 'inherit',
      }}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} stroke={2} /> {title}
      </button>
      {open && <div style={{ padding: '0 14px', borderTop: '0.5px solid var(--border)' }}>{children}</div>}
    </section>
  )
}

function LeadRow({ lead: l, first }: { lead: DbJobLead; first: boolean }) {
  const { add, dismiss, restore } = useLeadActions()
  const busy = add.isPending || dismiss.isPending || restore.isPending
  const agents = [...new Set(l.sources.map((s) => providerLabel(s.provider)))]
  const error = add.error ?? dismiss.error ?? restore.error
  return (
    <div style={{ padding: '10px 0', borderTop: first ? 'none' : '0.5px solid var(--border-subtle)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 10, alignItems: 'center' }}>
        <CompanyMark company={{ name: l.company_name, hue: hueOf(l.company_key), logo: l.company_name.slice(0, 2).toUpperCase() }} size={28} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</span>
            {l.job_url && (
              <a href={l.job_url} target="_blank" rel="noopener noreferrer" title="Open job posting" style={{ color: 'var(--fg-muted)', display: 'flex' }}>
                <Icon name="external" size={11} />
              </a>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {[l.company_name, l.location].filter(Boolean).join(' · ')}
            {' · '}found by {agents.join(', ')}{l.sources.length > 1 ? ` (${l.sources.length}×)` : ''}
            {' · '}{formatRelative(l.first_seen_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {l.status === 'new' && <>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => add.mutate({ lead: l, stage: 'saved' })}>Save</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => add.mutate({ lead: l, stage: 'applied' })}>I applied</button>
            <button type="button" className="icon-btn" disabled={busy} onClick={() => dismiss.mutate(l.id)} title="Dismiss" aria-label="Dismiss"
              style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 6, borderRadius: 5, display: 'flex' }}>
              <Icon name="x" size={13} />
            </button>
          </>}
          {(l.status === 'saved' || l.status === 'already_applied') && (
            <Link to="/applications" style={{ fontSize: 11.5, color: 'var(--accent)' }}>In pipeline</Link>
          )}
          {l.status === 'dismissed' && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => restore.mutate(l.id)}>Restore</button>
          )}
        </div>
      </div>
      {error && <div role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)', marginTop: 4, paddingLeft: 38 }}>{(error as Error).message}</div>}
    </div>
  )
}
