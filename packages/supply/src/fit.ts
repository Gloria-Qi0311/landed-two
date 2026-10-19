// Fit score (#93): how well a posting matches what the person is looking
// for and what their resume shows, 0–1, with the reasons a person would
// give. Deterministic: the same posting, search and resume always score
// the same. Letting the user's own agent score is a later step.
//
//   title       the posting's title against the search's roles    weight 0.35
//               (a role named outright, closer is better: "Software
//               Engineer" over "Software Engineer, Fraud & Identity")
//   skills      the resume's skills the posting mentions          weight 0.3
//   level       the title's level against the search's            weight 0.15
//   place       one of the search's places (or remote)            weight 0.1
//   experience  years the posting asks for against the resume's   weight 0.1
//
// Leads already come through a role and place filter, so title and place
// alone can't tell them apart: the closeness of the title, the level and
// (with a resume) skills and experience do.
//
// A part without input (no description, no skills, no places in the
// search, no years asked) is left out and the rest are weighed alone.
// Runs in the browser: it reads the resume.
import { titleSimilarity } from '@landed/observation-processor'
import type { Resume } from '@landed/schema'
import type { LeadFit } from '@landed/schema/lead-queue'
import type { SearchBrief } from '@landed/schema/search-brief'
import { levelMatches, placeMatches, roleMatches, tooSenior } from './simplify'

export type FitInput = {
  title: string
  location: string | null
  /** what the posting says (full text when we have it) */
  description: string | null
  brief: SearchBrief | null
  resume: Resume | null
}

// strength: how telling a reason is, which orders them (a card shows the
// first). A title or place that matches is expected (leads came through
// those filters), so it says least; a mismatch or a skills match says more.
type Part = { weight: number; score: number; reason: string; strength: number }

const round = (n: number) => Math.round(n * 100) / 100

// Level and filler words don't make a title less of a match.
const TITLE_NOISE = /\b(?:new grad(?:uate)?|graduate|entry level|early career|junior|intern(?:ship)?|i{1,3}|[1-3]|summer|20\d\d)\b/gi
const core = (title: string) => title.replace(TITLE_NOISE, ' ')

function titlePart(title: string, roles: string[]): Part | null {
  if (roles.length === 0) return null
  if (roleMatches(roles, title)) {
    const role = roles.find((r) => roleMatches([r], title))!
    // Named outright: 0.75, up to 1 the closer the rest of the title is.
    const close = Math.max(...roles.filter((r) => roleMatches([r], title)).map((r) => titleSimilarity(core(r), core(title))))
    return { weight: 0.35, score: round(0.75 + 0.25 * close), reason: `Title matches "${role}"`, strength: 0.5 }
  }
  const best = Math.max(...roles.map((r) => titleSimilarity(r, title)))
  if (best >= 0.4) return { weight: 0.35, score: best, reason: `Title is close to what you're looking for`, strength: 1 }
  return { weight: 0.35, score: best, reason: `Title isn't one of the roles you're looking for`, strength: 2 }
}

