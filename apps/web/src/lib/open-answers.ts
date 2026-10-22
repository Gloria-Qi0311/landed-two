// Open-ended answers ("Why us?") an application was sent with
// (`applications.open_answers`). The user's own agent writes them during the
// fill (extension lib/fill/open-answers.js); they're kept on the application,
// the drawer shows them, and the ones the user edited are the examples the
// agent follows next time (docs/apply-assist.md, "Open-ended questions").
import { MAX_OPEN_ANSWERS, type OpenAnswer } from '@landed/schema/open-answers'

/** The record after a fill wrote `written`: a question asked again gets the
 *  new answer unless the user edited the old one; new questions are added.
 *  null when nothing changed. */
export function mergeOpenAnswers(
  current: OpenAnswer[] | null | undefined, written: { question: string; answer: string }[], at = new Date().toISOString(),
): OpenAnswer[] | null {
  const next = [...(current ?? [])]
  let changed = false
  for (const w of written) {
    const i = next.findIndex((a) => a.question === w.question)
    if (i < 0) {
      next.push({ question: w.question, answer: w.answer, at })
      changed = true
    } else if (!next[i].edited && next[i].answer !== w.answer) {
      next[i] = { question: w.question, answer: w.answer, at }
      changed = true
    }
  }
  return changed ? next.slice(-MAX_OPEN_ANSWERS) : null
}

/** The user's own words for the agent to follow: answers they edited, newest
 *  first, one per question. */
export function openAnswerExamples(apps: { open_answers?: OpenAnswer[] | null }[], limit = 4): { question: string; answer: string }[] {
  const seen = new Set<string>()
  return apps.flatMap((a) => a.open_answers ?? [])
    .filter((a) => a.edited)
    .sort((x, y) => y.at.localeCompare(x.at))
    .filter((a) => !seen.has(a.question) && !!seen.add(a.question))
    .slice(0, limit)
    .map(({ question, answer }) => ({ question, answer }))
}

/** The record with one answer changed by the user. */
export function editOpenAnswer(current: OpenAnswer[], index: number, answer: string, at = new Date().toISOString()): OpenAnswer[] {
  return current.map((a, i) => (i === index ? { ...a, answer: answer.trim(), at, edited: true } : a))
}
