// Unit tests for tryParseResponse — the 3-tier parser at the heart of every
// AI round-trip in the app. Tier 1 = JSON (with fence stripping + balanced
// extraction), Tier 2 = markdown table, Tier 3 = plain-text rankings.
//
// Coverage target: > 90 % on the parser module. The cases below were
// picked to (a) prove each tier in isolation, (b) prove the fallthrough
// chain in order, and (c) stress edge cases the LLM tends to produce —
// fences with language tags, leading/trailing prose, nested braces inside
// strings, unbalanced output, schema mismatches that should still parse.
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { tryParseResponse } from '../src/index'

const RankingsSchema = z.object({
  rankings: z.array(
    z.object({
      jd_id: z.string(),
      rank: z.number().int(),
      score: z.number(),
      reasons: z.array(z.string()).default([]),
      gaps: z.array(z.string()).default([]),
    }),
  ),
})

describe('tryParseResponse — empty + garbage', () => {
  it('returns failed for empty string', () => {
    const r = tryParseResponse('')
    expect(r.ok).toBe(false)
    expect(r.format).toBe('failed')
  })

  it('returns failed for whitespace only', () => {
    const r = tryParseResponse('   \n\t  \n  ')
    expect(r.ok).toBe(false)
    expect(r.format).toBe('failed')
  })

  it('returns failed for pure garbage with no JSON / table / ranking patterns', () => {
    const r = tryParseResponse('lorem ipsum dolor sit amet, consectetur adipiscing elit.')
    expect(r.ok).toBe(false)
    expect(r.format).toBe('failed')
  })
})

describe('tryParseResponse — Tier 1 (JSON)', () => {
  it('parses bare JSON object', () => {
    const r = tryParseResponse('{"rankings":[{"jd_id":"jd1","rank":1,"score":8.5,"reasons":[],"gaps":[]}]}')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) {
      expect((r.parsed as any).rankings[0].score).toBe(8.5)
    }
  })

  it('parses JSON wrapped in ```json fence', () => {
    const r = tryParseResponse('```json\n{"hello": "world"}\n```')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).hello).toBe('world')
  })

  it('parses JSON wrapped in ```jsonc fence', () => {
    const r = tryParseResponse('```jsonc\n{"a": 1}\n```')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
  })

  it('parses JSON wrapped in plain ``` fence', () => {
    const r = tryParseResponse('```\n{"a": 1}\n```')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
  })

  it('handles leading prose before JSON', () => {
    const r = tryParseResponse('Here are the rankings:\n\n{"rankings":[]}')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).rankings).toEqual([])
  })

  it('handles trailing prose after JSON', () => {
    const r = tryParseResponse('{"score": 9}\n\nLet me know if you want me to refine.')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
  })

  it('handles nested braces inside strings without confusing the balancer', () => {
    const input = '{"notes": "they said {literal braces} are fine", "score": 7}'
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) {
      expect((r.parsed as any).notes).toBe('they said {literal braces} are fine')
      expect((r.parsed as any).score).toBe(7)
    }
  })

  it('handles escaped quotes inside string values', () => {
    const input = '{"quote": "she said \\"yes\\" then left", "n": 1}'
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).quote).toBe('she said "yes" then left')
  })

  it('parses top-level JSON arrays', () => {
    const r = tryParseResponse('[{"a":1},{"b":2}]')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).length).toBe(2)
  })

  it('validates against expectedSchema when provided + shape matches', () => {
    const r = tryParseResponse(
      '{"rankings":[{"jd_id":"jd1","rank":1,"score":9,"reasons":["good fit"],"gaps":[]}]}',
      RankingsSchema,
    )
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).rankings[0].jd_id).toBe('jd1')
  })

  it('still returns json tier when JSON is valid but schema mismatch', () => {
    const r = tryParseResponse('{"wrong_field": 1}', RankingsSchema)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) expect((r.parsed as any).wrong_field).toBe(1)
  })

  it('falls through when JSON block is unbalanced (no closing brace)', () => {
    // Unbalanced extracts what it can; JSON.parse fails; falls through to
    // tier 2 (no table) then tier 3 (no ranking pattern) then failed.
    const r = tryParseResponse('{"a": 1, "b": [1, 2,')
    expect(r.ok).toBe(false)
    expect(r.format).toBe('failed')
  })

  it('handles mixed-case ```JSON fence', () => {
    const r = tryParseResponse('```JSON\n{"a": 1}\n```')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
  })

  it('KNOWN LIMITATION: triple-backticks inside JSON string values get stripped (silent data loss)', () => {
    // The fence regex .replace(/```/g, '') is greedy and not string-aware,
    // so backtick fences embedded inside a JSON string value (e.g. a code
    // snippet quoted by the LLM) get eaten. JSON still parses — but the
    // string value loses its backticks silently. Documented here so future
    // us doesn't try to "fix" the test thinking it's a bug. Real fix would
    // mean a string-aware fence stripper — defer until an actual prompt
    // asks the LLM to return code snippets.
    const r = tryParseResponse('{"snippet": "see ```code``` block"}')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
    if (r.ok) {
      const out = r.parsed as any
      // Backticks gone — content silently corrupted
      expect(out.snippet).toBe('see code block')
      expect(out.snippet).not.toContain('`')
    }
  })
})

