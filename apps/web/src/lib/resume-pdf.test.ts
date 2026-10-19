// The one-page PDF of a tailored version: real, extractable text in reading
// order on one page; too-long versions and CJK text get no PDF.
import { describe, expect, test } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { normalizeResume } from '@landed/schema'
import { makeResumePdf, pdfText, resumePdfName } from './resume-pdf'

// A made-up person.
const sample = normalizeResume({
  basic: {
    name: 'Alice Wong', firstName: 'Alice', lastName: 'Wong', email: 'alice.wong@example.com', phone: '+1-415-555-0123',
    location: 'San Francisco, CA', linkedin: 'linkedin.com/in/alicewong', github: 'github.com/alicewong', portfolio: 'alicewong.dev',
  },
  summary: 'Senior engineer with 5+ years building payment systems.',
  education: [{ school: 'Stanford University', degree: "Master's", major: 'Computer Science', gpa: '3.8', start_date: '2018-09', end_date: '2020-06', location: 'Stanford, CA' }],
  experience: [{
    company: 'Stripe', title: 'Senior Software Engineer', location: 'San Francisco, CA', start_date: '2022-03', end_date: '', current: true,
    description: '• Built payments infrastructure serving 1B+ requests a month across 40 countries.\n• Mentored four engineers.',
  }],
  projects: [{ name: 'ApplyMint', role: 'Creator', link: 'github.com/alicewong/applymint', start_date: '2025-01', description: '• Chrome extension that fills job applications.' }],
  skills: ['JavaScript', 'TypeScript', 'React', 'Go', 'Python'],
  languages: ['English', 'Mandarin'],
})
const now = new Date('2026-10-19T12:00:00Z')

async function readBack(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise
  const page = await pdf.getPage(1)
  const content = await page.getTextContent()
  const text = content.items.map((i) => ('str' in i ? i.str : '')).join('')
  const meta = await pdf.getMetadata()
  return { pages: pdf.numPages, text, title: (meta.info as { Title?: string }).Title }
}

describe('a tailored version as a one-page PDF', () => {
  test('one page of real text, in reading order, everything there', async () => {
    const pdf = await makeResumePdf(sample, now)
    expect(pdf.ok).toBe(true)
    if (!pdf.ok) return
    expect(pdf.name).toBe('Alice Wong Resume.pdf')
    const { pages, text, title } = await readBack(pdf.bytes)
    expect(pages).toBe(1)
    expect(title).toBe('Alice Wong Resume')
    for (const want of ['Alice Wong', 'alice.wong@example.com', sample.experience[0].company, sample.experience[0].title, sample.education[0].school, 'EXPERIENCE', 'EDUCATION', 'SKILLS']) {
      expect(text).toContain(want)
    }
    const firstBullet = sample.experience[0].description.split('\n')[0].replace(/^[•\-*\s]+/, '').trim()
    expect(text.replace(/\s+/g, ' ')).toContain(firstBullet.slice(0, 40))
    // Reading order: name, then experience, then education (not a new grad).
    expect(text.indexOf('Alice Wong')).toBeLessThan(text.indexOf('EXPERIENCE'))
    expect(text.indexOf('EXPERIENCE')).toBeLessThan(text.indexOf('EDUCATION'))
  })

  test('a student leads with education', async () => {
    const student = normalizeResume({ ...sample, experience: [], education: [{ ...sample.education[0], end_date: '2027-05' }] })
    const pdf = await makeResumePdf(student, now)
    if (!pdf.ok) throw new Error('no pdf')
    const { text } = await readBack(pdf.bytes)
    expect(text.indexOf('EDUCATION')).toBeGreaterThan(-1)
    expect(text.indexOf('EDUCATION')).toBeLessThan(text.indexOf('SKILLS'))
  })

  test('too long for one page: no PDF, and roughly how much to cut', async () => {
    const bullet = '• Led a cross-functional team to rebuild the payments ledger, cutting reconciliation time by 40% across 12 markets'
    const long = normalizeResume({
      ...sample,
      experience: Array.from({ length: 8 }, (_, i) => ({ ...sample.experience[0], company: `Company ${i}`, description: Array(6).fill(bullet).join('\n') })),
    })
    const pdf = await makeResumePdf(long, now)
    expect(pdf).toMatchObject({ ok: false, reason: 'too_long' })
    if (!pdf.ok && pdf.reason === 'too_long') expect(pdf.overLines).toBeGreaterThan(10)
  })

  test('steps the type down a little to fit, never below 9.5 pt', async () => {
    const bullet = '• Shipped a feature used by millions of people every single day across the whole product'
    let fits = 10.5
    for (let n = 1; n < 40; n++) {
      const r = normalizeResume({ ...sample, experience: [{ ...sample.experience[0], description: Array(n).fill(bullet).join('\n') }] })
      const pdf = await makeResumePdf(r, now)
      if (!pdf.ok) break
      fits = Math.min(fits, pdf.fontSize)
    }
    expect(fits).toBe(9.5)
  })

  test('Chinese, Japanese or Korean text: no PDF yet', async () => {
    const zh = normalizeResume({ ...sample, basic: { ...sample.basic, name: '王小明' } })
    expect(await makeResumePdf(zh, now)).toEqual({ ok: false, reason: 'characters', sample: '王' })
  })

  test('text the standard fonts can draw', () => {
    expect(pdfText('Grew revenue → 2×  — “fast” ✓ café')).toBe('Grew revenue -> 2× — “fast” café')
    expect(resumePdfName(normalizeResume({}))).toBe('Resume.pdf')
    expect(resumePdfName(normalizeResume({ basic: { name: 'A/B: Test' } }))).toBe('AB Test Resume.pdf')
  })

  test('nothing to put on the page', async () => {
    expect(await makeResumePdf(normalizeResume({ basic: { name: 'Alex' } }), now)).toEqual({ ok: false, reason: 'empty' })
  })
})
