// "Open & autofill": on a lead card and in a saved application's drawer.
// The extension opens the posting in a new tab and fills it with the resume
// picked here (the version tailored for this role when there is one); the
// user checks, finishes and submits. The "thanks for applying" page then
// moves this application to Applied (lib/apply-assist.ts). Hidden without
// the Landed extension in this browser.
//
// Separately, approving a lead is explicit authorization for the batch path
// to submit that one application after all safety checks pass. Manual
// Open & autofill never carries that authorization.
import { useMemo, useState } from 'react'
import { Icon } from './primitives'
import { bridgeCall } from '../lib/extension-bridge'
import { PICK_TEXT, pickResumeFor, type AssistTarget } from '../lib/apply-assist'
import { openAnswerExamples } from '../lib/open-answers'
import { useResumes } from '../hooks/resumes'
import { useApplications, useUpdateApplication } from '../hooks/queries'
import { useResumeFiles } from '../hooks/answers'
import { useRecordApplyClick } from '../hooks/inbox'
import type { ClickTarget } from '../lib/inbox'
import type { DbJobLead } from '../lib/store'
import { muted, danger } from './ui'
import { requestAutoApplyRun, useAutoApplyControl, useExtension } from '../hooks/auto-apply'
import { useAutomations } from '../hooks/automation'

/** Compact status/control in Leads. The execution itself is global and its
 * full management surface lives on Workflow. */
export function ApplyNextBatch({ leads }: { leads: DbJobLead[] }) {
  const { automations } = useAutomations()
  const busy = useAutoApplyControl((state) => state.busy)
  const note = useAutoApplyControl((state) => state.note)
  const approved = leads.some((lead) => lead.status === 'saved' && lead.application_id)
  if (!approved) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={requestAutoApplyRun}
          style={{ fontSize: 11.5, padding: '4px 9px' }} title="Run approved applications that are ready now.">
          <Icon name="sparkle" size={11} /> {busy ? 'Applying…' : 'Retry approved'}
        </button>
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
          {automations.auto_apply.enabled ? `Auto apply on · up to ${automations.auto_apply.max_concurrent} at a time` : 'Auto apply off · manage it in Workflow'}
        </span>
      </div>
      {note && <div role="status" style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{note}</div>}
    </div>
  )
}

type State = { phase: 'idle' | 'opening' | 'opened' | 'error'; text?: string }

function useOpenAndFill(click: ClickTarget) {
  const record = useRecordApplyClick()
  const update = useUpdateApplication()
  const apps = useApplications().data
  const [state, setState] = useState<State>({ phase: 'idle' })
  const open = async (target: AssistTarget, resumeId: string, resumeName: string, reason?: string) => {
    setState({ phase: 'opening' })
    record(click) // "did you apply?" still asks if the confirmation page goes unseen
    const res = await bridgeCall<{ tab_id: number }>('assist-open', {
      url: target.url, resume_id: resumeId, application_id: target.application_id, lead_id: target.lead_id,
      // For open-ended answers: the job (its posting is read from the page)
      // and the user's own edited answers.
      job: { role: target.role, company: target.company }, examples: openAnswerExamples(apps ?? []),
    })
    // Which resume, and why, stays on the application (its drawer).
    if (res.ok && target.application_id) {
      update.mutate({ id: target.application_id, patch: { resume_choice: { resume_id: resumeId, name: resumeName, reason: reason ?? '', at: new Date().toISOString() } } })
    }
    setState(res.ok
      ? { phase: 'opened', text: `Opened — filling it with “${resumeName}”. Check the highlighted fields, finish the rest and submit yourself; Landed marks it Applied when the portal confirms.` }
      : { phase: 'error', text: res.error === 'no_extension' ? 'The Landed extension didn’t answer. Reload this page and try again.' : res.error })
  }
  return { state, open }
}

/** Which resumes have their own file to upload (undefined while loading:
 *  then the pick doesn't weigh files). */
