// Approved-lead execution (#99): choose up to five approved applications in
// the same priority order as the Leads column. Approval is the per-job
// authorization to open, fill, review and submit. This module is deliberately
// pure so the authorization boundary, skip rules and extension results stay
// testable outside React.
import { FILL_TRACE_REF } from '@landed/schema/fill-trace'
import type { DbJobLead, DbResume, DbSuggestion } from './store/types'
import { byPriority, rankOf } from './fit'
import { pickResumeFor, type AssistTarget, type ResumePick } from './apply-assist'

export const APPLY_BATCH_LIMIT = 5
export const APPLY_FILLING = 'Filling & reviewing…'
export const APPLY_REVIEW = 'Review highlighted fields, then submit'
export const APPLY_SUBMITTED = 'Submitted · waiting for confirmation'
export const APPLY_BLOCKED = 'Blocked · '

type BatchApp = {
  id: string
  companyId: string
  role: string
  stage: string
  portal_application_url: string | null
  deadline: string | null
  nextStep: string
}

export type BatchSkipReason = 'not-approved' | 'company-progress' | 'recruiter' | 'already-open' | 'missing-link' | 'missing-resume'
export type BatchSkip = { app: BatchApp; company: string; reason: BatchSkipReason; message: string }
export type BatchItem = {
  app: BatchApp
  company: string
  target: AssistTarget
  resume: ResumePick
}

export type ApplyAssistBlocker = 'login' | 'account' | 'captcha' | 'answers' | 'files' | 'review' | 'submit'
export type ApplyAssistResult = {
  application_id: string | null
  lead_id: string | null
  tab_id: number
  status: 'ready' | 'submitted' | 'blocked' | 'error'
  blocker: ApplyAssistBlocker | null
  message: string | null
  filled: number
  review: number
  at: string
  /** the fill's trace (`landed fill-trace <ref>`), when the extension kept one */
  trace_ref: string | null
}

const ACTIVE_COMPANY_STAGES = new Set(['oa', 'interview', 'phone', 'onsite', 'offer'])
const ALREADY_OPEN = [APPLY_FILLING, APPLY_REVIEW, APPLY_SUBMITTED, APPLY_BLOCKED]

const stageName = (stage: string) => stage === 'oa' ? 'OA / Test' : stage === 'offer' ? 'Offer' : 'Interview'

/** Up to five jobs worth opening, plus every higher-priority one we skipped
 * while looking for them. A skipped job never consumes a slot. */
