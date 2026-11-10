// What Landed tells the user's own agent about them when it judges postings
// for them (Rank, lib/rank.ts): the gist of the master resume (else the
// current one), the saved answers that shape a job search, and the active
// search. Never contact details, address, date of birth or EEO answers.
import type { Resume } from '@landed/schema'
import type { ApplicationAnswers } from '@landed/schema/application-answers'
import type { SearchBrief } from '@landed/schema/search-brief'
import type { DbResume } from './store/types'

/** The context is plain text, at most this long. */
export const MAX_AGENT_CONTEXT = 8_000

const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const span = (start: string, end: string, current = false) => [clip(start, 20), current ? 'present' : clip(end, 20)].filter(Boolean).join(' – ')
const yn = (v: string | null | undefined) => (v === 'yes' ? 'yes' : v === 'no' ? 'no' : null)

/** The resume the agent should know: the master (most complete), else the
 *  current one, else the newest with content. */
export function contextResume(resumes: DbResume[]): { resume: Resume; which: string } | null {
  const pick = resumes.find((r) => r.kind === 'master' && r.parsed_json)
    ?? resumes.find((r) => r.is_current && r.parsed_json)
    ?? [...resumes].filter((r) => r.parsed_json).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (!pick?.parsed_json) return null
  return { resume: pick.parsed_json, which: pick.kind === 'master' ? 'master resume' : `resume "${clip(pick.name, 60)}"` }
}

export function agentContext({ resumes, answers, search }: {
  resumes: DbResume[]
  answers: ApplicationAnswers | null
  search: SearchBrief | null
}): string | null {
  const lines: string[] = []
  const picked = contextResume(resumes)
  if (picked) {
    const r = picked.resume
    lines.push(`From their ${picked.which}:`)
    if (r.basic?.location) lines.push(`- Lives in: ${clip(r.basic.location, 80)}`)
    if (r.summary) lines.push(`- Summary: ${clip(r.summary, 300)}`)
    for (const e of r.education ?? []) {
      const degree = [e.degree, e.major].filter(Boolean).join(', ')
      lines.push(`- Education: ${[degree, clip(e.school, 80)].filter(Boolean).join(' — ')}${span(e.start_date, e.end_date) ? ` (${span(e.start_date, e.end_date)})` : ''}`)
    }
    const jobs = [
      ...(r.experience ?? []).map((e) => ({ ...e, kind: 'Job' })),
      ...(r.internship ?? []).map((e) => ({ ...e, kind: 'Internship' })),
    ].filter((e) => e.title || e.company)
    for (const e of jobs.slice(0, 8)) {
      const firstBullets = String(e.description ?? '').split('\n').map((l) => l.replace(/^\s*[•\-*·]\s*/, '').trim()).filter(Boolean).slice(0, 2)
      lines.push(`- ${e.kind}: ${[clip(e.title, 80), clip(e.company, 80)].filter(Boolean).join(' at ')}${span(e.start_date, e.end_date, e.current) ? ` (${span(e.start_date, e.end_date, e.current)})` : ''}${firstBullets.length ? `: ${firstBullets.map((b) => clip(b, 160)).join('; ')}` : ''}`)
    }
    const projects = (r.projects ?? []).map((p) => clip(p.name, 60)).filter(Boolean).slice(0, 6)
    if (projects.length) lines.push(`- Projects: ${projects.join(', ')}`)
    if (r.skills?.length) lines.push(`- Skills: ${r.skills.slice(0, 30).map((s) => clip(s, 40)).join(', ')}`)
    if (r.languages?.length) lines.push(`- Languages: ${r.languages.slice(0, 8).map((s) => clip(s, 30)).join(', ')}`)
  }
  if (answers) {
    const said = [
      yn(answers.work_authorized) && `authorized to work in the US: ${yn(answers.work_authorized)}`,
      yn(answers.needs_sponsorship) && `needs visa sponsorship now or later: ${yn(answers.needs_sponsorship)}`,
      answers.preferred_locations.length > 0 && `preferred places: ${answers.preferred_locations.map((l) => clip(l, 60)).join('; ')}`,
      yn(answers.open_to_other_locations) && `open to other places: ${yn(answers.open_to_other_locations)}`,
      yn(answers.relocate) && `willing to relocate: ${yn(answers.relocate)}`,
      yn(answers.onsite) && `fine with onsite every day: ${yn(answers.onsite)}`,
      answers.earliest_start && `earliest start: ${clip(answers.earliest_start, 40)}`,
    ].filter(Boolean)
    if (said.length) lines.push('', 'From the answers they saved in Landed:', ...said.map((s) => `- ${s}`))
  }
  if (search) {
    lines.push('', 'Their current job search (they can change it):',
      `- ${clip(search.summary, 200)}`,
      `- Roles: ${search.roles.join('; ')}${search.seniority ? ` · level: ${search.seniority}` : ''}${search.locations.length ? ` · places: ${search.locations.join('; ')}` : ''}`)
  }
  const text = lines.join('\n').trim()
  return text ? text.slice(0, MAX_AGENT_CONTEXT) : null
}
