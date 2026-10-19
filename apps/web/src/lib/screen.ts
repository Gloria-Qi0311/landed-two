// Hard filters on the Leads column (#92; docs/leads-model.md). Each lead
// still a candidate is screened with packages/supply's rules against the
// master resume and the saved answers — in the browser, since it reads
// both — and gets screen {pass, reasons}. Screened-out leads are hidden,
// never deleted; one the user puts back stays back.
import type { Resume } from '@landed/schema'
import { isPutBack, PUT_BACK, screenPosting } from '@landed/supply'
import type { DataStore, DbJobLead, DbResume } from './store/types'

/** The resume the filters read: the master (most complete), else the
 *  current one, else the newest upload. */
export function screeningResume(resumes: DbResume[]): Resume | null {
  const pick = resumes.find((r) => r.kind === 'master' && r.parsed_json)
    ?? resumes.find((r) => r.is_current && r.parsed_json)
    ?? resumes.find((r) => r.parsed_json)
  return pick?.parsed_json ?? null
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Screen every lead that's still a candidate (new, open, not put back);
 *  writes only what changed. Returns how many changed. */
export async function screenLeads(store: DataStore): Promise<number> {
  const [leads, resumes, saved] = await Promise.all([store.listJobLeads(), store.listResumes(), store.getApplicationAnswers()])
  const resume = screeningResume(resumes)
  const answers = saved?.answers ?? null
  let changed = 0
  for (const lead of leads) {
    if (lead.status !== 'new' || lead.closed_at || isPutBack(lead.screen)) continue
    const screen = screenPosting({ text: [lead.title, lead.location, lead.description].filter(Boolean).join('\n'), location: lead.location, resume, answers })
    if (same(screen, lead.screen)) continue
    await store.updateJobLead(lead.id, { screen })
    changed++
  }
  return changed
}

/** The user disagrees with the filters: back in Leads, and left alone. */
export function putBack(store: DataStore, lead: Pick<DbJobLead, 'id'>) {
  return store.updateJobLead(lead.id, { screen: { pass: true, reasons: [PUT_BACK] } })
}

export const screenedOut = (lead: Pick<DbJobLead, 'screen'>) => lead.screen?.pass === false
