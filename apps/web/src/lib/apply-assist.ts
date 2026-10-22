// "Open & autofill" on a lead or a saved application: the extension opens
// the posting and fills the form with the resume Landed picks here, and the
// "thanks for applying" page lands on this application (extension:
// background.js → openAndFill; Landed: lib/inbox/confirmations.ts →
// ingestPortalConfirmations). The extension never submits.
import { canonicalUrl, companyKey, titleSimilarity } from '@landed/observation-processor'
import type { DbResume } from './store/types'
import type { ResumeChoice } from '@landed/schema/master-resume'

export type AssistTarget = {
  application_id: string | null
  lead_id: string | null
  company: string
  role: string
  url: string
}

export type ResumePick = {
  resume: DbResume
  why: 'tailored' | 'similar' | 'direction' | 'fits' | 'only' | 'no_file' | 'master' | 'current'
  /** low or close fit, or no resume of the job's direction */
  unsure?: boolean
  /** several resumes of the job's direction: decided by what the posting asks */
  composite?: boolean
  /** why, in a sentence, for the application's record */
  reason?: string
}

const SIMILAR_ROLE = 0.6

// ── how well a resume's direction fits a job ─────────────────────────────
// The same rule, words and weights as the extension's lib/resume-pick.js, so
// "Open & autofill" and a fill started on the page pick the same resume.

const EXPAND: Record<string, string[]> = {
  pm: ['product', 'manager'], apm: ['associate', 'product', 'manager'], tpm: ['technical', 'program', 'manager'],
  swe: ['software', 'engineer'], sde: ['software', 'engineer'], eng: ['engineer'], dev: ['developer'],
  ds: ['data', 'scientist'], da: ['data', 'analyst'], ba: ['business', 'analyst'], ml: ['machine', 'learning'],
  mle: ['machine', 'learning', 'engineer'], ai: ['ai'], ux: ['ux'], ui: ['ui'], fe: ['frontend'], be: ['backend'],
  qa: ['quality'], ops: ['operations'], mgr: ['manager'], sr: ['senior'], jr: ['junior'],
}
const LEMMA: Record<string, string> = {
  management: 'manager', manage: 'manager', managing: 'manager', engineering: 'engineer', analytics: 'analyst',
  analysis: 'analyst', science: 'scientist', design: 'designer', development: 'developer', marketing: 'marketer',
  research: 'researcher', consulting: 'consultant', internship: 'intern', interns: 'intern', operation: 'operations',
}
const NAME_NOISE = new Set(['resume', 'cv', 'final', 'new', 'updated', 'latest', 'copy', 'version', 'draft', 'pdf', 'docx', 'and', 'the', 'for', 'of'])
const CJK = /[\u3400-\u9fff]/

function titleWords(text: unknown): string[] {
  const out: string[] = []
  for (const raw of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue
    if (CJK.test(raw)) {
      const chars = [...raw].filter((c) => CJK.test(c))
      if (chars.length === 1) out.push(chars[0])
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
    } else if (EXPAND[raw]) out.push(...EXPAND[raw])
    else if (raw.length > 1 && !/^\d+$/.test(raw)) out.push(LEMMA[raw] ?? raw)
  }
  return out
}

type Parsed = {
  basic?: { name?: string; firstName?: string; lastName?: string; englishName?: string }
  intent?: { apply_position?: string }
  experience?: { title?: string; position?: string; role?: string; start_date?: string; startDate?: string }[]
  internship?: { title?: string; position?: string; role?: string; start_date?: string; startDate?: string }[]
  skills?: string[]
}

/** What a resume is for: a version's target role; an upload's intended
 *  position, its name (minus the person's name and "resume"), its two
 *  latest job titles. */
export function directions(r: DbResume): string[] {
  if (r.kind === 'version' && r.target_json?.role) return [r.target_json.role]
  // What the user (or Landed, at upload) said it's for.
  if (Array.isArray(r.directions) && r.directions.length) return r.directions
  const p = (r.parsed_json ?? {}) as Parsed
  const b = p.basic ?? {}
  const person = new Set(titleWords(`${b.name ?? ''} ${b.firstName ?? ''} ${b.lastName ?? ''} ${b.englishName ?? ''}`))
  const fromName = titleWords(r.name).filter((w) => !person.has(w) && !NAME_NOISE.has(w) && !/^v\d+$/.test(w)).join(' ')
  const jobs = [...(Array.isArray(p.experience) ? p.experience : []), ...(Array.isArray(p.internship) ? p.internship : [])]
    .filter((e) => e && (e.title || e.position || e.role))
    .sort((x, y) => String(y.start_date ?? y.startDate ?? '').localeCompare(String(x.start_date ?? x.startDate ?? '')))
    .slice(0, 2)
    .map((e) => e.title || e.position || e.role || '')
  return [p.intent?.apply_position, fromName, ...jobs].filter((d): d is string => !!d && !!String(d).trim())
}

function roleFit(r: DbResume, jobTitle: string): number {
  const job = new Set(titleWords(jobTitle))
  if (job.size === 0) return 0
  let best = 0
  for (const d of directions(r)) {
    const words = [...new Set(titleWords(d))]
    if (words.length) best = Math.max(best, words.filter((w) => job.has(w)).length / words.length)
  }
  return best
}

