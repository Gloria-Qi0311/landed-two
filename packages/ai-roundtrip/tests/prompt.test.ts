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

describe('generatePrompt resume_parse — hardened ruleset', () => {
  it('includes the bilingual-name splitting rule + chineseName / wechat fields', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toContain('firstName')
    expect(prompt).toContain('lastName')
    expect(prompt).toContain('chineseName')
    expect(prompt).toContain('englishName')
    expect(prompt).toContain('wechat')
    expect(prompt).toMatch(/family name.+lastName/i)
  })

  it('reinforces JSON-only + bans markdown fences and special CJK quotes', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/ONLY output the JSON/i)
    expect(prompt).toMatch(/REMEMBER!!/)
    expect(prompt).toMatch(/markdown code fences?/i)
    expect(prompt).toContain('「」')
    expect(prompt).toContain('『』')
  })

  it('rule 6 gives an explicit safe option (single quotes) + names the unescaped-double-quote failure mode', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/INLINE QUOTES inside string values/)
    // The safe recommendation
    expect(prompt).toContain("use single quotes ' for emphasis")
    expect(prompt).toContain("一句话需求")
    // The named failure mode
    expect(prompt).toMatch(/closes the string at the first inner.+breaks parsing/)
    // Fallback: escape \" only if you must
    expect(prompt).toMatch(/escape it as \\\\"/)
  })

  it('requires reverse-chrono ordering + self-check + period-separated descriptions', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/reverse chronological/i)
    expect(prompt).toMatch(/self-check/i)
    expect(prompt).toMatch(/separate bullet points with periods/i)
    expect(prompt).not.toMatch(/upload your resume PDF/i)
  })

  it('emits a JSON schema template that itself parses cleanly', () => {
    const prompt = generatePrompt('resume_parse', {})
    const match = prompt.match(/\{[\s\S]*\}\s*$/)
    expect(match).toBeTruthy()
    const parsed = JSON.parse(match![0])
    expect(parsed.version).toBe(2)
    expect(parsed.basic).toHaveProperty('chineseName')
    expect(parsed.basic).toHaveProperty('wechat')
    expect(Array.isArray(parsed.internship)).toBe(true)
  })
})

describe('generatePrompt resume_parse — translation block', () => {
  it('omits the translation block when source === target (both explicit)', () => {
    const prompt = generatePrompt('resume_parse', { sourceLang: 'en', targetLang: 'en' })
    expect(prompt).not.toMatch(/Translation:/)
    expect(prompt).not.toMatch(/TRANSLATE these fields/)
    expect(prompt).not.toMatch(/DO NOT TRANSLATE/)
  })

  it('includes auto-detect language in the block when source is auto', () => {
    const prompt = generatePrompt('resume_parse', { sourceLang: 'auto', targetLang: 'en' })
    expect(prompt).toMatch(/Translation:/)
    expect(prompt).toMatch(/Source language: auto-detect/)
    expect(prompt).toMatch(/Target language: English/)
    expect(prompt).toMatch(/Detect the resume's source language first/)
  })

  it('includes proper-noun preservation rules when crossing languages (zh-CN → en)', () => {
    const prompt = generatePrompt('resume_parse', { sourceLang: 'zh-CN', targetLang: 'en' })
    expect(prompt).toMatch(/Translation:/)
    expect(prompt).toMatch(/Source language: Chinese \(Simplified, 简体中文\)/)
    expect(prompt).toMatch(/Target language: English/)
    expect(prompt).toMatch(/DO NOT TRANSLATE proper nouns/)
    expect(prompt).toContain('上海交通大学')
    expect(prompt).toContain('Shanghai Jiao Tong University')
    expect(prompt).toMatch(/JSON field names \(keys\) stay in English/)
  })

  it('handles each supported target language label correctly', () => {
    const labels = [
      { code: 'zh-CN', label: 'Chinese (Simplified, 简体中文)' },
      { code: 'zh-TW', label: 'Chinese (Traditional, 繁體中文)' },
      { code: 'ja', label: 'Japanese (日本語)' },
    ] as const
    for (const { code, label } of labels) {
      const prompt = generatePrompt('resume_parse', { sourceLang: 'en', targetLang: code })
      expect(prompt).toContain(`Target language: ${label}`)
    }
  })
})

describe('generatePrompt resume_parse — classification + multi-word proper-noun rules', () => {
  it('rule 9 spells out the experience / internship / projects decision order', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/9\. CLASSIFICATION/)
    expect(prompt).toMatch(/experience vs internship vs projects/)
    // Decision-order keywords
    expect(prompt).toMatch(/internship:.+intern.+TITLE or POSITION field/i)
    expect(prompt).toMatch(/competition.+ALWAYS a project, NEVER an internship/i)
    // Reverse-direction trigger words for Chinese contest naming patterns
    expect(prompt).toContain('挑战赛')
    expect(prompt).toContain('大赛')
    expect(prompt).toContain('hackathon')
    // Tiebreaker note about section headers
    expect(prompt).toMatch(/section headers.+tiebreaker/i)
    expect(prompt).toMatch(/OVERRIDES section placement/i)
  })

  it('rule 9 explicitly prevents "intern" from leaking via description body', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/NOT in the description body/)
    expect(prompt).toMatch(/competition entry.+as an intern PM.+still a competition/i)
  })

  it('rule 9 has the SELF-INITIATED PRODUCT TEST with domain-name + founder-title guards', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/SELF-INITIATED PRODUCT TEST/)
    // Domain-name-as-employer signal (the actual Gmailplusplus.site failure case)
    expect(prompt).toContain('Gmailplusplus.site')
    expect(prompt).toContain('MyApp.io')
    // Founder-title overrides
    expect(prompt).toMatch(/Founder.+Product Owner.+Builder.+Maker/)
    // The decisive TEST phrasing
    expect(prompt).toMatch(/did an EXTERNAL organization.+HIRE this person.+or did they build it themselves/i)
    expect(prompt).toMatch(/A domain name is NOT an employer/)
  })

  it('rule 10 forbids inferring category from description content', () => {
    const prompt = generatePrompt('resume_parse', {})
    expect(prompt).toMatch(/10\. Do not infer an entry's category from its description content/)
    expect(prompt).toMatch(/Category comes from WHAT THE ENTRY IS, not what the person did inside it/)
  })

  it('translation block adds competitions/events to the no-translate list + the parenthesized-form rule', () => {
    const prompt = generatePrompt('resume_parse', { sourceLang: 'zh-CN', targetLang: 'en' })
    expect(prompt).toMatch(/names of competitions \/ contests \/ challenges \/ hackathons \/ events \/ programs/)
    // The worked example for the parenthesized form
    expect(prompt).toContain('飞书 AI 校园挑战赛 (Lark AI Campus Challenge)')
    expect(prompt).toMatch(/never replace the original with a translated paraphrase/)
  })

  it('translation block adds the multi-word-name-as-whole rule + extra canonical examples', () => {
    const prompt = generatePrompt('resume_parse', { sourceLang: 'zh-CN', targetLang: 'en' })
    expect(prompt).toMatch(/multi-word name is still a single proper noun as a whole/)
    expect(prompt).toMatch(/test whether the entire string is the official NAME of a thing/i)
    // Newly added canonical pairs
    expect(prompt).toContain('飞书 ↔ Lark')
    expect(prompt).toContain('字节跳动 ↔ ByteDance')
  })
})
