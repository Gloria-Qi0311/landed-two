// Auto apply (#99) is event-driven, not a daemon schedule: Approve grants
// permission for one linked lead, and this global runner hands ready work to
// the browser extension. It is mounted below the login gate, so execution no
// longer depends on the Applications route being visible. Automation and the
// Leads header share the small control/status store below.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { addUnanswered, EMPTY_ANSWERS, sameQuestion, type ApplicationAnswers, type ReportedQuestion } from '@landed/schema/application-answers'
import { bridgeCall, onExtensionReady } from '../lib/extension-bridge'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import {
  APPLY_ASSIST_RESULT_EVENT,
  APPLY_BATCH_LIMIT,
  APPLY_BLOCKED,
  APPLY_FILLING,
  APPLY_SUBMITTED,
  nextStepForAssistResult,
  planApplyBatch,
  type ApplyAssistResult,
} from '../lib/apply-batch'
import { useApplications, useCompanies, useUpdateApplication } from './queries'
import { useJobLeads, useRecordApplyClick, useSuggestions } from './inbox'
import { useResumes } from './resumes'
import { askAgentToPick, resumeChoiceFor, type AgentPick, type AskAgent } from '../lib/apply-assist'
import { openAnswerExamples } from '../lib/open-answers'
import { useApplicationAnswers, useResumeFiles } from './answers'
import { useAutomations } from './automation'
import { useAgentConnections } from './agents'

type AgentApplyResult = {
  status: 'submitted' | 'blocked' | 'error'
  blocker: 'login' | 'account' | 'captcha' | 'answers' | 'files' | 'review' | 'submit' | null
  message: string | null
  unanswered: ReportedQuestion[]
  at: string
}

type AgentApplyTask = {
  id: string
  connection_id: string
  application_id: string
  lead_id: string | null
  status: 'pending' | AgentApplyResult['status']
  result: AgentApplyResult | null
  created_at: string
  completed_at: string | null
}

/** Saved facts agents may use to fill forms. Internal learning metadata and
 * pending questions are not answers, so they never enter the task context. */
function answersForAgent(answers: ApplicationAnswers) {
  const { unanswered: _u, skipped: _s, prefilled: _p, learned: _l, ...facts } = answers
  return facts
}

/** A returned question has since gained an actual shared answer. Merely
 * skipping/dismissing it is not an answer and must not resume submission. */