function skillFit(r: DbResume, text: string): number {
  const body = ` ${text.toLowerCase()} `
  const skills = (Array.isArray((r.parsed_json as Parsed | null)?.skills) ? (r.parsed_json as Parsed).skills! : [])
    .map((s) => String(s ?? '').toLowerCase().trim()).filter((s) => s.length > 1).slice(0, 40)
  if (!body.trim() || skills.length === 0) return 0
  const hits = skills.filter((s) => new RegExp(`(^|[^\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(body)).length
  return Math.min(1, hits / Math.min(10, skills.length))
}

/** A direction is a job's when at least half its words are in the title. */
const DIRECTION_MATCH = 0.5
/** The resume's skills the posting mentions (for the reason). */
function skillsMentioned(r: DbResume, text: string): string[] {
  const body = ` ${text.toLowerCase()} `
  const skills = (Array.isArray((r.parsed_json as Parsed | null)?.skills) ? (r.parsed_json as Parsed).skills! : [])
    .map((x) => String(x ?? '').trim()).filter((x) => x.length > 1).slice(0, 40)
  return skills.filter((x) => new RegExp(`(^|[^\\p{L}\\p{N}])${x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(body)).slice(0, 4)
}

/** The direction of `r` that is this job's (its words in the title), if any. */
function matchedDirection(r: DbResume, jobTitle: string): string | null {
  const job = new Set(titleWords(jobTitle))
  return directions(r).find((d) => {
    const words = [...new Set(titleWords(d))]
    return words.length > 0 && words.filter((w) => job.has(w)).length / words.length >= DIRECTION_MATCH
  }) ?? null
}

const UNSURE_BELOW = 0.3
const UNSURE_MARGIN = 0.1

/** The resume to fill with: the version tailored for this application (or
 *  this posting, or a close role at the same company); else, of the resumes
 *  with a file to upload (`hasFile`: an upload's own file; versions make
 *  their PDF), the one whose direction fits the job best (`unsure` when low
 *  or close); none with a file: the master, else the current one. Only
 *  resumes the extension can fill from. `description`: the posting's text,
 *  when known. */
export function pickResumeFor(
  target: Omit<AssistTarget, 'lead_id'> & { description?: string | null },
  resumes: DbResume[],
  hasFile?: (id: string) => boolean,
): ResumePick | null {
  const usable = resumes.filter((r) => r.parsed_json)
  const versions = usable.filter((r) => r.kind === 'version').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const url = canonicalUrl(target.url)
  const company = companyKey(target.company)
  const exact = versions.find((r) => (target.application_id && r.target_json?.application_id === target.application_id)
    || (url && canonicalUrl(r.target_json?.job_url) === url))
  if (exact) return { resume: exact, why: 'tailored', reason: 'tailored for this job' }
  const similar = versions.find((r) => r.target_json && company && companyKey(r.target_json.company ?? '') === company
    && titleSimilarity(r.target_json.role, target.role) >= SIMILAR_ROLE)
  if (similar) return { resume: similar, why: 'similar', reason: `tailored for a similar role at ${target.company}` }
  if (hasFile) {
    const withFile = usable.filter((r) => r.kind !== 'master' && (r.kind === 'version' || hasFile(r.id)))
    if (withFile.length === 1) return { resume: withFile[0], why: 'only', reason: 'your only resume with a file to upload' }
    if (withFile.length > 1) {
      // 1. The resumes whose direction is this job's: one → that one.
      const ofDirection = withFile.filter((r) => roleFit(r, target.role) >= DIRECTION_MATCH)
      if (ofDirection.length === 1) {
        const d = matchedDirection(ofDirection[0], target.role)
        return { resume: ofDirection[0], why: 'direction', reason: `the resume for ${d ?? 'this kind of'} roles` }
      }
      // 2. Several (a role between two directions) or none: what the posting
      //    asks for decides among them; none matched is unsure.
      const text = target.description ?? ''
      const pool = ofDirection.length ? ofDirection : withFile
      const ranked = pool
        .map((r) => ({ r, s: 0.75 * roleFit(r, target.role) + 0.25 * skillFit(r, text) }))
        .sort((a, b) => b.s - a.s || Number(b.r.is_current) - Number(a.r.is_current) || b.r.created_at.localeCompare(a.r.created_at))
      const [top, next] = ranked
      const asked = skillsMentioned(top.r, text)
      const reason = ofDirection.length > 1
        ? `a ${target.role} role fits ${[top.r, ...ofDirection.filter((r) => r !== top.r)].slice(0, 2).map((r) => `“${r.name}”`).join(' and ')}${asked.length ? `; the posting asks for ${asked.join(', ')}` : ''}`
        : `no resume is for ${target.role} roles; the closest one${asked.length ? ` (the posting asks for ${asked.join(', ')})` : ''}`
      return {
        resume: top.r, why: 'fits', composite: ofDirection.length > 1, reason,
        unsure: ofDirection.length === 0 || top.s < UNSURE_BELOW || top.s - next.s < UNSURE_MARGIN,
      }
    }
  }
  const master = usable.find((r) => r.kind === 'master')
  if (master) return { resume: master, why: hasFile ? 'no_file' : 'master', ...(hasFile ? { unsure: true } : {}) }
  const current = usable.find((r) => r.is_current) ?? usable[0]
  return current ? { resume: current, why: hasFile ? 'no_file' : 'current', ...(hasFile ? { unsure: true } : {}) } : null
}

export const PICK_TEXT: Record<ResumePick['why'], string> = {
  tailored: 'tailored for this role',
  similar: 'tailored for a similar role here',
  direction: 'the resume for this kind of role',
  fits: 'the best fit for this role',
  only: 'the one with a file to upload',
  no_file: 'none of your resumes has a file to upload yet',
  master: 'your master resume',
  current: 'your current resume',
}

/** What an application records about its resume: which one, and why. */
export function resumeChoiceFor(pick: ResumePick, now = new Date()): ResumeChoice {
  return { resume_id: pick.resume.id, name: pick.resume.name, reason: pick.reason ?? PICK_TEXT[pick.why], at: now.toISOString() }
}