export function planApplyBatch({
  apps,
  companyName,
  leads,
  suggestions,
  resumes,
  now = new Date(),
  limit = APPLY_BATCH_LIMIT,
}: {
  apps: BatchApp[]
  companyName: (companyId: string) => string
  leads: DbJobLead[]
  suggestions: DbSuggestion[]
  resumes: DbResume[]
  now?: Date
  limit?: number
}): { items: BatchItem[]; skipped: BatchSkip[] } {
  const leadByApp = new Map(leads.filter((l) => l.application_id).map((l) => [l.application_id!, l]))
  const saved = apps
    .filter((a) => a.stage === 'saved')
    .map((app) => ({ app, rank: rankOf({ app: { id: app.id, deadline: app.deadline } }, (id) => leadByApp.get(id), now) }))
    .sort((a, b) => byPriority(a.rank, b.rank))

  const appById = new Map(apps.map((a) => [a.id, a]))
  const activeByCompany = new Map<string, string>()
  for (const app of apps) {
    if (ACTIVE_COMPANY_STAGES.has(app.stage) && !activeByCompany.has(app.companyId)) activeByCompany.set(app.companyId, app.stage)
  }
  const recruiterCompanies = new Set<string>()
  for (const s of suggestions) {
    if (s.status !== 'recruiter_response' || s.state === 'rejected' || s.state === 'undone') continue
    const app = s.application_id ? appById.get(s.application_id) : null
    if (app && !['rejected', 'ghosted'].includes(app.stage)) recruiterCompanies.add(app.companyId)
  }

  const items: BatchItem[] = []
  const skipped: BatchSkip[] = []
  for (const { app } of saved) {
    if (items.length >= Math.max(0, Math.min(APPLY_BATCH_LIMIT, limit))) break
    const company = companyName(app.companyId) || 'Unknown company'
    const lead = leadByApp.get(app.id)
    if (!lead || lead.status !== 'saved') {
      skipped.push({ app, company, reason: 'not-approved', message: `${company} · ${app.role} was not approved from Leads` })
      continue
    }
    const active = activeByCompany.get(app.companyId)
    if (active) {
      skipped.push({ app, company, reason: 'company-progress', message: `${company} already has an application at ${stageName(active)}` })
      continue
    }
    if (recruiterCompanies.has(app.companyId)) {
      skipped.push({ app, company, reason: 'recruiter', message: `${company} already has recruiter activity` })
      continue
    }
    if (ALREADY_OPEN.some((prefix) => app.nextStep.startsWith(prefix))) {
      skipped.push({ app, company, reason: 'already-open', message: `${company} · ${app.role} is already waiting for you` })
      continue
    }
    if (!app.portal_application_url) {
      skipped.push({ app, company, reason: 'missing-link', message: `${company} · ${app.role} has no job link` })
      continue
    }
    const target: AssistTarget = {
      application_id: app.id,
      lead_id: lead.id,
      company,
      role: app.role,
      url: app.portal_application_url,
    }
    const resume = pickResumeFor(target, resumes)
    if (!resume) {
      skipped.push({ app, company, reason: 'missing-resume', message: `${company} · ${app.role} needs a resume first` })
      continue
    }
    items.push({ app, company, target, resume })
  }
  return { items, skipped }
}

const blockerMessage: Record<ApplyAssistBlocker, string> = {
  login: 'Sign in required',
  account: 'Account creation required',
  captcha: 'CAPTCHA needs you',
  answers: 'Answer required questions in Extension',
  files: 'Required application file is missing',
  review: 'Review flagged fields',
  submit: 'Final submit needs you',
}

/** What the application card records after an extension result. */
export function nextStepForAssistResult(result: Pick<ApplyAssistResult, 'status' | 'blocker' | 'message'> & { trace_ref?: string | null }): string {
  const step = result.status === 'submitted' ? APPLY_SUBMITTED
    : result.status === 'ready' ? APPLY_REVIEW
    : result.status === 'blocked' && result.blocker ? APPLY_BLOCKED + blockerMessage[result.blocker]
    : APPLY_BLOCKED + (result.message?.trim().slice(0, 120) || 'Autofill could not finish')
  // The fill's ref, to look up what it did when it went wrong.
  return result.trace_ref ? `${step} · fill ${result.trace_ref}` : step
}

/** Extension storage is outside React's type boundary; accept only the small
 * result shape Landed itself emits. */
export function parseApplyAssistResults(raw: unknown): ApplyAssistResult[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    if (!['ready', 'submitted', 'blocked', 'error'].includes(String(r.status)) || !Number.isSafeInteger(r.tab_id)) return []
    const blocker = ['login', 'account', 'captcha', 'answers', 'files', 'review', 'submit'].includes(String(r.blocker)) ? r.blocker as ApplyAssistBlocker : null
    const id = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null
    return [{
      application_id: id(r.application_id),
      lead_id: id(r.lead_id),
      tab_id: Number(r.tab_id),
      status: r.status as ApplyAssistResult['status'],
      blocker,
      message: typeof r.message === 'string' ? r.message.slice(0, 300) : null,
      filled: Number.isSafeInteger(Number(r.filled)) ? Math.max(0, Number(r.filled)) : 0,
      review: Number.isSafeInteger(Number(r.review)) ? Math.max(0, Number(r.review)) : 0,
      at: typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date().toISOString(),
      trace_ref: typeof r.trace_ref === 'string' && FILL_TRACE_REF.test(r.trace_ref) ? r.trace_ref : null,
    }]
  })
}

export const APPLY_ASSIST_RESULT_EVENT = 'landed:apply-assist-result'
