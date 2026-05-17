// Tests for prompt-builder behavior — focused on the spec.md §8 edge cases
// that aren't naturally covered by parser.test.ts:
//   - truncation utility correctness
//   - long JDs get truncated in built prompts
//   - bilingual JDs (zh + en mixed) pass through unchanged
import { describe, it, expect } from 'vitest'
import { truncateForPrompt, PROMPT_MAX_JD_CHARS, generatePrompt } from '../src/index'

describe('truncateForPrompt', () => {
  it('returns input unchanged when under limit', () => {
    const r = truncateForPrompt('short text')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short text')
    expect(r.originalChars).toBe(10)
  })

  it('returns empty result for null/undefined-like inputs', () => {
    const r = truncateForPrompt('')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('')
    expect(r.originalChars).toBe(0)
  })

  it('truncates when over limit with a visible marker', () => {
    const long = 'x'.repeat(PROMPT_MAX_JD_CHARS + 5000)
    const r = truncateForPrompt(long)
    expect(r.truncated).toBe(true)
    expect(r.originalChars).toBe(PROMPT_MAX_JD_CHARS + 5000)
    expect(r.text).toContain('[...truncated from')
    expect(r.text.length).toBeLessThan(long.length)
  })

  it('respects a custom maxChars limit', () => {
    const r = truncateForPrompt('a'.repeat(500), 100)
    expect(r.truncated).toBe(true)
    expect(r.originalChars).toBe(500)
    expect(r.text.length).toBeLessThan(500)
  })

  it('cuts at the nearest paragraph break (\\n\\n) when one is close to the limit', () => {
    const para1 = 'a'.repeat(95) + '\n\n'
    const para2 = 'b'.repeat(100)
    const r = truncateForPrompt(para1 + para2, 100)
    expect(r.truncated).toBe(true)
    // Should cut at the \n\n (which is at offset 95 — within the last-200 window)
    // and NOT include the 'b' run
    expect(r.text).not.toContain('b')
  })

  it('exposes the constant for callers to reuse', () => {
    expect(PROMPT_MAX_JD_CHARS).toBe(16000)
  })
})

describe('generatePrompt — truncation integration', () => {
  it('jd_breakdown truncates a very long JD body inside the built prompt', () => {
    const longJd = { title: 'Test', body: 'x'.repeat(PROMPT_MAX_JD_CHARS + 1000) }
    const prompt = generatePrompt('jd_breakdown', { jd: longJd })
    expect(prompt).toContain('[...truncated from')
    // Prompt should be smaller than naively concatenating the full body
    expect(prompt.length).toBeLessThan(PROMPT_MAX_JD_CHARS + 2000)
  })

  it('resume_match truncates each long JD independently', () => {
    const jds = [
      { id: 'jd1', title: 'Short', body: 'short body' },
      { id: 'jd2', title: 'Long', body: 'y'.repeat(PROMPT_MAX_JD_CHARS + 500) },
    ]
    const prompt = generatePrompt('resume_match', { resume: 'tiny resume', jds })
    // Short JD passes through unchanged
    expect(prompt).toContain('short body')
    // Long JD got the truncation marker
    expect(prompt).toContain('[...truncated from')
  })
})

describe('generatePrompt — bilingual JD pass-through (spec.md §8 #8)', () => {
  it('preserves Chinese + English mixed JD body verbatim', () => {
    const jd = {
      title: '前端工程师 Frontend Engineer',
      body: [
        'Required:',
        '- 5+ years TypeScript experience',
        '要求：',
        '- 5年以上 TypeScript 经验',
        '- 熟悉 React + Vite + Tailwind',
        '- Comfortable with Postgres + RLS',
      ].join('\n'),
    }
    const prompt = generatePrompt('jd_breakdown', { jd })
    // All four pieces survive verbatim
    expect(prompt).toContain('前端工程师 Frontend Engineer')
    expect(prompt).toContain('5+ years TypeScript experience')
    expect(prompt).toContain('5年以上 TypeScript 经验')
    expect(prompt).toContain('熟悉 React + Vite + Tailwind')
    expect(prompt).toContain('Comfortable with Postgres + RLS')
  })

  it('preserves a Japanese JD body', () => {
    const jd = {
      title: 'フロントエンドエンジニア',
      body: '必須スキル: TypeScript, React, Vite',
    }
    const prompt = generatePrompt('jd_breakdown', { jd })
    expect(prompt).toContain('フロントエンドエンジニア')
    expect(prompt).toContain('必須スキル: TypeScript, React, Vite')
  })
})
