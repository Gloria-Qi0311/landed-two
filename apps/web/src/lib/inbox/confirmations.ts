// "Thanks for applying" pages the extension saw → applications, once each.
import { canonicalUrl, companyKey, type Stage } from '@landed/observation-processor'
import type { ReportedApplication } from '@landed/schema/reported-application'
import type { DataStore, DbApplication, DbPortalEvent, DbSuggestion } from '../store/types'
import { addLeadToPipeline } from './leads'
import { settleQuestions } from './questions'
import { isForward, matchReported, addReportedApplication } from './reported'

// ── submissions the extension saw ─────────────────────────────────────────
// The extension recognizes a portal's "thanks for applying" page (and the
// "you applied" mark on a posting) and queues an event (apps/extension
// lib/portal-parsers). Local accounts get them through the open Landed tab
// (hooks/extension-bridge.ts), Cloud accounts from the extension directly.
// Each one moves its application to Applied, or adds it (a matching lead
// goes into the pipeline) — with the screenshot rules, or the exact
// application/lead when the tab was opened from Landed with Apply Assist.
// Once per submission: the event is remembered as a `portal-applied:`
// suggestion, so deleting the application doesn't bring it back.

export const PORTAL_APPLIED = 'portal-applied:'
const CONFIRMATION_DAYS = 30

type Confirmation = { company: string; role: string; url: string | null; at: string; application_id: string | null; lead_id: string | null }

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

function confirmationOf(e: DbPortalEvent): Confirmation | null {
  const p = e.payload_json ?? {}
  if (e.type !== 'status-change' || p.to !== 'applied' || (p.raw_kind !== 'applied' && p.raw_kind !== 'already_applied')) return null
  const company = text(p.company, 200)
  const role = text(p.role, 300)
  if (!company || !role) return null
  const url = text(p.app_url, 2000)
  const at = typeof p.applied_at === 'string' && !Number.isNaN(Date.parse(p.applied_at)) ? p.applied_at : e.created_at
  return {
    company, role, url: /^https?:\/\//.test(url) ? url : null, at,
    application_id: text(p.application_id, 64) || e.application_id || null, lead_id: text(p.lead_id, 64) || null,
  }
}

const confirmationKey = (c: Confirmation) => `${PORTAL_APPLIED}${companyKey(c.company)}|${c.role.toLowerCase()}|${canonicalUrl(c.url) ?? ''}`

/** Was this ledger row the extension's "you already had that one"? Not news. */
export const isSeenConfirmation = (s: Pick<DbSuggestion, 'dedupe_key' | 'state'>) => s.dedupe_key.startsWith(PORTAL_APPLIED) && s.state === 'rejected'

/** Turn the submissions the extension saw (last 30 days, not handled yet)
 *  into applications. Returns how many changed something. */
export async function ingestPortalConfirmations(store: DataStore, now = Date.now()): Promise<number> {
  const since = now - CONFIRMATION_DAYS * 86_400_000
  const events = (await store.listPortalEvents(200)).filter((e) => Date.parse(e.created_at) >= since)
  const found = events.map((e) => confirmationOf(e)).filter((c): c is Confirmation => !!c).sort((a, b) => a.at.localeCompare(b.at))
  if (found.length === 0) return 0
  const handled = new Set((await store.listSuggestions()).map((s) => s.dedupe_key))
  let changed = 0
  for (const c of found) {
    const key = confirmationKey(c)
    if (handled.has(key)) continue
    handled.add(key)
    const [apps, companies, leads] = await Promise.all([store.listApplications(), store.listCompanies(), store.listJobLeads()])
    const report: ReportedApplication = { company: c.company, role: c.role, stage: 'applied', applied_on: c.at.slice(0, 10), job_url: c.url, location: null, note: null }
    const opened = apps.find((a) => a.id === c.application_id)
    const lead = leads.find((l) => l.id === c.lead_id && l.status === 'new')
    let before: string | null = null
    let app: DbApplication | null = null
    let already: string | null = opened?.id ?? null
    if (opened) {
      before = opened.stage
      app = isForward(opened.stage, 'applied')
        ? await store.updateApplication(opened.id, { stage: 'applied', applied_at: opened.applied_at ?? c.at, portal_application_url: opened.portal_application_url ?? c.url })
        : null
    } else if (lead) {
      before = 'saved'
      app = await addLeadToPipeline(store, lead, 'applied')
      app = await store.updateApplication(app.id, { applied_at: c.at })
    } else {
      const match = matchReported(report, apps, companies, leads)
      before = match.kind === 'existing' ? match.app.stage : match.kind === 'lead' ? 'saved' : null
      if (match.kind === 'existing') already = match.app.id
      app = match.kind === 'existing' && !match.forward ? null : await addReportedApplication(store, report, 'Portal (extension)')
    }
    let host: string | undefined
    try {
      host = c.url ? new URL(c.url).hostname : undefined
    } catch {
      host = undefined
    }
    const resolved = new Date(now).toISOString()
    await store.saveSuggestion({
      id: crypto.randomUUID(), dedupe_key: key,
      kind: !app ? 'note' : before ? 'stage_change' : 'new_application',
      state: app ? 'auto_applied' : 'rejected',
      application_id: app?.id ?? already, candidate_ids: [], company_name: c.company, role: c.role,
      status: 'applied', proposed_stage: 'applied', previous_stage: app && before ? before as Stage : null, confidence: 1,
      evidence: { source: 'portal', subject: 'Application submitted', received_at: c.at, ...(host ? { sender_domain: host } : {}) },
      observation_ids: [], provider: 'extension', created_at: resolved, resolved_at: resolved,
    } as Parameters<DataStore['saveSuggestion']>[0])
    if (app) changed++
  }
  if (changed) await settleQuestions(store)
  return changed
}

/** Cloud accounts (the browser upgrade fixes local ones, Dexie v9): rounds
 *  numbered backwards by an out-of-order email check, put in time order. */
