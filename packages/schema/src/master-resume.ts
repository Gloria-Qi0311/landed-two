// My Resume: the master resume and tailored versions.
//
//   resume files ──parse──▶ uploaded resumes (sources) ──merge──▶ master resume ──tailor──▶ versions
//
// The master is the most complete record of the user's career, merged from
// every resume they uploaded. Each experience is broken into bullets, and each
// bullet keeps every way it was ever phrased (`variants`, with the uploads it
// came from). That gives tailoring something to choose from: the best-
// matching experiences and the best-matching phrasing. Versions are ordinary
// resumes (the canonical Resume shape in ./index.ts, which the extension auto-
// fills from) aimed at a role.
//
// Parsing, merging and tailoring run on the user's own agent (apps/daemon,
// task kinds `resume_parse` / `resume_merge` / `resume_tailor`). Plain TS, no dependencies: the
// server validates task input and output with these.

export type Variant = {
  text: string
  /** ids of the uploaded resumes this phrasing appears in */
  from: string[]
}

export type Bullet = {
  id: string
  variants: Variant[]
  /** index into variants: the phrasing used by default */
  preferred: number
  skills: string[]
}

export type EntryKind = 'experience' | 'internship' | 'project'

export type MasterEntry = {
  id: string
  kind: EntryKind
  /** company, or the project's name */
  org: string
  /** job title, or your role on the project */
  title: string
  location: string
  start_date: string
  end_date: string
  current: boolean
  link: string
  bullets: Bullet[]
  from: string[]
}

export type MasterEducation = {
  school: string; degree: string; major: string; gpa: string
  start_date: string; end_date: string; location: string; description: string
}

export type MasterResume = {
  version: 1
  basic: Record<string, string>
  summaries: Variant[]
  education: MasterEducation[]
  entries: MasterEntry[]
  skills: string[]
  languages: string[]
  /** the uploads it was built from */
  sources: { id: string; name: string }[]
  built_at: string
}

/** What a version is aimed at. */
export type ResumeTarget = {
  role: string
  company: string | null
  job_url: string | null
  /** pasted job description (trimmed) */
  jd_text: string | null
  application_id: string | null
}

/** What tailoring returns besides the resume: what it picked and why. */
export type TailorNotes = { summary: string; picks: { what: string; why: string }[] }

const BASIC_KEYS = ['name', 'firstName', 'lastName', 'englishName', 'chineseName', 'email', 'phone', 'wechat', 'location', 'linkedin', 'github', 'portfolio']
const KINDS: EntryKind[] = ['experience', 'internship', 'project']
const LIMITS = { entries: 60, bullets: 30, variants: 6, text: 1200, list: 80 }

function str(v: unknown, max = 300): string {
  if (typeof v === 'number') return String(v).slice(0, max)
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function strings(v: unknown, max = LIMITS.list, len = 120): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const t = str(x, len)
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
    if (out.length >= max) break
  }
  return out
}

function variants(v: unknown): Variant[] {
  if (!Array.isArray(v)) return []
  const out: Variant[] = []
  for (const x of v) {
    const r = typeof x === 'string' ? { text: x } : (x as Record<string, unknown>)
    const text = str(r?.text, LIMITS.text)
    if (!text || out.some((o) => o.text === text)) continue
    out.push({ text, from: strings(r?.from, 20, 64) })
    if (out.length >= LIMITS.variants) break
  }
  return out
}

/** Validate and bound a master resume from an untrusted source (the agent's
 *  output, a request body, storage). Missing ids are assigned. Null unless
 *  it has at least one entry or education. */
export function parseMasterResume(raw: unknown): MasterResume | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const basicIn = (r.basic && typeof r.basic === 'object' ? r.basic : {}) as Record<string, unknown>
  const basic: Record<string, string> = {}
  for (const k of BASIC_KEYS) basic[k] = str(basicIn[k])

  const entries: MasterEntry[] = []
  for (const [i, e] of (Array.isArray(r.entries) ? r.entries : []).entries()) {
    if (!e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    const org = str(x.org)
    const title = str(x.title)
    if (!org && !title) continue
    const bullets: Bullet[] = []
    for (const [j, b] of (Array.isArray(x.bullets) ? x.bullets : []).entries()) {
      const y = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
      const vs = variants(y.variants ?? (typeof b === 'string' ? [b] : []))
      if (vs.length === 0) continue
      const preferred = typeof y.preferred === 'number' && y.preferred >= 0 && y.preferred < vs.length ? Math.floor(y.preferred) : 0
      bullets.push({ id: str(y.id, 40) || `e${i + 1}b${j + 1}`, variants: vs, preferred, skills: strings(y.skills, 12, 60) })
      if (bullets.length >= LIMITS.bullets) break
    }
    entries.push({
      id: str(x.id, 40) || `e${i + 1}`,
      kind: KINDS.includes(x.kind as EntryKind) ? (x.kind as EntryKind) : 'experience',
      org, title,
      location: str(x.location), start_date: str(x.start_date, 40), end_date: str(x.end_date, 40),
      current: x.current === true, link: str(x.link, 500),
      bullets, from: strings(x.from, 20, 64),
    })
    if (entries.length >= LIMITS.entries) break
  }

  const education: MasterEducation[] = (Array.isArray(r.education) ? r.education : []).slice(0, 20)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      school: str(e.school), degree: str(e.degree), major: str(e.major), gpa: str(e.gpa, 40),
      start_date: str(e.start_date, 40), end_date: str(e.end_date, 40), location: str(e.location), description: str(e.description, LIMITS.text),
    }))
    .filter((e) => e.school || e.degree)

  if (entries.length === 0 && education.length === 0) return null
  const sources = (Array.isArray(r.sources) ? r.sources : []).slice(0, 20)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({ id: str(s.id, 64), name: str(s.name, 120) }))
    .filter((s) => s.id)
  return {
    version: 1, basic, summaries: variants(r.summaries), education, entries,
    skills: strings(r.skills), languages: strings(r.languages, 20, 60), sources,
    built_at: str(r.built_at, 40) || new Date().toISOString(),
  }
}

