// The open-ended answers an application keeps, and the user's own words the
// agent follows next time.
import { describe, expect, test } from 'vitest'
import { editOpenAnswer, mergeOpenAnswers, openAnswerExamples } from './open-answers'
import { parseApplyAssistResults } from './apply-batch'

const AT = '2026-10-22T08:00:00.000Z'
const LATER = '2026-10-22T09:00:00.000Z'

describe('open-ended answers on an application', () => {
  test('a fill adds what it wrote; asked again, a new answer replaces the agent\'s but never the user\'s', () => {
    const first = mergeOpenAnswers(null, [{ question: 'Why Bluefin?', answer: 'SQL dashboards.' }], AT)
    expect(first).toEqual([{ question: 'Why Bluefin?', answer: 'SQL dashboards.', at: AT }])
    expect(mergeOpenAnswers(first, [{ question: 'Why Bluefin?', answer: 'SQL dashboards.' }], LATER)).toBeNull()
    expect(mergeOpenAnswers(first, [{ question: 'Why Bluefin?', answer: 'Metrics.' }], LATER)).toEqual([{ question: 'Why Bluefin?', answer: 'Metrics.', at: LATER }])
    const edited = editOpenAnswer(first!, 0, '  My own words.  ', LATER)
    expect(edited).toEqual([{ question: 'Why Bluefin?', answer: 'My own words.', at: LATER, edited: true }])
    expect(mergeOpenAnswers(edited, [{ question: 'Why Bluefin?', answer: 'Metrics.' }], LATER)).toBeNull()
    expect(mergeOpenAnswers(edited, [{ question: 'A project?', answer: 'The dashboard.' }], LATER)).toHaveLength(2)
  })

  test('examples: only answers the user edited, newest first, one per question', () => {
    const apps = [
      { open_answers: [{ question: 'Why us?', answer: 'Agent text.', at: LATER }] },
      { open_answers: [{ question: 'Why us?', answer: 'Older words.', at: AT, edited: true }, { question: 'A project?', answer: 'Mine.', at: AT, edited: true }] },
      { open_answers: [{ question: 'Why us?', answer: 'Newer words.', at: LATER, edited: true }] },
      { open_answers: null },
    ]
    expect(openAnswerExamples(apps)).toEqual([
      { question: 'Why us?', answer: 'Newer words.' },
      { question: 'A project?', answer: 'Mine.' },
    ])
  })

  test('a fill result carries what the agent wrote, capped and plain', () => {
    const [r] = parseApplyAssistResults([{
      application_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', lead_id: null, tab_id: 3, status: 'submitted', blocker: null,
      open_answers: [{ question: ' Why  Bluefin? ', answer: 'SQL dashboards.' }, { question: 'Empty', answer: '' }, 'junk'],
    }])
    expect(r.open_answers).toEqual([{ question: 'Why Bluefin?', answer: 'SQL dashboards.' }])
    expect(parseApplyAssistResults([{ tab_id: 1, status: 'ready' }])[0].open_answers).toEqual([])
  })
})