describe('tryParseResponse — Tier 2 (markdown table)', () => {
  it('parses a ranking table with header + separator + data', () => {
    const input = [
      '| jd_id | rank | score |',
      '| --- | --- | --- |',
      '| jd1 | 1 | 8.5 |',
      '| jd2 | 2 | 7 |',
    ].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings).toHaveLength(2)
      expect(out.rankings[0]).toEqual({ jd_id: 'jd1', rank: 1, score: 8.5 })
      expect(out.rankings[1].score).toBe(7)
    }
  })

  it('parses a table without separator row', () => {
    const input = [
      '| jd_id | score |',
      '| jd1 | 6 |',
      '| jd2 | 9 |',
    ].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
    if (r.ok) expect((r.parsed as any).rankings).toHaveLength(2)
  })

  it('returns raw rows array when no ranking-flavored columns present', () => {
    const input = [
      '| name | sector |',
      '| --- | --- |',
      '| Helix Robotics | Robotics |',
      '| Lumen & Co | Fintech |',
    ].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
    if (r.ok) {
      const rows = r.parsed as any
      expect(Array.isArray(rows)).toBe(true)
      expect(rows[0].name).toBe('Helix Robotics')
    }
  })

  it('coerces numeric cells but leaves "8/10" as string (not a clean number)', () => {
    const input = [
      '| jd_id | score |',
      '| jd1 | 8/10 |',
      '| jd2 | 7.5 |',
    ].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings[0].score).toBe('8/10')
      expect(out.rankings[1].score).toBe(7.5)
    }
  })

  it('handles negative numbers in cells (jd_id present → wrapped as rankings)', () => {
    const input = [
      '| jd_id | delta |',
      '| jd1 | -3 |',
      '| jd2 | -1.5 |',
    ].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings).toBeDefined()
      expect(out.rankings[0].delta).toBe(-3)
      expect(out.rankings[1].delta).toBe(-1.5)
    }
  })

  it('skips lines without leading | as table candidates', () => {
    // A single | row alone is < 2 lines so should NOT be detected as a table.
    const r = tryParseResponse('| jd_id | score |\n\nsome prose here')
    expect(r.format).toBe('failed')
  })
})

describe('tryParseResponse — Tier 3 (plain text rankings)', () => {
  it('parses "JD1: 8/10" patterns and assigns ranks by score desc', () => {
    const input = ['JD1: 6/10 some reason', 'JD2: 9/10 strong fit', 'JD3: 7/10 ok'].join('\n')
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('heuristic')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings).toHaveLength(3)
      // Highest score gets rank 1
      expect(out.rankings[0].jd_id).toBe('jd2')
      expect(out.rankings[0].rank).toBe(1)
      expect(out.rankings[0].score).toBe(9)
      // Lowest gets rank 3
      expect(out.rankings[2].jd_id).toBe('jd1')
      expect(out.rankings[2].rank).toBe(3)
    }
  })

  it('parses "#3: 6" pattern', () => {
    const input = '#1: 5\n#2: 8\n#3: 6'
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('heuristic')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings).toHaveLength(3)
      expect(out.rankings[0].score).toBe(8) // #2
    }
  })

  it('parses "JD 2 - 7.5 strong fit" (space between JD and num, em-dash separator)', () => {
    const r = tryParseResponse('JD 2 - 7.5 strong fit')
    expect(r.ok).toBe(true)
    expect(r.format).toBe('heuristic')
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings[0].score).toBe(7.5)
    }
  })

  it('includes original line in reasons', () => {
    const r = tryParseResponse('JD1: 9 great match')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const out = r.parsed as any
      expect(out.rankings[0].reasons[0]).toBe('JD1: 9 great match')
    }
  })

  it('returns failed when no ranking line matches', () => {
    // No JD/#/item prefix; the parser can't latch on
    const r = tryParseResponse('First option scored highest, then second.')
    expect(r.ok).toBe(false)
    expect(r.format).toBe('failed')
  })
})

describe('tryParseResponse — fallthrough chain', () => {
  it('falls from invalid JSON → table → text → failed', () => {
    const input = 'definitely not json, not a table, not a ranking either'
    const r = tryParseResponse(input)
    expect(r.format).toBe('failed')
  })

  it('valid JSON wins even when text also contains a "JD1: 8" pattern', () => {
    const input = '{"winner":"json"}\nJD1: 8'
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('json')
  })

  it('markdown table wins over plain-text pattern when JSON is absent', () => {
    const input = ['| jd_id | score |', '| jd1 | 7 |'].join('\n') + '\nJD2: 5'
    const r = tryParseResponse(input)
    expect(r.ok).toBe(true)
    expect(r.format).toBe('markdown')
  })
})
