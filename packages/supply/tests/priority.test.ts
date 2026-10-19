import { describe, expect, test } from 'vitest'
import { daysUntil, priority, UNRANKED, urgency, type PriorityInput } from '../src'

const now = new Date(2026, 9, 18, 15, 30) // Oct 18 2026, mid-afternoon local time
const lead = (over: Partial<PriorityInput> = {}): PriorityInput => ({
  deadline: null, posted_at: null, closed_at: null, screen: null, fit: null, ...over,
})
const fit = (score: number) => ({ score, reasons: ['made-up reason'] })

describe('daysUntil', () => {
  test('counts calendar days from today, whatever the time of day', () => {
    expect(daysUntil('2026-10-18', now)).toBe(0)
    expect(daysUntil('2026-10-19', now)).toBe(1)
    expect(daysUntil('2026-10-11', now)).toBe(-7)
    expect(daysUntil('2026-11-18', now)).toBe(31)
  })
  test('null for no date or one that does not read', () => {
    expect(daysUntil(null, now)).toBeNull()
    expect(daysUntil('next week', now)).toBeNull()
  })
})

describe('urgency', () => {
  test('a deadline: most urgent on the day, about half a week before', () => {
    expect(urgency(lead({ deadline: '2026-10-18' }), now)).toBe(1)
    expect(urgency(lead({ deadline: '2026-10-25' }), now)).toBeCloseTo(0.5)
    expect(urgency(lead({ deadline: '2026-10-11' }), now)).toBe(0)
  })
  test('no deadline: a fresh posting beats an old one, both below a near deadline', () => {
    const fresh = urgency(lead({ posted_at: '2026-10-17' }), now)
    const old = urgency(lead({ posted_at: '2026-09-18' }), now)
    expect(fresh).toBeGreaterThan(old)
    expect(fresh).toBeLessThan(urgency(lead({ deadline: '2026-10-20' }), now))
  })
  test('neither: a low default', () => {
    expect(urgency(lead(), now)).toBe(0.2)
  })

  test('a far deadline is never less urgent than no date at all (review of #102)', () => {
    // 60 days out used to score 0.276 against 0.300 for a lead with no dates.
    const far = priority(lead({ fit: fit(0.5), deadline: '2026-12-17' }), now)
    const none = priority(lead({ fit: fit(0.5) }), now)
    expect(far).toBeGreaterThanOrEqual(none)
    expect(urgency(lead({ posted_at: '2025-10-18' }), now)).toBe(0.2) // a year-old posting: the floor too
  })
})

describe('priority', () => {
  test('a close deadline on a good fit comes first; fit decides more than urgency', () => {
    const order = [
      lead({ fit: fit(0.9), deadline: '2026-10-20' }),
      lead({ fit: fit(0.9), deadline: '2026-11-30' }),
      lead({ fit: fit(0.4), deadline: '2026-10-20' }),
      lead({ fit: fit(0.2), deadline: '2026-11-30' }),
    ].map((l) => priority(l, now))
    expect([...order].sort((a, b) => b - a)).toEqual(order)
  })

  test('unscored leads count as an even fit', () => {
    expect(priority(lead({ deadline: '2026-10-18' }), now)).toBeCloseTo(0.5)
  })

  test('closed, screened out and past the deadline: unranked, below everything', () => {
    expect(priority(lead({ fit: fit(1), closed_at: '2026-10-17T12:00:00.000Z' }), now)).toBe(UNRANKED)
    expect(priority(lead({ fit: fit(1), screen: { pass: false, reasons: ['Says it does not sponsor visas'] } }), now)).toBe(UNRANKED)
    expect(priority(lead({ fit: fit(1), deadline: '2026-10-17' }), now)).toBe(UNRANKED)
    expect(priority(lead({ fit: fit(0), deadline: '2026-11-30' }), now)).toBeGreaterThan(UNRANKED)
  })

  test('a lead that passed the hard filters ranks like an unfiltered one', () => {
    const passed = lead({ fit: fit(0.7), screen: { pass: true, reasons: [] } })
    expect(priority(passed, now)).toBe(priority(lead({ fit: fit(0.7) }), now))
  })

  test('stays within 0–1 for ranked leads', () => {
    for (const score of [0, 0.3, 1]) {
      for (const deadline of ['2026-10-18', '2026-12-31', null]) {
        const p = priority(lead({ fit: fit(score), deadline }), now)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(1)
      }
    }
  })
})
