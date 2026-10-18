// Runs the observation processor against the account's store, and the user
// actions on its output (job leads + review queue). Works the same for both
// stores: local accounts process what the relay delivered into this
// browser; Cloud accounts process their pending observations via the API.
// Results of tasks on the user's own computer (job searches, email checks,
// portal checks) go through the same processor. Rules live in packages/observation-processor
// (docs/observation-processor.md).
//
// One file per flow; this index keeps `lib/inbox` imports working.
export { processPending } from './process'
export { ingestEmailFindings, type EmailIngestResult } from './email'
export { ingestFoundJobs, addLeadToPipeline, dismissLead, restoreLead, type IngestResult } from './leads'
export { isClickQuestion, isQuietQuestion, isPanelQuestion, recordApplyClick, QUIET_DAYS, IN_PROGRESS, lastSignal, quietDays, flagQuietApplications, openPanelQuestions, settleQuestions, type ClickTarget } from './questions'
export { ingestPortalResults, type PortalIngestResult } from './portal'
export { acceptSuggestion, rejectSuggestion, undoSuggestion, canUndo } from './review'
export { isForward, matchReported, addReportedApplication, type ReportedMatch } from './reported'
export { PORTAL_APPLIED, isSeenConfirmation, ingestPortalConfirmations } from './confirmations'
export { repairRoundOrder } from './repair'
