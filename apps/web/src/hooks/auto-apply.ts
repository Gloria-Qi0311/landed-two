// Auto apply (#99) is event-driven, not a daemon schedule: Approve grants
// permission for one linked lead, and this global runner hands ready work to
// the browser extension. It is mounted below the login gate, so execution no
// longer depends on the Applications route being visible. Automation and the
// Leads header share the small control/status store below.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { bridgeCall, onExtensionReady } from '../lib/extension-bridge'
import {
  APPLY_ASSIST_RESULT_EVENT,
  APPLY_BATCH_LIMIT,
  APPLY_BLOCKED,
  APPLY_FILLING,
  APPLY_SUBMITTED,
  planApplyBatch,
  type ApplyAssistResult,
} from '../lib/apply-batch'
import { useApplications, useCompanies, useUpdateApplication } from './queries'
import { useJobLeads, useRecordApplyClick, useSuggestions } from './inbox'
import { useResumes } from './resumes'
import { askAgentToPick, resumeChoiceFor, type AgentPick, type AskAgent } from '../lib/apply-assist'
import { useResumeFiles } from './answers'
import { useAutomations } from './automation'

type AutoApplyControl = {
  busy: boolean
  note: string | null
  ready: boolean
  queued: number
  active: number
  blocked: number
  awaiting_confirmation: number
  last_started_at: string | null
  request: number
}


/** Ask the user's own agent, through the extension and Landed for Mac. */
const askAgent: AskAgent = async (request) => {
  const res = await bridgeCall<{ pick: AgentPick }>('pick-resume', request, 100_000)
  return res.ok ? res.data.pick : null
}

export const useAutoApplyControl = create<AutoApplyControl>(() => ({
  busy: false,
  note: null,
  ready: false,
  queued: 0,
  active: 0,
  blocked: 0,
  awaiting_confirmation: 0,
  last_started_at: null,
  request: 0,
}))

export function requestAutoApplyRun() {
  useAutoApplyControl.setState((state) => ({ request: state.request + 1 }))
}

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

const resultNote = (result: ApplyAssistResult, company: string) => {
  if (result.status === 'submitted') return `${company} was submitted. Waiting for the portal confirmation.`
  if (result.status === 'error') return `${company} couldn't be autofilled${result.message ? `: ${result.message}` : '.'}`
  if (result.status !== 'blocked') return null
  const why = result.blocker === 'captcha' ? 'a CAPTCHA'
    : result.blocker === 'account' ? 'account creation'
      : result.blocker === 'login' ? 'a sign-in'
        : result.blocker === 'answers' ? 'required answers'
          : result.blocker === 'files' ? 'a required file'
            : result.blocker === 'review' ? 'flagged fields'
              : 'the final submit control'
  return `${company} needs you for ${why}. Other approved applications can continue.`
}

