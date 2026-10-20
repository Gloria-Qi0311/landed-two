// What the browser reads from a resume on its own: only what it says plainly.
import { describe, expect, test } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { basicsFound, nameLine, pdfText, readBasics } from './resume-basics'

const RESUME = `ALEX RIVERA
Seattle, WA | (555) 010-0199 | alex.rivera@example.com | linkedin.com/in/alex-rivera-example | github.com/alexrivera-example
EDUCATION
Example State University — B.S. Computer Science, 2023-09 – 2027-06
EXPERIENCE
Software Engineer Intern, Sample Labs, 2025-06 – 2025-09`

describe('readBasics', () => {
  test('name, email, phone and links; nothing else', () => {
    const r = readBasics(RESUME)
    expect(r.basic).toMatchObject({
      name: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', phone: '(555) 010-0199',
      linkedin: 'linkedin.com/in/alex-rivera-example', github: 'github.com/alexrivera-example', location: '',
    })
    expect(r.education).toEqual([])
    expect(r.experience).toEqual([])
    expect(basicsFound(r)).toEqual(['Alex Rivera', 'alex.rivera@example.com', '(555) 010-0199', 'LinkedIn', 'GitHub'])
  })

  test('a date range is not a phone number', () => {
    expect(readBasics('Jordan Lee\njordan@example.com\nExample College, 2023-09 – 2027-06').basic.phone).toBe('')
    expect(readBasics('Jordan Lee\n+1 555 010 0142').basic.phone).toBe('+1 555 010 0142')
  })

  test('no text (a scanned PDF): an empty resume, not a guess', () => {
    expect(basicsFound(readBasics(''))).toEqual([])
  })
})

describe('nameLine', () => {
  test.each([
    ['Alex Rivera', 'Alex Rivera'],
    ['ALEX RIVERA', 'Alex Rivera'],
    ['Mary-Jane O\'Neil', 'Mary-Jane O\'Neil'],
    ['José Álvarez', 'José Álvarez'],
    ['Alex Rivera | alex@example.com | 555-010-0199', 'Alex Rivera'],
    ['李雷', '李雷'],
  ])('%s', (line, want) => expect(nameLine(line)).toBe(want))

  test.each(['Resume', 'Curriculum Vitae', 'RESUME OF ALEX RIVERA', 'alex.rivera@example.com', 'Software Engineer with 3 years', 'Software Engineer', 'Data Analyst Intern', 'Alex', '个人简历', ''])(
    "%s isn't plainly a name: null", (line) => expect(nameLine(line)).toBeNull())
})

test('pdfText reads a PDF line by line', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  RESUME.split('\n').forEach((line, i) => page.drawText(line.replace(/[—–]/g, '-'), { x: 40, y: 740 - i * 18, size: 9, font }))
  const bytes = await doc.save()
  const text = await pdfText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, pdfjs as never)
  expect(readBasics(text).basic).toMatchObject({ name: 'Alex Rivera', email: 'alex.rivera@example.com', phone: '(555) 010-0199' })
})
