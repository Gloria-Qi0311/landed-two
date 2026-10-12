// "Did you apply?" — asked in the Ask Agent panel after the user opens a
// posting from Landed (a lead's link, or a saved application's "Open in
// portal"). An application-received email answers it by itself
// (settleClickQuestions); the badge on the Ask Agent button counts these.
import { useMemo } from 'react'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { openClickQuestions } from '../lib/inbox'
import { useJobLeads, useSuggestionActions, useSuggestions } from '../hooks/inbox'
import { useApplications, useCompanies } from '../hooks/queries'

type AppShape = { id: string; companyId: string; role: string; stage: string; location: string; portal_application_url: string | null }
type CompanyShape = { id: string; name: string }

export function useApplyQuestions() {
  const suggestions = useSuggestions().data
  const leads = useJobLeads().data
  const apps = useApplications().data as AppShape[] | undefined
  const companies = useCompanies().data as CompanyShape[] | undefined
  return useMemo(() => {
    if (!suggestions || !leads || !apps || !companies) return []
    const refs = apps.map((a) => ({
      id: a.id, company_id: a.companyId, role: a.role, stage: a.stage, location: a.location || null,
      portal_application_url: a.portal_application_url,
    }))
    return openClickQuestions(suggestions, leads, refs, companies.map((c) => ({ id: c.id, name: c.name })))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [suggestions, leads, apps, companies])
}

export function ApplyQuestions() {
  const questions = useApplyQuestions()
  const { accept, reject } = useSuggestionActions()
  const busy = accept.isPending || reject.isPending
  const error = accept.error ?? reject.error
  if (questions.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {questions.slice(0, 5).map((q) => (
        <div key={q.id} style={{ border: '0.5px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="sparkle" size={11} /> Landed asks · you opened the posting {formatRelative(q.created_at)}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
            Did you apply to <b>{q.company_name}</b>{q.role ? ` — ${q.role}` : ''}?
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => accept.mutate({ s: q })}>
              <Icon name="check" size={12} /> Yes, I applied
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => reject.mutate(q.id)}>Not yet</button>
          </div>
        </div>
      ))}
      {questions.length > 5 && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>+{questions.length - 5} more</div>}
      {error && <div role="alert" style={{ fontSize: 11.5, color: 'oklch(0.45 0.15 30)' }}>{(error as Error).message}</div>}
    </div>
  )
}
