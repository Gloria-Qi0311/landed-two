// Questions Landed asks, under "Needs your input" on Applications
// (components/agent-updates.tsx; the sidebar's Applications badge counts them):
//   - "Did you apply?" after you open a posting from Landed;
//   - "No news for 3+ weeks" for applications in progress: mark ghosted or
//     keep waiting;
//   - "These look like the same application": merge, or keep both
//     (components/duplicates.tsx);
//   - a pointer to the Extension page while application forms have
//     questions waiting (components/pending-questions.tsx).
// Each closes itself when an email or a manual move answers
// it (settleQuestions in lib/inbox/questions.ts).
import { useMemo, type ReactNode } from 'react'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { isClickQuestion, isQuietQuestion, openPanelQuestions, quietDays } from '../lib/inbox'
import type { DbSuggestion } from '../lib/store'
import { useJobLeads, useSuggestionActions, useSuggestions } from '../hooks/inbox'
import { useApplications, useCompanies } from '../hooks/queries'
import { DuplicatesReview, useDuplicates } from './duplicates'
import { PendingQuestionsNotice, usePendingQuestions } from './pending-questions'
import { muted, danger } from './ui'

type AppShape = {
  id: string; companyId: string; role: string; stage: string; location: string
  portal_application_url: string | null; lastActivity: number; appliedDays: number
}
type CompanyShape = { id: string; name: string }

const DAY = 86_400_000

export function usePanelQuestions() {
  const suggestions = useSuggestions().data
  const leads = useJobLeads().data
  const apps = useApplications().data as AppShape[] | undefined
  const companies = useCompanies().data as CompanyShape[] | undefined
  const dups = useDuplicates().data?.length ?? 0
  return useMemo(() => {
    if (!suggestions || !leads || !apps || !companies) return { click: [], quiet: [], dups, count: dups }
    const refs = apps.map((a) => ({
      id: a.id, company_id: a.companyId, role: a.role, stage: a.stage, location: a.location || null,
      portal_application_url: a.portal_application_url,
      // the app shape keeps whole days; enough for "anything since we asked?"
      last_activity_at: new Date(Date.now() - a.lastActivity * DAY).toISOString(),
    }))
    const open = openPanelQuestions(suggestions, leads, refs, companies.map((c) => ({ id: c.id, name: c.name })))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const click = open.filter(isClickQuestion)
    const quiet = open.filter(isQuietQuestion).sort((a, b) => quietDays(b) - quietDays(a))
    // The quiet ones are asked as one group; each duplicate group is one question.
    return { click, quiet, dups, count: click.length + (quiet.length ? 1 : 0) + dups }
  }, [suggestions, leads, apps, companies, dups])
}

function Asks({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
      <Icon name="sparkle" size={11} /> {children}
    </div>
  )
}

const cardStyle = {
  borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: 8,
} as const

export function PanelQuestions() {
  const { click, quiet, dups } = usePanelQuestions()
  const formQuestions = usePendingQuestions().length
  if (click.length === 0 && quiet.length === 0 && dups === 0 && formQuestions === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {formQuestions > 0 && <PendingQuestionsNotice style={cardStyle} />}
      {click.slice(0, 5).map((q) => <ClickQuestion key={q.id} q={q} />)}
      {quiet.length > 0 && <QuietQuestions quiet={quiet} />}
      {dups > 0 && <DuplicatesReview limit={3} />}
    </div>
  )
}

function ClickQuestion({ q }: { q: DbSuggestion }) {
  const { accept, reject } = useSuggestionActions()
  const busy = accept.isPending || reject.isPending
  const error = accept.error ?? reject.error
  return (
    <div style={cardStyle}>
      <Asks>Landed asks · you opened the posting {formatRelative(q.created_at)}</Asks>
      <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        Did you apply to <b>{q.company_name}</b>{q.role ? ` — ${q.role}` : ''}?
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => accept.mutate({ s: q })}>
          <Icon name="check" size={12} /> Yes, I applied
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => reject.mutate(q.id)}>Not yet</button>
      </div>
      {error && <div role="alert" style={{ ...muted, color: danger }}>{(error as Error).message}</div>}
    </div>
  )
}

function QuietQuestions({ quiet }: { quiet: DbSuggestion[] }) {
  const { accept, reject } = useSuggestionActions()
  const busy = accept.isPending || reject.isPending
  const shown = quiet.slice(0, 6)

  return (
    <div style={cardStyle}>
      <Asks>Landed asks · no news for 3+ weeks</Asks>
      <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        {quiet.length === 1 ? 'This application has' : `These ${quiet.length} applications have`} gone quiet. Still waiting, or ghosted?
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {shown.map((q, i) => (
          <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: i ? '0.5px solid var(--border-subtle)' : 'none', fontSize: 12 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${q.company_name} — ${q.role ?? ''}`}>
              <b style={{ fontWeight: 500 }}>{q.company_name}</b>{q.role ? ` — ${q.role}` : ''}
            </span>
            <span style={{ ...muted, flexShrink: 0 }}>{quietDays(q)}d</span>
            <button type="button" className="btn-secondary" disabled={busy} title="Move to Ghosted (undoable)"
              style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => accept.mutate({ s: q })}>Ghosted</button>
            <button type="button" className="btn-secondary" disabled={busy} title="Ask again in 3 weeks"
              style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => reject.mutate(q.id)}>Wait</button>
          </div>
        ))}
        {quiet.length > shown.length && <div style={{ ...muted, paddingTop: 4 }}>+{quiet.length - shown.length} more</div>}
      </div>

      {(accept.error ?? reject.error) && <div role="alert" style={{ ...muted, color: danger }}>{((accept.error ?? reject.error) as Error).message}</div>}
    </div>
  )
}