function useHasResumeFile(): ((id: string) => boolean) | undefined {
  const files = useResumeFiles().data
  return useMemo(() => {
    if (!files) return undefined
    const ids = new Set(files.map((f) => f.resume_id))
    return (id: string) => ids.has(id)
  }, [files])
}

/** Small button next to a lead's posting link. */
export function LeadAssistButton({ lead }: { lead: DbJobLead }) {
  const ext = useExtension().data
  const resumes = useResumes().data ?? []
  const hasFile = useHasResumeFile()
  const { state, open } = useOpenAndFill({ kind: 'lead', lead })
  if (!ext || !lead.job_url) return null
  const target: AssistTarget = { application_id: null, lead_id: lead.id, company: lead.company_name, role: lead.title, url: lead.job_url }
  const pick = pickResumeFor({ ...target, description: lead.description }, resumes, hasFile)
  const title = !pick ? 'Add a resume on My Resume to autofill'
    : state.text ?? `Open and autofill with “${pick.resume.name}” (${pick.reason ?? PICK_TEXT[pick.why]})`
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <button type="button" title={title} aria-label={title} disabled={!pick || state.phase === 'opening'} onPointerDown={stop}
      onClick={(e) => { stop(e); if (pick) void open(target, pick.resume.id, pick.resume.name, pick.reason ?? PICK_TEXT[pick.why]) }}
      style={{ background: 'transparent', border: 'none', cursor: pick ? 'pointer' : 'default', padding: 2, display: 'flex',
        color: state.phase === 'error' ? danger : state.phase === 'opened' ? 'var(--accent)' : 'var(--fg-muted)', opacity: pick ? 1 : 0.5 }}>
      <Icon name={state.phase === 'opened' ? 'check' : 'sparkle'} size={11} />
    </button>
  )
}

type App = { id: string; role: string; stage: string; portal_application_url: string | null }

/** In a saved application's drawer: open its posting and fill it, with a
 *  choice of resume (the tailored version by default). */
export function ApplicationAssist({ app, companyName }: { app: App; companyName: string }) {
  const ext = useExtension()
  const resumes = (useResumes().data ?? []).filter((r) => r.parsed_json)
  const hasFile = useHasResumeFile()
  const url = app.portal_application_url
  const target: AssistTarget = { application_id: app.id, lead_id: null, company: companyName, role: app.role, url: url ?? '' }
  const pick = pickResumeFor(target, resumes, hasFile)
  const [chosen, setChosen] = useState<string | null>(null)
  const resume = resumes.find((r) => r.id === (chosen ?? pick?.resume.id)) ?? null
  const { state, open } = useOpenAndFill({ kind: 'application', id: app.id, role: app.role, stage: app.stage, company_name: companyName })
  if (app.stage !== 'saved' || !url) return null

  const blocker = ext.isLoading ? null
    : !ext.data ? 'Needs the Landed extension in this browser (Chrome, Edge, Brave or Safari).'
    : !resume ? 'Add a resume on My Resume first.'
    : null
  const why = resume && pick && resume.id === pick.resume.id ? (pick.reason ?? PICK_TEXT[pick.why]) : null

  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={12} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Apply with autofill</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn-primary" disabled={!!blocker || ext.isLoading || state.phase === 'opening'}
          onClick={() => resume && open(target, resume.id, resume.name, why ?? 'you chose it')}>
          <Icon name="external" size={11} /> {state.phase === 'opening' ? 'Opening…' : 'Open & autofill'}
        </button>
        {resumes.length > 0 && (
          <select aria-label="Resume to fill with" value={resume?.id ?? ''} onChange={(e) => setChosen(e.target.value)} style={{ fontSize: 12, maxWidth: 240 }}>
            {resumes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.kind === 'version' ? ' (version)' : r.kind === 'master' ? ' (master)' : ''}</option>)}
          </select>
        )}
        {why && <span style={muted}>{why}</span>}
      </div>
      <div style={{ ...muted, ...(state.phase === 'error' ? { color: danger } : {}) }}>
        {state.text ?? blocker ?? 'Opens the posting and fills what it can from this resume — green fields are filled, yellow ones need you. It never submits.'}
      </div>
    </div>
  )
}
