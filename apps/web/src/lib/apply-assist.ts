// "Open & autofill" on a lead or a saved application: the extension opens
// the posting and fills the form with the resume Landed picks here, and the
// "thanks for applying" page lands on this application (extension:
// background.js → openAndFill; Landed: lib/inbox.ts →
// ingestPortalConfirmations). The extension never submits.
import { canonicalUrl, companyKey, titleSimilarity } from '@landed/observation-processor'
import type { DbResume } from './store/types'

export type AssistTarget = {
  application_id: string | null
  lead_id: string | null
  company: string
  role: string
  url: string
}

export type ResumePick = { resume: DbResume; why: 'tailored' | 'similar' | 'master' | 'current' }

const SIMILAR_ROLE = 0.6

/** The resume to fill with: the version tailored for this application (or
 *  this posting, or a close role at the same company), else the master,
 *  else the current one. Only resumes the extension can fill from. */
export function pickResumeFor(target: Omit<AssistTarget, 'lead_id'>, resumes: DbResume[]): ResumePick | null {
  const usable = resumes.filter((r) => r.parsed_json)
  const versions = usable.filter((r) => r.kind === 'version').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const url = canonicalUrl(target.url)
  const company = companyKey(target.company)
  const exact = versions.find((r) => (target.application_id && r.target_json?.application_id === target.application_id)
    || (url && canonicalUrl(r.target_json?.job_url) === url))
  if (exact) return { resume: exact, why: 'tailored' }
  const similar = versions.find((r) => r.target_json && company && companyKey(r.target_json.company ?? '') === company
    && titleSimilarity(r.target_json.role, target.role) >= SIMILAR_ROLE)
  if (similar) return { resume: similar, why: 'similar' }
  const master = usable.find((r) => r.kind === 'master')
  if (master) return { resume: master, why: 'master' }
  const current = usable.find((r) => r.is_current) ?? usable[0]
  return current ? { resume: current, why: 'current' } : null
}

export const PICK_TEXT: Record<ResumePick['why'], string> = {
  tailored: 'tailored for this role',
  similar: 'tailored for a similar role here',
  master: 'your master resume',
  current: 'your current resume',
}