function returnedQuestionAnswered(answers: ApplicationAnswers, question: ReportedQuestion): boolean {
  if (typeof question.key === 'string' && question.key in answers) {
    const value = (answers as unknown as Record<string, unknown>)[question.key]
    if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) return true
  }
  const text = typeof question.question === 'string' ? question.question : ''
  return !!text && answers.custom.some((item) => sameQuestion(item.question, text))
}

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
  const qc = useQueryClient()
  const { store, ready: storeReady } = useStore()
  const appsQuery = useApplications()
  const companiesQuery = useCompanies()
  const leadsQuery = useJobLeads()
  const resumesQuery = useResumes()
  const suggestionsQuery = useSuggestions()
  const extension = useExtension()
  const update = useUpdateApplication()
  const record = useRecordApplyClick()
  const { automations, loaded } = useAutomations()
  const connections = useAgentConnections()
  const storedAnswers = useApplicationAnswers()
  const agentTasks = useQuery({
    queryKey: ['agent_apply_tasks'],
    enabled: storeReady,
    queryFn: () => api.get<AgentApplyTask[]>('/agent-apply-tasks'),
    refetchInterval: 10_000,
  })
  const busy = useAutoApplyControl((state) => state.busy)
  const request = useAutoApplyControl((state) => state.request)
  const seenRequest = useRef(0)
  const autoStarted = useRef<Set<string>>(new Set())
  const processingAgentResults = useRef<Set<string>>(new Set())
  const retryingAgentTasks = useRef<Set<string>>(new Set())

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
  const resumeFilesQuery = useResumeFiles()
  const resumeFiles = resumeFilesQuery.data
  const hasFile = useMemo(() => {
    if (!resumeFiles) return undefined
    const ids = new Set(resumeFiles.map((f) => f.resume_id))
    return (id: string) => ids.has(id)
  }, [resumeFiles])
  const executorId = automations.auto_apply.executor
  const personalAgent = executorId === 'extension' ? null : (connections.data ?? []).find((c) => c.id === executorId && !c.revoked_at) ?? null
  const executorReady = executorId === 'extension' ? !!extension.data : !!personalAgent
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

  // Personal-agent results rejoin the same local-first answer/application
  // stores as extension results. Ack only after both writes succeed; the
  // server then erases the copied context and resume bytes.
  useEffect(() => {
    const sharedAnswers = storedAnswers.data?.answers ?? EMPTY_ANSWERS
    for (const task of agentTasks.data ?? []) {
      if (task.status === 'pending' || !task.result) continue
      if (processingAgentResults.current.has(task.id)) {
        const readyToRetry = task.result.unanswered.length > 0
          && task.result.unanswered.every((question) => returnedQuestionAnswered(sharedAnswers, question))
        if (!readyToRetry || retryingAgentTasks.current.has(task.id)) continue
        retryingAgentTasks.current.add(task.id)
        void (async () => {
          try {
            await api.post(`/agent-apply-tasks/${task.id}/retry`, { application_answers: answersForAgent(sharedAnswers) })
            const app = (await store.listApplications()).find((item) => item.id === task.application_id)
            if (app?.stage === 'saved') await store.updateApplication(app.id, { next_step: APPLY_FILLING })
            processingAgentResults.current.delete(task.id)
            qc.invalidateQueries({ queryKey: ['applications'] })
            qc.invalidateQueries({ queryKey: ['agent_apply_tasks'] })
            const company = app ? names.get(app.company_id) ?? 'One application' : 'One application'
            useAutoApplyControl.setState({ note: `${company} has the missing ${task.result!.unanswered.length === 1 ? 'answer' : 'answers'} now. Sent back to ${personalAgent?.display_name ?? 'your personal agent'}.` })
          } catch (e) {
            console.warn('[landed] could not resume a personal-agent application', e)
          } finally {
            retryingAgentTasks.current.delete(task.id)
          }
        })()
        continue
      }
      processingAgentResults.current.add(task.id)
      void (async () => {
        try {
          if (task.result!.unanswered.length) {
            const current = (await store.getApplicationAnswers())?.answers ?? EMPTY_ANSWERS
            const next = addUnanswered(current, task.result!.unanswered, task.result!.at)
            if (JSON.stringify(next.unanswered) !== JSON.stringify(current.unanswered)) await store.saveApplicationAnswers(next)
          }
          const currentApps = await store.listApplications()
          const app = currentApps.find((a) => a.id === task.application_id)
          if (app?.stage === 'saved') {
            await store.updateApplication(app.id, {
              next_step: nextStepForAssistResult({
                status: task.result!.status,
                blocker: task.result!.blocker,
                message: task.result!.message,
              }),
            })
          }
          // Missing answers keep the one-job task (and its file) available.
          // Once the user answers them, the branch above refreshes context
          // and re-offers it. Other terminal results can be erased now.
          if (!task.result!.unanswered.length) await api.post(`/agent-apply-tasks/${task.id}/ack`)
          qc.invalidateQueries({ queryKey: ['application_answers'] })
          qc.invalidateQueries({ queryKey: ['applications'] })
          qc.invalidateQueries({ queryKey: ['agent_apply_tasks'] })
          const company = app ? names.get(app.company_id) ?? 'One application' : 'One application'
          useAutoApplyControl.setState({ note: task.status === 'submitted'
            ? `${company} was submitted by ${personalAgent?.display_name ?? 'your personal agent'}. Waiting for the portal confirmation.`
            : task.result!.unanswered.length
              ? `${company} needs ${task.result!.unanswered.length} ${task.result!.unanswered.length === 1 ? 'answer' : 'answers'} from you. They are now in Needs your input.`
              : `${company} stopped: ${task.result!.message ?? task.result!.blocker ?? 'the agent could not finish'}.` })
        } catch (e) {
          console.warn('[landed] could not store a personal-agent application result', e)
          processingAgentResults.current.delete(task.id)
        }
      })()
    }
  }, [agentTasks.data, names, personalAgent?.display_name, qc, store, storedAnswers.data?.answers])

  useEffect(() => {
    useAutoApplyControl.setState({
      ready: executorReady,
      queued: plan.items.length,
      active,
      blocked,
      awaiting_confirmation: awaiting,
    })
  }, [active, awaiting, blocked, executorReady, plan.items.length])

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
    if (!executorReady) {
      useAutoApplyControl.setState({ note: executorId === 'extension'
        ? 'Install or reload the Landed extension in this browser first.'
        : 'Reconnect the personal agent selected for Auto apply, or choose another one.' })
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
    const examples = openAnswerExamples(apps)
    const opened: string[] = []
    const failed: string[] = []
    try {
      for (const item of plan.items.slice(0, APPLY_BATCH_LIMIT)) {
        // Between close resumes, the user's agent reads the posting and
        // chooses; without one the rules' pick stands.
        const pick = executorId === 'extension'
          ? await askAgentToPick(item.resume, { role: item.app.role, company: item.company, description: item.description }, askAgent)
          : item.resume
        if (executorId === 'extension') {
          const res = await bridgeCall<{ tab_id: number }>('assist-open', {
            url: item.target.url,
            resume_id: pick.resume.id,
            application_id: item.target.application_id,
            lead_id: item.target.lead_id,
            submit_authorized: true,
            // For open-ended answers: the job, and the user's own edited answers.
            job: { role: item.app.role, company: item.company, description: item.description ?? '' },
            examples,
          })
          if (!res.ok) {
            failed.push(`${item.company} · ${item.app.role}`)
            continue
          }
        } else {
          try {
            const [file, meta] = await Promise.all([
              store.getResumeFileData(pick.resume.id),
              Promise.resolve(resumeFiles?.find((f) => f.resume_id === pick.resume.id) ?? null),
            ])
            await api.post<AgentApplyTask>('/agent-apply-tasks', {
              id: crypto.randomUUID(),
              connection_id: executorId,
              application_id: item.target.application_id,
              lead_id: item.target.lead_id,
              submit_authorized: true,
              job: { role: item.app.role, company: item.company, url: item.target.url, description: item.description ?? '' },
              context: {
                selected_resume: pick.resume.parsed_json,
                selected_resume_name: pick.resume.name,
                selected_resume_reason: pick.reason ?? pick.why,
                application_answers: answersForAgent(storedAnswers.data?.answers ?? EMPTY_ANSWERS),
                previous_open_answers: examples,
              },
              resume: file && meta ? { id: file.id, resume_id: pick.resume.id, name: meta.name, data: file.data } : null,
            })
          } catch {
            failed.push(`${item.company} · ${item.app.role}`)
            continue
          }
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
        opened.length && (executorId === 'extension'
          ? `Started ${opened.length} — filling, reviewing and submitting when safe`
          : `Sent ${opened.length} to ${personalAgent?.display_name ?? 'your personal agent'} — it will use your Landed context and report missing answers`),
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
  }, [active, apps, executorId, executorReady, max, personalAgent?.display_name, plan, record, resumeFiles, store, storedAnswers.data?.answers, update])

  useEffect(() => {
    if (!loaded || appsQuery.isLoading || companiesQuery.isLoading || leadsQuery.isLoading || resumesQuery.isLoading || suggestionsQuery.isLoading || busy) return
    if (executorId === 'extension' ? extension.isLoading : connections.isLoading || storedAnswers.isLoading || resumeFilesQuery.isLoading) return
    const manual = request !== seenRequest.current
    if (manual) seenRequest.current = request
    if (!manual && !automations.auto_apply.enabled) return
    if (!manual && !autoKey) return
    // Do not consume an automatic queue key while the extension is absent:
    // extension-ready invalidates the query, and the same work should then
    // start without another Approve click. A manual run still explains why.
    if (!executorReady) {
      if (manual) void run()
      return
    }
    const key = manual ? `manual:${request}:${autoKey}` : `auto:${autoKey}`
    if (autoStarted.current.has(key)) return
    autoStarted.current.add(key)
    void run()
  }, [appsQuery.isLoading, autoKey, automations.auto_apply.enabled, busy, companiesQuery.isLoading, connections.isLoading, executorId, executorReady, extension.isLoading, leadsQuery.isLoading, loaded, request, resumeFilesQuery.isLoading, resumesQuery.isLoading, run, storedAnswers.isLoading, suggestionsQuery.isLoading])
}
