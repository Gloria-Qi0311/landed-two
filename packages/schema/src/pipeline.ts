// The application pipeline: stages and interview rounds. Shared by the web
// app, the server and the observation processor's callers. Plain TS, no
// dependencies (the server runs it with Node's type stripping).
//
// Board columns: Leads → Applied → OA / Test → Interview → Offer → Rejected.
//   - `saved` is what's stored for jobs you haven't applied to; it shows in
//     the Leads column next to the jobs your agents found.
//   - `ghosted` is a way of being closed: it shows in the Rejected column
//     with a "Ghosted" tag.
//   - `phone` / `onsite` are legacy (before interview rounds); they read as
//     `interview` with a remote / onsite round.

export const STAGE_VALUES = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted'] as const
export type StageValue = typeof STAGE_VALUES[number]
/** Accepted on input (old clients, old backups) and normalized away. */
export const LEGACY_STAGES = ['phone', 'onsite'] as const

export const INTERVIEW_FORMATS = ['onsite', 'remote'] as const
export const INTERVIEWERS = ['peer', 'teammate', 'leader', 'hr'] as const
export type Interviewer = typeof INTERVIEWERS[number]

export type InterviewRound = {
  /** 1, 2, 3… — null when unknown (e.g. migrated from "Onsite") */
  round: number | null
  format: typeof INTERVIEW_FORMATS[number] | null
  /** who interviewed you: peer, teammate, leader, HR (any mix) */
  interviewers: Interviewer[]
  /** ISO date/time, if known */
  at: string | null
  note: string | null
}

export const MAX_ROUNDS = 20

export function isStage(v: unknown): v is StageValue {
  return typeof v === 'string' && (STAGE_VALUES as readonly string[]).includes(v)
}

/** A stage from any client or backup → today's stage plus, for the legacy
 *  phone/onsite stages, the interview round they stood for. */
export function normalizeStage(v: unknown): { stage: StageValue; round?: InterviewRound } | null {
  if (isStage(v)) return { stage: v }
  if (v === 'phone' || v === 'onsite') {
    return { stage: 'interview', round: { round: null, format: v === 'phone' ? 'remote' : 'onsite', interviewers: [], at: null, note: null } }
  }
  return null
}

/** Validate interview rounds from an untrusted source; null if not an array. */
export function parseInterviews(raw: unknown): InterviewRound[] | null {
  if (!Array.isArray(raw)) return null
  const out: InterviewRound[] = []
  for (const r of raw.slice(0, MAX_ROUNDS)) {
    if (!r || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    const round = typeof x.round === 'number' && Number.isInteger(x.round) && x.round >= 1 && x.round <= 50 ? x.round : null
    const format = (INTERVIEW_FORMATS as readonly unknown[]).includes(x.format) ? (x.format as InterviewRound['format']) : null
    const interviewers = Array.isArray(x.interviewers)
      ? INTERVIEWERS.filter((i) => (x.interviewers as unknown[]).includes(i))
      : []
    const at = typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) ? x.at.slice(0, 40) : null
    const note = typeof x.note === 'string' && x.note.trim() ? x.note.trim().slice(0, 500) : null
    out.push({ round, format, interviewers, at, note })
  }
  return out
}

const FORMAT_LABEL = { onsite: 'Onsite', remote: 'Remote' } as const
export const INTERVIEWER_LABEL: Record<Interviewer, string> = { peer: 'Peer', teammate: 'Teammate', leader: 'Leader', hr: 'HR' }

/** "Round 2 · Onsite · Leader, HR" — empty parts are left out. */
export function roundLabel(r: InterviewRound): string {
  return [
    r.round ? `Round ${r.round}` : null,
    r.format ? FORMAT_LABEL[r.format] : null,
    r.interviewers.length ? r.interviewers.map((i) => INTERVIEWER_LABEL[i]).join(', ') : null,
  ].filter(Boolean).join(' · ') || 'Interview'
}

/** The round to show on a card: the highest-numbered, else the last added. */
export function latestRound(rounds: InterviewRound[] | null | undefined): InterviewRound | null {
  if (!rounds?.length) return null
  return [...rounds].sort((a, b) => (a.round ?? 0) - (b.round ?? 0)).at(-1) ?? null
}

/** The round to show on a card: the next one coming up, else the latest. */
export function currentRound(rounds: InterviewRound[] | null | undefined, now = Date.now()): InterviewRound | null {
  if (!rounds?.length) return null
  const upcoming = rounds
    .filter((r) => r.at && Date.parse(r.at) >= now - 2 * 3_600_000)
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))
  return upcoming[0] ?? latestRound(rounds)
}

/** "Mon, Oct 20, 2:00 PM" in the viewer's time zone. */
export function formatWhen(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── application deadlines (leads + applications not applied to yet) ──────

/** A deadline from anywhere ("2026-10-21", "Oct 21, 2026 5pm PT", an ISO
 *  time) → "YYYY-MM-DD", or null if it isn't a date. */
export function parseDeadline(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  const ymd = (y: number, m: number, d: number) => {
    const date = new Date(y, m - 1, d)
    if (y < 2000 || y > 2100 || date.getMonth() !== m - 1 || date.getDate() !== d) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  // 2026-10-21 (also the date part of an ISO time), 2026/10/21, 2026年10月21日
  let m = t.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  // 10/21/2026 (US order)
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
  if (m) return ymd(+m[3], +m[1], +m[2])
  // "Oct 21, 2026 5pm PT", "21 October 2026": drop times and zones, then let Date read it
  const dateOnly = t
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')
    .replace(/\b(PT|PST|PDT|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|UTC|GMT)\b/gi, '')
    .replace(/\b(at|by)\b/gi, '')
    .replace(/[,\s]+$/, '')
    .trim()
  const ms = Date.parse(dateOnly)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  if (!/\b\d{4}\b/.test(dateOnly)) {
    // "Dec 1": the next Dec 1 (JS would say 2001), unless it was within the last two months.
    const now = new Date()
    d.setFullYear(now.getFullYear())
    if (now.getTime() - d.getTime() > 60 * 86_400_000) d.setFullYear(now.getFullYear() + 1)
  }
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** Days from today to a deadline (0 = today, negative = passed). */
export function daysUntil(deadline: string, now = new Date()): number {
  const [y, m, d] = deadline.split('-').map(Number)
  const due = new Date(y, m - 1, d)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}
