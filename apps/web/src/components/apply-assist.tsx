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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from './primitives'
import { bridgeCall, onExtensionReady } from '../lib/extension-bridge'
import { PICK_TEXT, pickResumeFor, type AssistTarget } from '../lib/apply-assist'
import { useResumes } from '../hooks/resumes'
import { useRecordApplyClick, useSuggestions } from '../hooks/inbox'
import { useUpdateApplication, type BoardApp } from '../hooks/queries'
import type { ClickTarget } from '../lib/inbox'
import type { DbJobLead } from '../lib/store'
import { muted, danger } from './ui'
import type { MarkCompany } from './primitives'
import {
  APPLY_ASSIST_RESULT_EVENT,
  APPLY_BATCH_LIMIT,
  APPLY_FILLING,
  planApplyBatch,
  type ApplyAssistResult,
} from '../lib/apply-batch'


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

/** Approved leads execute automatically, at most five at a time in the same
 * priority order as the cards. Each extension request is independent: one
 * login/CAPTCHA cannot stop the rest. The button remains as an explicit retry. */
export function ApplyNextBatch({
  apps,
  leads,
  getCompany,
}: {
  apps: BoardApp[]
  leads: DbJobLead[]
  getCompany: (id: string) => MarkCompany
}) {
  const extension = useExtension()
  const resumeQuery = useResumes()
  const suggestionQuery = useSuggestions()
  const resumes = resumeQuery.data ?? []
  const suggestions = suggestionQuery.data ?? []
  const update = useUpdateApplication()
  const record = useRecordApplyClick()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const active = useRef<Set<string>>(new Set())
  const autoStarted = useRef<Set<string>>(new Set())
  const approvedIds = useMemo(() => new Set(leads
    .filter((lead) => lead.status === 'saved' && lead.application_id)
    .map((lead) => lead.application_id!)), [leads])
  const plan = useMemo(() => planApplyBatch({
    apps,
    companyName: (id) => getCompany(id).name,
    leads,
    suggestions,
    resumes,
  }), [apps, getCompany, leads, resumes, suggestions])
  const autoKey = plan.items.map((item) => item.app.id).join('|')

  useEffect(() => {
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<ApplyAssistResult>).detail
      if (!result?.application_id || !active.current.has(result.application_id)) return
      const app = apps.find((a) => a.id === result.application_id)
      const company = app ? getCompany(app.companyId).name : 'One application'
      if (result.status === 'blocked') {
        const why = result.blocker === 'captcha' ? 'a CAPTCHA'
          : result.blocker === 'account' ? 'account creation'
            : result.blocker === 'login' ? 'a sign-in'
              : result.blocker === 'answers' ? 'required answers'
                : result.blocker === 'files' ? 'a required file'
                  : result.blocker === 'review' ? 'flagged fields'
                    : 'the final submit control'
        setNote(`${company} needs you for ${why}. The other pages are still going.`)
      } else if (result.status === 'submitted') {
        setNote(`${company} was submitted. Waiting for the portal confirmation.`)
      } else if (result.status === 'error') {
        setNote(`${company} couldn't be autofilled${result.message ? `: ${result.message}` : '.'} The other pages are still going.`)
      }
    }
    window.addEventListener(APPLY_ASSIST_RESULT_EVENT, onResult)
    return () => window.removeEventListener(APPLY_ASSIST_RESULT_EVENT, onResult)
  }, [apps, getCompany])

  const run = useCallback(async () => {
    if (busy) return
    if (resumeQuery.isLoading || suggestionQuery.isLoading) {
      setNote('Loading the apply queue…')
      return
    }
    active.current = new Set()
    if (!extension.data) {
      setNote('Install or reload the Landed extension in this browser first.')
      return
    }
    if (plan.items.length === 0) {
      setNote(plan.skipped.length ? plan.skipped.filter((s) => s.reason !== 'not-approved').map((s) => s.message).slice(0, 2).join(' · ') : 'No approved applications are ready to run.')
      return
    }

    setBusy(true)
    setNote(null)
    const opened: string[] = []
    const failed: string[] = []
    try {
      // Await each open so tabs appear in queue order. Filling/review then
      // runs independently in every tab inside the extension.
      for (const item of plan.items) {
        const res = await bridgeCall<{ tab_id: number }>('assist-open', {
          url: item.target.url,
          resume_id: item.resume.resume.id,
          application_id: item.target.application_id,
          lead_id: item.target.lead_id,
          submit_authorized: true,
        })
        if (!res.ok) {
          failed.push(`${item.company} · ${item.app.role}`)
          continue
        }
        opened.push(item.app.id)
        active.current.add(item.app.id)
        record({ kind: 'application', id: item.app.id, role: item.app.role, stage: item.app.stage, company_name: item.company })
        try {
          await update.mutateAsync({ id: item.app.id, patch: { next_step: APPLY_FILLING } })
        } catch {
          // The tab is already open; a storage error must not stop the rest.
        }
      }
      const skipped = plan.skipped.filter((s) => ['company-progress', 'recruiter'].includes(s.reason))
      const parts = [
        opened.length && `Started ${opened.length} of ${APPLY_BATCH_LIMIT} — filling, reviewing and submitting when safe`,
        failed.length && `${failed.length} couldn't be opened`,
        skipped.length && `Skipped: ${skipped.map((s) => s.message).slice(0, 2).join('; ')}`,
      ].filter(Boolean)
      setNote(parts.join(' · ') || 'Nothing opened.')
    } finally {
      setBusy(false)
    }
  }, [busy, extension.data, plan, record, resumeQuery.isLoading, suggestionQuery.isLoading, update])

  useEffect(() => {
    if (!autoKey || busy || extension.isLoading || !extension.data || resumeQuery.isLoading || suggestionQuery.isLoading) return
    if (autoStarted.current.has(autoKey)) return
    autoStarted.current.add(autoKey)
    void run()
  }, [autoKey, busy, extension.data, extension.isLoading, resumeQuery.isLoading, run, suggestionQuery.isLoading])

  if (approvedIds.size === 0) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" className="btn-primary" disabled={busy || extension.isLoading || resumeQuery.isLoading || suggestionQuery.isLoading} onClick={() => void run()}
          style={{ fontSize: 11.5, padding: '4px 9px' }} title="Retry approved applications that are ready to run.">
          <Icon name="sparkle" size={11} /> {busy ? 'Applying…' : 'Retry approved'}
        </button>
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>Approved jobs run automatically · up to 5 at a time</span>
      </div>
      {note && <div role="status" style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{note}</div>}
    </div>
  )
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