function levelPart(brief: SearchBrief, title: string): Part | null {
  const level = brief.seniority?.trim()
  if (!level) return null
  if (tooSenior(brief, title)) return { weight: 0.15, score: 0, reason: `Looks senior for a ${level} search`, strength: 4 }
  if (!levelMatches(brief, title)) return { weight: 0.15, score: 0.3, reason: `Level may not be ${level}`, strength: 2 }
  return { weight: 0.15, score: 1, reason: `Level fits ${level}`, strength: 0 }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Skills that are also everyday English ("go deep", "excel at", "a swift
// response", "spark curiosity"): only a capitalized mention is the skill.
const ENGLISH_WORDS = new Set(['go', 'swift', 'spark', 'excel', 'rust', 'ruby', 'dart', 'express', 'flask', 'next', 'chef', 'puppet', 'salt', 'shell', 'access', 'word', 'julia', 'elixir'])

/** The resume's skills the text mentions, as written on the resume. A
 *  mention is the whole name, not glued to a hyphen ("go-to-market",
 *  "C-level", "Objective-C" aren't Go or C); a one- or two-letter skill isn't
 *  "R&D" or "A&C"; a skill that's also an English word counts only
 *  capitalized ("go deep" isn't Go); and a capitalized skill isn't its
 *  all-caps namesake (SWIFT, the payments network, isn't Swift). */
export function skillsMentioned(skills: string[], text: string): string[] {
  const out: string[] = []
  for (const raw of skills) {
    const skill = raw.trim()
    if (skill.length < 1 || skill.length > 40 || out.some((o) => o.toLowerCase() === skill.toLowerCase())) continue
    const short = skill.length <= 2
    const capsDiffers = skill.length > 3 && skill !== skill.toUpperCase()
    const english = ENGLISH_WORDS.has(skill.toLowerCase())
    const re = new RegExp(escape(skill), 'gi')
    for (const m of text.matchAll(re)) {
      const before = text[m.index - 1] ?? ' '
      const after = text[m.index + m[0].length] ?? ' '
      if (/[a-z0-9+#.\-]/i.test(before) && /^[a-z0-9]/i.test(skill)) continue
      if (/[a-z0-9+#\-]/i.test(after) && /[a-z0-9+#]$/i.test(skill)) continue
      if (short && (after === '&' || before === '&')) continue
      if (english && m[0][0] !== m[0][0].toUpperCase()) continue
      if (capsDiffers && m[0] === m[0].toUpperCase()) continue
      out.push(skill)
      break
    }
  }
  return out
}

function skillsPart(resume: Resume | null, description: string | null): Part | null {
  const skills = (resume?.skills ?? []).flatMap((s) => s.split(/\s*[,;、，]\s*/)).filter(Boolean)
  if (skills.length === 0 || !description || description.length < 200) return null
  const found = skillsMentioned(skills, description)
  // Six of your skills is a strong match; a posting rarely names more.
  const score = Math.min(1, found.length / Math.min(6, skills.length))
  const list = found.slice(0, 4).join(', ')
  const reason = found.length === 0
    ? "Mentions none of your resume's skills"
    : `Mentions ${found.length === 1 ? 'one of your skills' : `${found.length} of your skills`}: ${list}${found.length > 4 ? '…' : ''}`
  return { weight: 0.3, score, reason, strength: found.length >= 3 ? 3 : found.length === 0 ? 2 : 1 }
}

function placePart(brief: SearchBrief, location: string | null): Part | null {
  if (brief.locations.length === 0 && brief.remote !== 'remote') return null
  const places = (location ?? '').split(/\s*;\s*/).filter(Boolean)
  if (places.length === 0) return null
  // Name the place that matched, not just the first one listed.
  const match = places.find((p) => placeMatches(brief, [p]))
  return match
    ? { weight: 0.1, score: 1, reason: `In ${match}${places.length > 1 ? ` (+${places.length - 1})` : ''}`, strength: 0.5 }
    : { weight: 0.1, score: 0, reason: 'Not in the places you want', strength: 2 }
}

/** The fewest years of experience a posting asks for, or null. */
export function yearsAsked(text: string): number | null {
  const t = text.toLowerCase()
  const asked: number[] = []
  // "5+ years of experience", "5–8 years of full sales cycle or account
  // management experience": up to six words between, in the same sentence.
  // Also "four (4) years", "7 or more years", "8 years+ experience".
  for (const m of t.matchAll(/\b(\d{1,2})\)?\s*(?:\+|plus|or more|or above)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\+?(?:'|’)?\s+(?:of\s+)?(?:[^\s.;•]+\s+){0,6}?(?:experience|exp\b)/g)) {
    const n = +m[1]
    if (n >= 0 && n <= 25) asked.push(n)
  }
  // "Extensive security experience (3+ years)"
  for (const m of t.matchAll(/experience\s*\((\d{1,2})\s*\+?\s*(?:years?|yrs?)\)/g)) asked.push(+m[1])
  for (const m of t.matchAll(/(\d{1,2})\s*年(?:以上)?(?:相关)?(?:工作)?经验/g)) asked.push(+m[1])
  return asked.length ? Math.min(...asked) : null
}

/** Years of full-time work on the resume (internships don't count). */
export function yearsOnResume(resume: Resume | null, now: Date): number {
  let months = 0
  for (const e of resume?.experience ?? []) {
    const start = String(e.start_date ?? '').match(/(\d{4})(?:[-/.](\d{1,2}))?/)
    if (!start) continue
    const end = String(e.end_date ?? '').match(/(\d{4})(?:[-/.](\d{1,2}))?/)
    const from = +start[1] * 12 + (start[2] ? +start[2] - 1 : 0)
    const to = end ? +end[1] * 12 + (end[2] ? +end[2] - 1 : 11) : now.getFullYear() * 12 + now.getMonth()
    if (to > from) months += to - from
  }
  return Math.round((months / 12) * 10) / 10
}

function experiencePart(resume: Resume | null, description: string | null, now: Date): Part | null {
  if (!resume || !description) return null
  const asked = yearsAsked(description)
  if (asked === null || asked === 0) return null
  const have = yearsOnResume(resume, now)
  if (have + 1 >= asked) return { weight: 0.1, score: 1, reason: `Asks for ${asked}+ years; you have about ${have}`, strength: 1 }
  return { weight: 0.1, score: round(have / asked), reason: `Asks for ${asked}+ years; you have about ${have}`, strength: 3 }
}

/** The fit of a posting for this search and resume, or null when there's
 *  nothing to score with (no search). Two or three reasons, the telling
 *  ones first. */
export function scoreFit({ title, location, description, brief, resume }: FitInput, now: Date = new Date()): LeadFit | null {
  if (!brief) return null
  const parts = [
    titlePart(title, brief.roles),
    // Only a title that is the role has a level worth weighing.
    roleMatches(brief.roles, title) ? levelPart(brief, title) : null,
    skillsPart(resume, description),
    placePart(brief, location),
    experiencePart(resume, description, now),
  ].filter((p): p is Part => p !== null)
  if (parts.length === 0) return null
  const weight = parts.reduce((s, p) => s + p.weight, 0)
  const score = round(parts.reduce((s, p) => s + p.weight * p.score, 0) / weight)
  const reasons = [...parts].sort((a, b) => b.strength - a.strength || b.weight - a.weight).slice(0, 3).map((p) => p.reason)
  return { score, reasons }
}
