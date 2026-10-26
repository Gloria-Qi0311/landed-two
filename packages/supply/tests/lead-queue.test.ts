// The queue fields' rules live in @landed/schema/lead-queue (no test runner
// there); they are tested here, next to the package that writes them.
import { describe, expect, test } from 'vitest'
import {
  leadQueueDefaults, MAX_DEDUPE_CHECKED, MAX_REASON_LENGTH, MAX_REASONS, parseClosedAt, parseDedupe, parseFit, parsePostedAt, parseScreen, readLeadQueueFields,
} from '@landed/schema/lead-queue'

describe('parsePostedAt', () => {
  test.each([
    ['2026-10-17', '2026-10-17'],
    ['2026-10-17T23:30:00-07:00', '2026-10-17'], // the source's own day, not UTC's
    [Date.UTC(2026, 9, 1, 12), '2026-10-01'], // epoch ms (Lever's createdAt)
    ['Oct 5, 2026', '2026-10-05'],
  ])('%s → %s', (raw, out) => expect(parsePostedAt(raw)).toBe(out))

  test.each([null, undefined, '', 'yesterday', '2026-02-30', 0, -5, NaN, {}])('%s → null', (raw) => {
    expect(parsePostedAt(raw)).toBeNull()
  })

  test('seconds where ms are expected land in 1970: rejected, not stored', () => {
    expect(parsePostedAt(1760745600)).toBeNull()
    expect(parsePostedAt(1760745600 * 1000)).toBe('2025-10-18')
    expect(parsePostedAt('1999-12-31')).toBeNull()
  })
})

describe('parseClosedAt', () => {
  test('a moment in any form → ISO time', () => {
    expect(parseClosedAt('2026-10-17T12:00:00Z')).toBe('2026-10-17T12:00:00.000Z')
    expect(parseClosedAt(new Date(Date.UTC(2026, 9, 17)))).toBe('2026-10-17T00:00:00.000Z')
    expect(parseClosedAt(Date.UTC(2026, 9, 17))).toBe('2026-10-17T00:00:00.000Z')
  })
  test('anything else → null, and so is a time outside 2000–2100', () => {
    for (const raw of [null, '', 'soon', {}, NaN, 0, 1760745600, '1970-01-01T00:00:00Z', new Date(0)]) expect(parseClosedAt(raw)).toBeNull()
  })
})

describe('parseScreen / parseFit', () => {
  test('clean values pass through, reasons tidied and capped', () => {
    expect(parseScreen({ pass: false, reasons: ['  Says it does not\nsponsor visas '] })).toEqual({ pass: false, reasons: ['Says it does not sponsor visas'] })
    expect(parseScreen({ pass: true })).toEqual({ pass: true, reasons: [] })
    const many = Array.from({ length: 20 }, (_, i) => `reason ${i} `.repeat(50))
    const fit = parseFit({ score: 0.72, reasons: many })!
    expect(fit.score).toBe(0.72)
    expect(fit.reasons).toHaveLength(MAX_REASONS)
    expect(fit.reasons.every((r) => r.length <= MAX_REASON_LENGTH)).toBe(true)
  })

  test('wrong shapes are rejected, not guessed', () => {
    for (const raw of [null, [], 'pass', { pass: 'yes', reasons: [] }, { pass: true, reasons: 'x' }, { pass: true, reasons: [1] }]) {
      expect(parseScreen(raw)).toBeNull()
    }
    for (const raw of [{ score: 1.2, reasons: [] }, { score: -0.1, reasons: [] }, { score: '0.5', reasons: [] }, { score: NaN, reasons: [] }, { reasons: [] }]) {
      expect(parseFit(raw)).toBeNull()
    }
  })
})

describe('parseDedupe (#146)', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  test("the agent's verdict, cleaned: ids only, newest compared kept, a reason only when it says one", () => {
    expect(parseDedupe({ same_as: id(1), checked: [id(1), id(1), 'not an id!', 7], by: '  Claude\nCode ', at: '2026-10-26T12:00:00Z', reason: '  One opening,\n posted twice. ' }))
      .toEqual({ same_as: id(1), checked: [id(1)], by: 'Claude Code', at: '2026-10-26T12:00:00.000Z', reason: 'One opening, posted twice.' })
    expect(parseDedupe({ same_as: null, checked: [], by: 'Claude Code', at: '2026-10-26T12:00:00Z', reason: '' }))
      .toEqual({ same_as: null, checked: [], by: 'Claude Code', at: '2026-10-26T12:00:00.000Z', reason: null })
    const many = Array.from({ length: 70 }, (_, i) => id(i))
    expect(parseDedupe({ same_as: null, checked: many, by: 'Ollama', at: '2026-10-26T12:00:00Z' })!.checked).toEqual(many.slice(-MAX_DEDUPE_CHECKED))
  })
  test('wrong shapes are rejected, not guessed', () => {
    const ok = { same_as: null, checked: [], by: 'Claude Code', at: '2026-10-26T12:00:00Z' }
    for (const raw of [null, [], 'same', { ...ok, checked: 'x' }, { ...ok, by: ' ' }, { ...ok, at: 'today' }, { ...ok, same_as: 'not an id!' }, { ...ok, same_as: 5 }]) {
      expect(parseDedupe(raw)).toBeNull()
    }
  })
})

describe('readLeadQueueFields (every write path)', () => {
  test('only the fields given; null and "" clear', () => {
    expect(readLeadQueueFields({ status: 'new' })).toEqual({ ok: true, fields: {} })
    expect(readLeadQueueFields({ posted_at: '2026-10-17T08:00:00Z', fit: null, screen: '' })).toEqual({
      ok: true, fields: { posted_at: '2026-10-17', fit: null, screen: null },
    })
  })
  test('the first invalid field is reported', () => {
    expect(readLeadQueueFields({ posted_at: '2026-10-17', fit: { score: 2, reasons: [] } })).toEqual({
      ok: false, error: { field: 'fit', message: 'fit must be {score: 0–1, reasons: string[]}' },
    })
    expect(readLeadQueueFields({ closed_at: 'soon' })).toMatchObject({ ok: false, error: { field: 'closed_at' } })
  })
})

test('leadQueueDefaults: an old backup row gets every field, unreadable ones null', () => {
  expect(leadQueueDefaults({ id: 'x', title: 'Engineer' })).toEqual({ posted_at: null, closed_at: null, screen: null, fit: null, dedupe: null })
  expect(leadQueueDefaults({ posted_at: '2026-10-01', fit: { score: 9 } })).toEqual({ posted_at: '2026-10-01', closed_at: null, screen: null, fit: null, dedupe: null })
})