/** Mount once below the login gate. */
export function useAutoApplyRunner() {
  const appsQuery = useApplications()
  const companiesQuery = useCompanies()
  const leadsQuery = useJobLeads()
  const resumesQuery = useResumes()
  const suggestionsQuery = useSuggestions()
  const extension = useExtension()
  const update = useUpdateApplication()
  const record = useRecordApplyClick()
  const { automations, loaded } = useAutomations()
  const busy = useAutoApplyControl((state) => state.busy)
  const request = useAutoApplyControl((state) => state.request)
  const seenRequest = useRef(0)
  const autoStarted = useRef<Set<string>>(new Set())

  useEffect(() => () => useAutoApplyControl.setState({
    busy: false,
    note: null,
    ready: false,
    queued: 0,
    active: 0,
    blocked: 0,
    awaiting_confirmation: 0,
    last_started_at: null,
    request: 0,
  }), [])

  const apps = appsQuery.data ?? []
  const companies = companiesQuery.data ?? []
  const leads = leadsQuery.data ?? []
  const resumes = resumesQuery.data ?? []
  const suggestions = suggestionsQuery.data ?? []
  const resumeFiles = useResumeFiles().data
  const hasFile = useMemo(() => {
    if (!resumeFiles) return undefined
    const ids = new Set(resumeFiles.map((f) => f.resume_id))
    return (id: string) => ids.has(id)
  }, [resumeFiles])
  const names = useMemo(() => new Map(companies.map((company) => [company.id, company.name])), [companies])
  const authorized = useMemo(() => new Set(leads
    .filter((lead) => lead.status === 'saved' && lead.application_id)
    .map((lead) => lead.application_id!)), [leads])
  const active = apps.filter((app) => authorized.has(app.id) && app.stage === 'saved' && app.nextStep.startsWith(APPLY_FILLING)).length
  const blocked = apps.filter((app) => authorized.has(app.id) && app.stage === 'saved' && app.nextStep.startsWith(APPLY_BLOCKED)).length
  const awaiting = apps.filter((app) => authorized.has(app.id) && app.stage === 'saved' && app.nextStep.startsWith(APPLY_SUBMITTED)).length
  const max = automations.auto_apply.max_concurrent
  const plan = useMemo(() => planApplyBatch({
    apps,
    companyName: (id) => names.get(id) ?? 'Unknown company',
    leads,
    suggestions,
    resumes,
    hasFile,
    limit: Math.max(0, max - active),
  }), [active, apps, hasFile, leads, max, names, resumes, suggestions])
  const autoKey = plan.items.map((item) => item.app.id).join('|')

  useEffect(() => {
    useAutoApplyControl.setState({
      ready: !!extension.data,
      queued: plan.items.length,
      active,
      blocked,
      awaiting_confirmation: awaiting,
    })
  }, [active, awaiting, blocked, extension.data, plan.items.length])

  useEffect(() => {
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<ApplyAssistResult>).detail
      if (!result?.application_id || !authorized.has(result.application_id)) return
      const app = apps.find((item) => item.id === result.application_id)
      const company = app ? names.get(app.companyId) ?? 'One application' : 'One application'
      const note = resultNote(result, company)
      if (note) useAutoApplyControl.setState({ note })
    }
    window.addEventListener(APPLY_ASSIST_RESULT_EVENT, onResult)
    return () => window.removeEventListener(APPLY_ASSIST_RESULT_EVENT, onResult)
  }, [apps, authorized, names])

  const run = useCallback(async () => {
    if (useAutoApplyControl.getState().busy) return
    if (!extension.data) {
      useAutoApplyControl.setState({ note: 'Install or reload the Landed extension in this browser first.' })
      return
    }
    if (plan.items.length === 0) {
      const useful = plan.skipped.filter((skip) => skip.reason !== 'not-approved').map((skip) => skip.message)
      useAutoApplyControl.setState({ note: active >= max
        ? `Auto apply is at its ${max}-application limit. The next approved job starts when one finishes.`
        : useful.slice(0, 2).join(' · ') || 'No approved applications are ready to run.' })
      return
    }

    useAutoApplyControl.setState({ busy: true, note: null })
    const opened: string[] = []
    const failed: string[] = []
    try {
      for (const item of plan.items.slice(0, APPLY_BATCH_LIMIT)) {
        // Between close resumes, the user's agent reads the posting and
        // chooses; without one the rules' pick stands.
        const pick = await askAgentToPick(item.resume, { role: item.app.role, company: item.company, description: item.description }, askAgent)
        const res = await bridgeCall<{ tab_id: number }>('assist-open', {
          url: item.target.url,
          resume_id: pick.resume.id,
          application_id: item.target.application_id,
          lead_id: item.target.lead_id,
          submit_authorized: true,
        })
        if (!res.ok) {
          failed.push(`${item.company} · ${item.app.role}`)
          continue
        }
        opened.push(item.app.id)
        record({ kind: 'application', id: item.app.id, role: item.app.role, stage: item.app.stage, company_name: item.company })
        try {
          // Which resume, and why, stays on the application (its drawer).
          await update.mutateAsync({ id: item.app.id, patch: { next_step: APPLY_FILLING, resume_choice: resumeChoiceFor(pick) } })
        } catch {
          // The authorized tab is already running; one write failure must not
          // stop the rest of the queue.
        }
      }
      const skipped = plan.skipped.filter((skip) => ['company-progress', 'recruiter'].includes(skip.reason))
      const parts = [
        opened.length && `Started ${opened.length} — filling, reviewing and submitting when safe`,
        failed.length && `${failed.length} couldn't be opened`,
        skipped.length && `Skipped: ${skipped.map((skip) => skip.message).slice(0, 2).join('; ')}`,
      ].filter(Boolean)
      useAutoApplyControl.setState({
        note: parts.join(' · ') || 'Nothing opened.',
        last_started_at: opened.length ? new Date().toISOString() : useAutoApplyControl.getState().last_started_at,
      })
    } finally {
      useAutoApplyControl.setState({ busy: false })
    }
  }, [active, extension.data, max, plan, record, update])

  useEffect(() => {
    if (!loaded || appsQuery.isLoading || companiesQuery.isLoading || leadsQuery.isLoading || resumesQuery.isLoading || suggestionsQuery.isLoading || extension.isLoading || busy) return
    const manual = request !== seenRequest.current
    if (manual) seenRequest.current = request
    if (!manual && !automations.auto_apply.enabled) return
    if (!manual && !autoKey) return
    // Do not consume an automatic queue key while the extension is absent:
    // extension-ready invalidates the query, and the same work should then
    // start without another Approve click. A manual run still explains why.
    if (!extension.data) {
      if (manual) void run()
      return
    }
    const key = manual ? `manual:${request}:${autoKey}` : `auto:${autoKey}`
    if (autoStarted.current.has(key)) return
    autoStarted.current.add(key)
    void run()
  }, [appsQuery.isLoading, autoKey, automations.auto_apply.enabled, busy, companiesQuery.isLoading, extension.data, extension.isLoading, leadsQuery.isLoading, loaded, request, resumesQuery.isLoading, run, suggestionsQuery.isLoading])
}
