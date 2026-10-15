// "Open & autofill": on a lead card and in a saved application's drawer.
// The extension opens the posting in a new tab and fills it with the resume
// picked here (the version tailored for this role when there is one); the
// user checks, finishes and submits. The "thanks for applying" page then
// moves this application to Applied (lib/apply-assist.ts). Hidden without
// the Landed extension in this browser.
import { useEffect, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from './primitives'
import { bridgeCall, onExtensionReady } from '../lib/extension-bridge'
import { PICK_TEXT, pickResumeFor, type AssistTarget } from '../lib/apply-assist'
import { useResumes } from '../hooks/resumes'
import { useRecordApplyClick } from '../hooks/inbox'
import type { ClickTarget } from '../lib/inbox'
import type { DbJobLead } from '../lib/store'

const muted: CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }
const danger = 'oklch(0.45 0.15 30)'

/** The extension's version, or null when it isn't installed here. */
export function useExtension() {
  const qc = useQueryClient()
  useEffect(() => onExtensionReady(() => qc.invalidateQueries({ queryKey: ['extension'] })), [qc])
  return useQuery({
    queryKey: ['extension'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await bridgeCall<{ version: string }>('hello')
      return res.ok ? res.data.version : null
    },
  })
}

type State = { phase: 'idle' | 'opening' | 'opened' | 'error'; text?: string }

function useOpenAndFill(click: ClickTarget) {
  const record = useRecordApplyClick()
  const [state, setState] = useState<State>({ phase: 'idle' })
  const open = async (target: AssistTarget, resumeId: string, resumeName: string) => {
    setState({ phase: 'opening' })
    record(click) // "did you apply?" still asks if the confirmation page goes unseen
    const res = await bridgeCall<{ tab_id: number }>('assist-open', { url: target.url, resume_id: resumeId, application_id: target.application_id, lead_id: target.lead_id })
    setState(res.ok
      ? { phase: 'opened', text: `Opened — filling it with “${resumeName}”. Check the highlighted fields, finish the rest and submit yourself; Landed marks it Applied when the portal confirms.` }
      : { phase: 'error', text: res.error === 'no_extension' ? 'The Landed extension didn’t answer. Reload this page and try again.' : res.error })
  }
  return { state, open }
}

/** Small button next to a lead's posting link. */
export function LeadAssistButton({ lead }: { lead: DbJobLead }) {
  const ext = useExtension().data
  const resumes = useResumes().data ?? []
  const { state, open } = useOpenAndFill({ kind: 'lead', lead })
  if (!ext || !lead.job_url) return null
  const target: AssistTarget = { application_id: null, lead_id: lead.id, company: lead.company_name, role: lead.title, url: lead.job_url }
  const pick = pickResumeFor(target, resumes)
  const title = !pick ? 'Add a resume on My Resume to autofill'
    : state.text ?? `Open and autofill with “${pick.resume.name}” (${PICK_TEXT[pick.why]})`
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <button type="button" title={title} aria-label={title} disabled={!pick || state.phase === 'opening'} onPointerDown={stop}
      onClick={(e) => { stop(e); if (pick) void open(target, pick.resume.id, pick.resume.name) }}
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
  const url = app.portal_application_url
  const target: AssistTarget = { application_id: app.id, lead_id: null, company: companyName, role: app.role, url: url ?? '' }
  const pick = pickResumeFor(target, resumes)
  const [chosen, setChosen] = useState<string | null>(null)
  const resume = resumes.find((r) => r.id === (chosen ?? pick?.resume.id)) ?? null
  const { state, open } = useOpenAndFill({ kind: 'application', id: app.id, role: app.role, stage: app.stage, company_name: companyName })
  if (app.stage !== 'saved' || !url) return null

  const blocker = ext.isLoading ? null
    : !ext.data ? 'Needs the Landed extension in this browser (Chrome, Edge, Brave or Safari).'
    : !resume ? 'Add a resume on My Resume first.'
    : null
  const why = resume && pick && resume.id === pick.resume.id ? PICK_TEXT[pick.why] : null

  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={12} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Apply with autofill</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn-primary" disabled={!!blocker || ext.isLoading || state.phase === 'opening'}
          onClick={() => resume && open(target, resume.id, resume.name)}>
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