/** The master as one ordinary resume (every entry, preferred phrasings) —
 *  what auto-fill uses when the master is the current resume. */
export function masterToResume(m: MasterResume) {
  const describe = (e: MasterEntry) => e.bullets.map((b) => `• ${b.variants[b.preferred]?.text ?? b.variants[0].text}`).join('\n')
  const job = (e: MasterEntry) => ({
    company: e.org, title: e.title, location: e.location, start_date: e.start_date, end_date: e.end_date,
    current: e.current, description: describe(e),
  })
  return {
    version: 2 as const,
    basic: { ...Object.fromEntries(BASIC_KEYS.map((k) => [k, m.basic[k] ?? ''])) },
    intent: { apply_position: '', salary: '', available_date: '', years_exp: '' },
    education: m.education,
    experience: m.entries.filter((e) => e.kind === 'experience').map(job),
    internship: m.entries.filter((e) => e.kind === 'internship').map(job),
    projects: m.entries.filter((e) => e.kind === 'project').map((e) => ({
      name: e.org, role: e.title, link: e.link, start_date: e.start_date, end_date: e.end_date, description: describe(e),
    })),
    skills: m.skills,
    languages: m.languages,
    summary: m.summaries[0]?.text ?? '',
  }
}

/** An ordinary resume from an untrusted source, loosely: strings and arrays
 *  of the canonical shape (the web app runs the zod normalizer on top). */
export function parseLooseResume(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const obj = (v: unknown, keys: string[]) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return Object.fromEntries(keys.map((k) => [k, str(o[k], 300)]))
  }
  const list = (v: unknown, keys: string[], textKey = 'description') => (Array.isArray(v) ? v : []).slice(0, LIMITS.entries)
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      ...Object.fromEntries(keys.map((k) => [k, str((e as Record<string, unknown>)[k], k === textKey ? 4000 : 300)])),
      ...('current' in (e as object) ? { current: (e as Record<string, unknown>).current === true } : {}),
    }))
  const job = ['company', 'title', 'location', 'start_date', 'end_date', 'description']
  return {
    version: 2,
    basic: obj(r.basic, BASIC_KEYS),
    intent: obj(r.intent, ['apply_position', 'salary', 'available_date', 'years_exp']),
    education: list(r.education, ['school', 'degree', 'major', 'gpa', 'start_date', 'end_date', 'location', 'description']),
    experience: list(r.experience, job),
    internship: list(r.internship, job),
    projects: list(r.projects, ['name', 'role', 'link', 'start_date', 'end_date', 'description']),
    skills: strings(r.skills),
    languages: strings(r.languages, 20, 60),
    summary: str(r.summary, 2000),
  }
}

export function parseTarget(raw: unknown): ResumeTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const role = str(r.role, 200)
  if (!role) return null
  const url = str(r.job_url, 2000)
  return {
    role,
    company: str(r.company, 120) || null,
    job_url: /^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(url) ? url : null,
    jd_text: str(r.jd_text, 20_000) || null,
    application_id: /^[0-9a-f-]{36}$/i.test(str(r.application_id, 40)) ? str(r.application_id, 40) : null,
  }
}

export function parseTailorNotes(raw: unknown): TailorNotes {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    summary: str(r.summary, 1000),
    picks: (Array.isArray(r.picks) ? r.picks : []).slice(0, 30)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ what: str((p as Record<string, unknown>).what, 200), why: str((p as Record<string, unknown>).why, 400) }))
      .filter((p) => p.what),
  }
}

/** Count of bullets and alternative phrasings — for "12 bullets · 9 alternatives". */
export function masterStats(m: MasterResume) {
  const bullets = m.entries.reduce((n, e) => n + e.bullets.length, 0)
  const alternatives = m.entries.reduce((n, e) => n + e.bullets.reduce((k, b) => k + b.variants.length - 1, 0), 0)
  return { entries: m.entries.length, bullets, alternatives }
}

// ── uploads: one resume file → the canonical Resume (task `resume_parse`) ──

/** Files the agent reads itself (Claude Code reads PDFs and images natively).
 *  Word files are turned into text in the browser and sent as `text`. */
export const PARSE_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
}
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_TEXT = 60_000

export type ParseInput = { name: string; file: { type: string; data_base64: string } | null; text: string | null }

export function parseResumeParseInput(raw: unknown): ParseInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = str(r.name, 120) || 'Resume'
  const f = r.file as Record<string, unknown> | null | undefined
  if (f && typeof f === 'object') {
    const type = String(f.type ?? '')
    const data = typeof f.data_base64 === 'string' ? f.data_base64 : ''
    if (!PARSE_FILE_TYPES[type] || !data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return null
    if (data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) return null
    return { name, file: { type, data_base64: data.replace(/\s+/g, '') }, text: null }
  }
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_UPLOAD_TEXT) : ''
  return text ? { name, file: null, text } : null
}
