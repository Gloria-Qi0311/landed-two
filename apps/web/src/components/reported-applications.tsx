// The card under an agent reply that read applications from a screenshot
// (```landed-applications, packages/schema/src/reported-application.ts):
// one row each — new, already a lead, or already in Applications (maybe at
// an earlier stage) — and the user adds them with a click. The agent never
// adds anything itself (lib/inbox.ts → addReportedApplication).
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReportedApplication } from '@landed/schema/reported-application'
import { Icon, stageColors } from './primitives'
import { STAGE_LABELS } from '../data'
import { addReportedApplication, matchReported, type ReportedMatch } from '../lib/inbox'
import { useStore } from '../lib/store'

const muted = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 } as const
const label = (stage: string) => (STAGE_LABELS as Record<string, string>)[stage] ?? (stage === 'saved' ? 'Lead' : stage)

function StagePill({ stage }: { stage: string }) {
  const c = (stageColors as Record<string, { bg: string; fg: string; ring: string }>)[stage] ?? stageColors.saved
  return (
    <span style={{ fontSize: 10.5, fontWeight: 500, padding: '1px 7px', borderRadius: 999, background: c.bg, color: c.fg, border: `0.5px solid ${c.ring}`, whiteSpace: 'nowrap' }}>
      {label(stage)}
    </span>
  )
}

export function ReportedApplicationsCard({ applications }: { applications: ReportedApplication[] }) {
  const { store, ready } = useStore()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const matches = useQuery({
    queryKey: ['applications', 'reported', JSON.stringify(applications)],
    enabled: ready,
    queryFn: async () => {
      const [apps, companies, leads] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobLeads()])
      return applications.map((r) => matchReported(r, apps, companies, leads))
    },
  })

  const add = async (indexes: number[]) => {
    setBusy(indexes)
    setError(null)
    try {
      for (const i of indexes) await addReportedApplication(store, applications[i])
    } catch (e) {
      setError(`Couldn't add it: ${(e as Error).message}`)
    } finally {
      setBusy([])
      for (const key of ['applications', 'companies', 'job_leads', 'suggestions']) qc.invalidateQueries({ queryKey: [key] })
    }
  }

  const todo = (m: ReportedMatch | undefined) => !!m && (m.kind !== 'existing' || m.forward)
  const pending = applications.map((_, i) => i).filter((i) => todo(matches.data?.[i]))

  return (
    <div style={{ marginTop: 8, borderRadius: 12, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
        <Icon name="doc" size={12} /> {applications.length === 1 ? 'Application' : `${applications.length} applications`} from your screenshot
        {pending.length > 1 && (
          <button type="button" className="btn-primary" disabled={busy.length > 0} onClick={() => add(pending)}
            style={{ marginLeft: 'auto', fontSize: 11.5, padding: '2px 10px' }}>
            {busy.length > 1 ? 'Adding…' : `Add all ${pending.length}`}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {applications.map((r, i) => {
          const m = matches.data?.[i]
          const done = m?.kind === 'existing' && !m.forward
          return (
            <div key={i} style={{ padding: '10px 14px', borderTop: i ? '1px solid var(--border-subtle)' : 'none', display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {r.company} — {r.role} <StagePill stage={r.stage} />
                </div>
                <div style={muted}>
                  {[r.applied_on && `applied ${r.applied_on}`, r.location, r.note].filter(Boolean).join(' · ')}
                  {m?.kind === 'lead' && <>{r.applied_on || r.location || r.note ? ' · ' : ''}in your Leads — adding moves it into the pipeline</>}
                  {m?.kind === 'existing' && (
                    <>
                      {r.applied_on || r.location || r.note ? ' · ' : ''}already in Applications
                      {m.app.role !== r.role || m.company !== r.company ? <> as “{m.company} — {m.app.role}”</> : null}, <StagePill stage={m.app.stage} />
                    </>
                  )}
                </div>
              </div>
              {done ? (
                <span style={{ fontSize: 11.5, color: 'oklch(0.45 0.13 155)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <Icon name="check" size={11} /> In Applications
                </span>
              ) : m ? (
                <button type="button" className={pending.length > 1 ? 'btn-secondary' : 'btn-primary'} disabled={busy.length > 0} onClick={() => add([i])}
                  style={{ fontSize: 11.5, padding: '2px 10px', flexShrink: 0 }}>
                  {busy.includes(i) ? 'Adding…' : m.kind === 'existing' ? `Move to ${label(r.stage)}` : 'Add to Applications'}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      {error && <div role="alert" style={{ ...muted, color: 'oklch(0.45 0.15 30)', padding: '0 12px 8px' }}>{error}</div>}
    </div>
  )
}
