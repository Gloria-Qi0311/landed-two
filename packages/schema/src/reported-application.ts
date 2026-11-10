// An application Landed learned about from outside the pipeline: a
// "thanks for applying" page the extension saw (apps/web/src/lib/inbox/
// confirmations.ts). lib/inbox/reported.ts matches it to an application or
// lead, or adds it. Plain TS, no dependencies.

export const REPORTED_STAGES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected'] as const
export type ReportedStage = typeof REPORTED_STAGES[number]

export type ReportedApplication = {
  company: string
  role: string
  stage: ReportedStage
  /** YYYY-MM-DD */
  applied_on: string | null
  job_url: string | null
  location: string | null
  note: string | null
}
