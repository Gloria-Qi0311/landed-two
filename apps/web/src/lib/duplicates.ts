// Duplicate applications: the same application entered twice — by an email
// and a screenshot, two portals, a typo'd company. Landed finds them with
// the processor's matching (same employer by company key — 蚂蚁集团 = 蚂蚁 —
// and the same posting link or a nearly identical title, brackets included,
// so 产品管培生（上海） and （广东省） stay two). It never merges on its own:
// "Needs your input" asks, group by group (components/duplicates.tsx). "Not
// duplicates" is remembered as a resolved suggestion with a Landed-made key
// (`dup:<ids>`), like the other panel questions.
import { atsJobKey, canonicalUrl, companyKey, titleSimilarity } from '@landed/observation-processor'
import type { ApplicationPatch, DataStore, DbApplication, DbSuggestion } from './store/types'

type AppLike = { id: string; company_id: string; role: string; portal_application_url: string | null }
type CompanyLike = { id: string; name: string }

const SAME_ROLE = 0.8
export const DUP = 'dup:'
export const dupKey = (ids: string[]) => DUP + [...ids].sort().join('+')
export const isDupQuestion = (s: Pick<DbSuggestion, 'dedupe_key'>) => s.dedupe_key.startsWith(DUP)

export function samePosting(a: AppLike, b: AppLike): boolean {
  const ats = atsJobKey(a.portal_application_url)
  const other = atsJobKey(b.portal_application_url)
  // Two postings on job boards are one application only if they're the same
  // posting: "Software Engineer, New Grad" and "…, Platform (New Grad)" at
  // one company are two (approving both from Leads isn't a duplicate).
  if (ats && other) return ats === other
  const url = canonicalUrl(a.portal_application_url)
  if (url && url === canonicalUrl(b.portal_application_url)) return true
  return titleSimilarity(a.role, b.role, { keepBrackets: true }) >= SAME_ROLE
}

/** Groups of application ids that look like one application (2+ each),
 *  minus the ones the user said aren't duplicates. */
export function duplicateGroups(apps: AppLike[], companies: CompanyLike[], dismissed: Set<string> = new Set()): string[][] {
  const keyOf = new Map(companies.map((c) => [c.id, companyKey(c.name)]))
  const byCompany = new Map<string, AppLike[]>()
  for (const a of apps) {
    const key = keyOf.get(a.company_id)
    if (!key || !a.role) continue
    byCompany.set(key, [...(byCompany.get(key) ?? []), a])
  }
  const groups: string[][] = []
  for (const list of byCompany.values()) {
    if (list.length < 2) continue
    // Union-find over "looks like the same application".
    const parent = new Map(list.map((a) => [a.id, a.id]))
    const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (samePosting(list[i], list[j])) parent.set(root(list[j].id), root(list[i].id))
      }
    }
    const sets = new Map<string, string[]>()
    for (const a of list) sets.set(root(a.id), [...(sets.get(root(a.id)) ?? []), a.id])
    for (const ids of sets.values()) if (ids.length > 1 && !dismissed.has(dupKey(ids))) groups.push(ids)
  }
  return groups
}

/** Every id in a duplicate group, for the "Possible duplicate" badge. */
export function findDuplicateAppIds(apps: { id: string; companyId: string; role: string; portal_application_url?: string | null }[], companies: CompanyLike[]): Set<string> {
  const refs = apps.map((a) => ({ id: a.id, company_id: a.companyId, role: a.role, portal_application_url: a.portal_application_url ?? null }))
  return new Set(duplicateGroups(refs, companies).flat())
}

// Closed is where things end: a rejection or a ghosting is newer news than
// an interview, so the furthest stage is the one to keep by default.
const RANK: Record<string, number> = { saved: 0, applied: 1, oa: 2, interview: 3, offer: 4, ghosted: 5, rejected: 6 }

/** The one to keep: furthest along, then the most recently touched. */
export function pickPrimary<T extends Pick<DbApplication, 'stage' | 'last_activity_at'>>(apps: T[]): T {
  return [...apps].sort((a, b) => (RANK[b.stage] ?? 0) - (RANK[a.stage] ?? 0) || b.last_activity_at.localeCompare(a.last_activity_at))[0]
}

/** What the kept one takes from the others: blanks filled, notes and
 *  interview rounds combined, the earliest applied date. */
export function mergedPatch(keep: DbApplication, others: DbApplication[]): ApplicationPatch {
  const all = [keep, ...others]
  const first = <K extends keyof DbApplication>(k: K) => all.map((a) => a[k]).find((v) => v !== null && v !== undefined && v !== '') ?? null
  const notes = [...new Set(all.map((a) => a.notes?.trim()).filter((n): n is string => !!n))]
  const applied = all.map((a) => a.applied_at).filter((d): d is string => !!d).sort()[0] ?? null
  const rounds = new Map<string, DbApplication['interviews'][number]>()
  for (const r of all.flatMap((a) => a.interviews ?? [])) rounds.set(`${r.round}|${r.at ?? ''}|${r.format ?? ''}`, r)
  return {
    team: first('team') as string | null, salary: first('salary') as string | null, location: first('location') as string | null,
    remote: first('remote') as string | null, next_step: first('next_step') as string | null, source: first('source') as string | null,
    portal_application_url: first('portal_application_url') as string | null, deadline: first('deadline') as string | null,
    applied_at: applied, notes: notes.length ? notes.join('\n\n') : null,
    referral: all.some((a) => a.referral), starred: all.some((a) => a.starred),
    interviews: [...rounds.values()].sort((a, b) => (a.round ?? 99) - (b.round ?? 99)),
  }
}

/** Merge into `keepId`: fill it in from the others, point their leads and
 *  history at it, then delete them. */
export async function mergeApplications(store: DataStore, keepId: string, removeIds: string[]): Promise<DbApplication> {
  const apps = await store.listApplications()
  const keep = apps.find((a) => a.id === keepId)
  const others = apps.filter((a) => removeIds.includes(a.id) && a.id !== keepId)
  if (!keep || others.length === 0) throw new Error('Those applications are gone already.')
  const merged = await store.updateApplication(keep.id, mergedPatch(keep, others))
  const gone = new Set(others.map((a) => a.id))
  for (const l of (await store.listJobLeads()).filter((x) => x.application_id && gone.has(x.application_id))) {
    await store.updateJobLead(l.id, { application_id: keep.id })
  }
  // Resolved updates (and their undo) move over; open questions about the
  // removed ones go with them (deleteApplication).
  for (const s of (await store.listSuggestions()).filter((x) => x.application_id && gone.has(x.application_id) && x.state !== 'pending')) {
    await store.updateSuggestion(s.id, { application_id: keep.id })
  }
  for (const id of gone) await store.deleteApplication(id)
  return merged
}

/** "Not duplicates": don't ask about this group again. */
export async function dismissDuplicates(store: DataStore, ids: string[], companyName: string): Promise<void> {
  const now = new Date().toISOString()
  await store.saveSuggestion({
    id: crypto.randomUUID(), dedupe_key: dupKey(ids), kind: 'ambiguous', state: 'rejected', application_id: null,
    candidate_ids: [...ids].sort(), company_name: companyName, role: null, status: 'other', proposed_stage: null, previous_stage: null,
    confidence: null, evidence: { source: 'landed' }, observation_ids: [], provider: 'landed', created_at: now, resolved_at: now,
  } as Parameters<DataStore['saveSuggestion']>[0])
}
