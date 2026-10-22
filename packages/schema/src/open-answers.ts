// ─── open-ended answers an application was sent with ─────────────────────
// `applications.open_answers`: "Why us?", "Tell us about a project…". On an
// approved application the user's own agent writes them from the posting and
// the resume it was filled from, its check passes them, and they go with the
// form (docs/apply-assist.md, "Open-ended questions"). Kept here so the user
// can read and edit them in the drawer; edited ones are the examples the
// agent follows next time.

export type OpenAnswer = {
  question: string
  answer: string
  /** when it was written or last edited */
  at: string
  /** the user changed it: their own words, the agent's example from now on */
  edited?: boolean
}

export const MAX_OPEN_ANSWERS = 10
export const MAX_OPEN_QUESTION = 300
export const MAX_OPEN_ANSWER = 4000

/** Validated: up to 10 questions with their answers (trimmed, capped), ISO
 *  times. null → null; anything else malformed → undefined. */
export function parseOpenAnswers(v: unknown): OpenAnswer[] | null | undefined {
  if (v === null) return null
  if (!Array.isArray(v) || v.length > MAX_OPEN_ANSWERS) return undefined
  const out: OpenAnswer[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return undefined
    const r = raw as Record<string, unknown>
    const question = typeof r.question === 'string' ? r.question.replace(/\s+/g, ' ').trim().slice(0, MAX_OPEN_QUESTION) : ''
    // Answers keep their paragraphs.
    const answer = typeof r.answer === 'string' ? r.answer.replace(/\r\n?/g, '\n').trim().slice(0, MAX_OPEN_ANSWER) : ''
    if (!question || !answer) return undefined
    const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date().toISOString()
    out.push({ question, answer, at, ...(r.edited === true ? { edited: true } : {}) })
  }
  return out
}
