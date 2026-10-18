// Email-check results (from the user's computer) → status updates.
import { processObservation, type Settings } from '@landed/observation-processor'
import type { EmailFinding } from '@landed/schema/email-check'
import type { DataStore } from '../store/types'
import { isConflict, applyOutcome, loadContext } from './process'
import { settleQuestions } from './questions'

// ── email check results → status updates ─────────────────────────────────

export type EmailIngestResult = {
  found: number
  /** stage changes applied automatically */
  updated: number
  /** applications added automatically (an email for something untracked) */
  added: number
  /** waiting on the user ("Needs your input") */
  needs_input: number
  notes: number
  /** already known (seen in an earlier check) or nothing to change */
  unchanged: number
}

/**
 * Emails the user's agent read (email_check task) → status updates, through
 * the processor as `application_status` observations: same matching,
 * same auto-apply rules (≥ 0.8 + evidence, forward only), same undo. Re-
 * reading an email changes nothing: suggestions dedupe on the message id.
 */
export async function ingestEmailFindings(
  store: DataStore,
  findings: EmailFinding[],
  source: { run_id: string; runtime_id: string; agent: string; mail: string },
  settings: Settings,
): Promise<EmailIngestResult> {
  let ctx = await loadContext(store, settings)
  const result: EmailIngestResult = { found: findings.length, updated: 0, added: 0, needs_input: 0, notes: 0, unchanged: 0 }
  const observedAt = new Date().toISOString()
  // Oldest email first, the order things happened in (agents often report
  // newest first): application → assessment → interview rounds.
  const received = (f: EmailFinding) => Date.parse(f.evidence.received_at ?? '') || Infinity
  const ordered = [...findings].sort((a, b) => received(a) - received(b))
  for (const [i, f] of ordered.entries()) {
    // Agents sometimes omit the id; this keeps re-reads of the same email deduped.
    const fallback = [f.evidence.sender_domain, f.evidence.subject, f.evidence.received_at].filter(Boolean).join('|')
    const evidence = { ...f.evidence, source: source.mail.toLowerCase(), ...(f.evidence.message_id || !fallback ? {} : { message_id: fallback }) }
    const outcome = processObservation({
      id: `${source.run_id}:${i}`,
      connection_id: `runtime:${source.runtime_id}`,
      observation_type: 'application_status',
      observed_at: observedAt,
      provider: source.agent,
      payload_json: { payload: {
        status: f.status, company: f.company, role: f.role, job_url: f.job_url, confidence: f.confidence, evidence,
        interview_at: f.interview_at, interview_format: f.interview_format,
      } },
    }, ctx, { now: observedAt, newId: () => crypto.randomUUID() })
    try {
      ctx = await applyOutcome(store, outcome, ctx)
    } catch (err) {
      if (isConflict(err)) continue
      throw err
    }
    const types = outcome.effects.map((e) => e.type)
    if (types.includes('set_stage')) result.updated++
    else if (types.includes('create_application')) result.added++
    else if (outcome.status === 'needs-review' && !outcome.result.merged && outcome.effects.length) result.needs_input++
    else if (outcome.effects.some((e) => e.type === 'save_suggestion' && e.suggestion.kind === 'note') && !outcome.result.merged) result.notes++
    else result.unchanged++
  }
  await settleQuestions(store)
  return result
}

// ── search results → job leads ────────────────────────────────────────────

/** Fit, pay, sponsorship and age in one line under the lead (Leads card tooltip). */
