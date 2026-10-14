// Interview round numbering (packages/schema/src/pipeline.ts).
import { describe, expect, test } from 'vitest'
import { orderRounds, sortRounds, type InterviewRound } from '@landed/schema/pipeline'

const r = (round: number | null, at: string | null): InterviewRound => ({ round, format: 'remote', interviewers: [], at, note: null })
const view = (rounds: InterviewRound[]) => rounds.map((x) => [x.round, x.at?.slice(5, 10) ?? null])

describe('round numbers follow the times', () => {
  test('numbers that disagree with the times restart from 1, in time order', () => {
    // What an out-of-order email check plus a round added by hand left behind.
    const mixed = [r(2, '2026-09-28T20:00:00Z'), r(3, '2026-10-08T20:00:00Z'), r(4, '2026-10-18T20:00:00Z'), r(3, '2026-09-21T19:00:00Z')]
    expect(view(sortRounds(orderRounds(mixed)))).toEqual([[1, '09-21'], [2, '09-28'], [3, '10-08'], [4, '10-18']])
  })

  test('numbers that already rise with time are kept (round 1 just wasn\'t recorded)', () => {
    const later = [r(3, '2026-10-08T20:00:00Z'), r(2, '2026-09-28T20:00:00Z')]
    expect(view(sortRounds(orderRounds(later)))).toEqual([[2, '09-28'], [3, '10-08']])
  })

  test('rounds without a time: left as they are, listed by number, untimed last', () => {
    const typed = [r(2, null), r(1, '2026-09-28T20:00:00Z'), r(null, null)]
    expect(orderRounds(typed)).toBe(typed)
    expect(view(sortRounds(typed))).toEqual([[1, '09-28'], [2, null], [null, null]])
  })
})
