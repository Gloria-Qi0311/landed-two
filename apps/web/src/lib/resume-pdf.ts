// A tailored resume version → a one-page PDF the extension uploads for that
// job (#97; docs/apply-assist.md "Files to upload"). Made in the browser from
// the version's parsed_json, so nothing leaves the device and nothing extra
// is stored: when the version changes, the PDF is made again.
//
// The layout is the plain one applicant tracking systems read best: one
// column, real text (selectable, in reading order), standard section names,
// no tables or graphics. US Letter. The body starts at 10.5 pt and may step
// down to 9.5 pt to fit; if it still doesn't fit on one page, no PDF: the
// user shortens the version instead of getting unreadable type.
//
// The built-in PDF fonts can't show Chinese, Japanese or Korean text, so a
// version with those characters gets no PDF (the user's own resume file is
// uploaded instead) until a CJK font is embedded.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Resume } from '@landed/schema'

export type ResumePdf =
  | { ok: true; bytes: Uint8Array; name: string; fontSize: number }
  | { ok: false; reason: 'too_long'; overLines: number }
  | { ok: false; reason: 'characters'; sample: string }
  | { ok: false; reason: 'empty' }

const PAGE = { width: 612, height: 792 }
const MARGIN = { x: 46, top: 42, bottom: 40 }
const BODY_SIZES = [10.5, 10, 9.5]
const INK = rgb(0.1, 0.1, 0.12)
const SOFT = rgb(0.32, 0.32, 0.36)

// ── text the standard fonts can show (Windows-1252) ──────────────────────

const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const REPLACE: Record<string, string> = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', ' ': ' ', ' ': ' ', '‑': '-', '−': '-' }

const showable = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch)
}

/** Text as the standard fonts can draw it: known look-alikes swapped, the
 *  rest (emoji, symbols) dropped, whitespace collapsed. */
export function pdfText(text: string): string {
  let out = ''
  for (const ch of text) out += showable(ch) ? ch : REPLACE[ch] ?? (/\s/.test(ch) ? ' ' : '')
  return out.replace(/\s+/g, ' ').trim()
}

// ── what goes on the page ─────────────────────────────────────────────────

type Run = { text: string; bold?: boolean; italic?: boolean }
type Block =
  | { kind: 'name'; text: string }
  | { kind: 'contact'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'entry'; left: Run[]; right: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'para'; runs: Run[] }
  | { kind: 'gap'; size: number }

/** A description's lines as bullets ("• a\n• b", "- a", or plain lines). */
function bullets(description: string): string[] {
  return description.split(/\n+/).map((l) => l.replace(/^\s*(?:[•·▪◦\-*–]|\d+[.)])\s*/, '').trim()).filter(Boolean)
}

// "a  ·  b" that only breaks after a dot: the dot holds on to the item before
// it with no-break spaces, the next item starts after ordinary ones.
const DOT = '\u00a0\u00a0·'
const joinDots = (items: string[]) => items.map((it, i) => (i < items.length - 1 ? it + DOT : it)).join('  ')

/** `runs` and then `run`, a dot between them. */
const withDot = (runs: Run[], run: Run): Run[] => {
  if (runs.length === 0) return [run]
  const last = runs[runs.length - 1]
  return [...runs.slice(0, -1), { ...last, text: last.text + DOT }, { ...run, text: `  ${run.text}` }]
}

/** Where and when, right-aligned on an entry's first line. */
const whereWhen = (location: string, when: string) => [location.trim(), when].filter(Boolean).join('  ·  ')

const dates = (start: string, end: string, current = false) => {
  const s = start.trim()
  const e = current ? 'Present' : end.trim()
  return s && e ? `${s} – ${e}` : s || e
}

const yearOf = (d: string) => {
  const m = d.match(/(19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

/** Students and new grads lead with education. */
function educationFirst(r: Resume, now: Date): boolean {
  if (r.experience.length === 0) return true
  const latest = Math.max(...r.education.map((e) => yearOf(e.end_date) ?? 0), 0)
  return latest >= now.getFullYear() - 1
}

function blocks(r: Resume, now: Date): Block[] {
  const out: Block[] = []
  const b = r.basic
  const name = b.name || [b.firstName, b.lastName].filter(Boolean).join(' ') || b.englishName
  if (name) out.push({ kind: 'name', text: name })
  const contact = [b.email, b.phone, b.location, b.linkedin, b.github, b.portfolio].map((s) => s.trim()).filter(Boolean)
  if (contact.length) out.push({ kind: 'contact', text: joinDots(contact) })

  const section = (title: string, body: Block[]) => {
    if (body.length === 0) return
    out.push({ kind: 'gap', size: 7 }, { kind: 'section', text: title }, ...body)
  }
  const jobs = (list: Resume['experience']) => list.flatMap((e, i): Block[] => [
    ...(i > 0 ? [{ kind: 'gap', size: 3 } as Block] : []),
    {
      kind: 'entry',
      left: [{ text: e.title || e.company, bold: true }, ...(e.title && e.company ? [{ text: `, ${e.company}` }] : [])],
      right: whereWhen(e.location, dates(e.start_date, e.end_date, e.current)),
    },
    ...bullets(e.description).map((text): Block => ({ kind: 'bullet', text })),
  ])

  const summary = r.summary.trim() ? [{ kind: 'para', runs: [{ text: r.summary.trim() }] } as Block] : []
  const education = r.education.flatMap((e, i): Block[] => {
    const degree = [e.degree, e.major].filter(Boolean).join(e.degree && e.major ? ' in ' : '')
    const school: Run[] = [{ text: e.school, bold: true }, ...(degree ? [{ text: `, ${degree}` }] : [])]
    return [
      ...(i > 0 ? [{ kind: 'gap', size: 3 } as Block] : []),
      {
        kind: 'entry',
        left: e.gpa ? withDot(school, { text: `GPA ${e.gpa}` }) : school,
        right: whereWhen(e.location, dates(e.start_date, e.end_date)),
      },
      ...bullets(e.description).map((text): Block => ({ kind: 'bullet', text })),
    ]
  })
  const projects = r.projects.flatMap((p, i): Block[] => [
    ...(i > 0 ? [{ kind: 'gap', size: 3 } as Block] : []),
    {
      kind: 'entry',
      left: p.link
        ? withDot([{ text: p.name, bold: true }, ...(p.role ? [{ text: `, ${p.role}` }] : [])], { text: p.link, italic: true })
        : [{ text: p.name, bold: true }, ...(p.role ? [{ text: `, ${p.role}` }] : [])],
      right: dates(p.start_date, p.end_date),
    },
    ...bullets(p.description).map((text): Block => ({ kind: 'bullet', text })),
  ])
  const skills: Block[] = [
    ...(r.skills.length ? [{ kind: 'para', runs: [{ text: 'Skills: ', bold: true }, { text: r.skills.join(', ') }] } as Block] : []),
    ...(r.languages.length ? [{ kind: 'para', runs: [{ text: 'Languages: ', bold: true }, { text: r.languages.join(', ') }] } as Block] : []),
  ]

  section('Summary', summary)
  const edu = () => section('Education', education)
  if (educationFirst(r, now)) edu()
  section('Experience', jobs(r.experience))
  section('Internships', jobs(r.internship))
  section('Projects', projects)
  if (!educationFirst(r, now)) edu()
  section('Skills', skills)
  return out
}

// ── laying it out ─────────────────────────────────────────────────────────

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont }
type Draw = { x: number; y: number; text: string; font: PDFFont; size: number; color: typeof INK }
type Layout = { draws: Draw[]; rules: { y: number }[]; overflow: number }

const fontOf = (f: Fonts, run: Run) => (run.bold ? f.bold : run.italic ? f.italic : f.regular)

/** `runs` wrapped into lines no wider than `width`: each line's pieces, one
 *  per run, with where they start. A space goes with the word after it. */
function wrap(f: Fonts, runs: Run[], size: number, width: number): { run: Run; text: string; x: number }[][] {
  const lines: { run: Run; text: string; x: number }[][] = [[]]
  let x = 0
  const add = (run: Run, text: string, w: number) => {
    const l = lines[lines.length - 1]
    const prev = l[l.length - 1]
    if (prev && prev.run === run) prev.text += text
    else l.push({ run, text, x })
    x += w
  }
  const newLine = () => {
    lines.push([])
    x = 0
  }
  for (const run of runs) {
    const font = fontOf(f, run)
    for (let token of run.text.split(/(?= )/)) {
      if (x === 0) token = token.trimStart()
      if (!token) continue
      let w = font.widthOfTextAtSize(token, size)
      if (x > 0 && x + w > width) {
        newLine()
        token = token.trimStart()
        if (!token) continue
        w = font.widthOfTextAtSize(token, size)
      }
      // A word wider than the line is broken where it must be.
      while (w > width - x && token.length > 1) {
        let cut = token.length - 1
        while (cut > 1 && font.widthOfTextAtSize(token.slice(0, cut), size) > width - x) cut--
        add(run, token.slice(0, cut), 0)
        newLine()
        token = token.slice(cut)
        w = font.widthOfTextAtSize(token, size)
      }
      add(run, token, w)
    }
  }
  return lines.filter((l) => l.length > 0)
}

function layout(f: Fonts, list: Block[], body: number): Layout {
  const draws: Draw[] = []
  const rules: { y: number }[] = []
  const width = PAGE.width - MARGIN.x * 2
  const line = body * 1.28
  let y = PAGE.height - MARGIN.top
  let overflow = 0
  const advance = (h: number) => {
    y -= h
    if (y < MARGIN.bottom) overflow += h
  }
  const put = (x: number, text: string, font: PDFFont, size: number, color = INK) => draws.push({ x, y, text, font, size, color })

  for (const b of list) {
    if (b.kind === 'gap') { advance(b.size); continue }
    if (b.kind === 'name') {
      const size = body + 8
      advance(size)
      put(MARGIN.x, b.text, f.bold, size)
      advance(4)
      continue
    }
    if (b.kind === 'contact') {
      for (const l of wrap(f, [{ text: b.text }], body - 1, width)) {
        advance(line - 1)
        for (const part of l) put(MARGIN.x + part.x, part.text, f.regular, body - 1, SOFT)
      }
      continue
    }
    if (b.kind === 'section') {
      advance(body + 1.5)
      put(MARGIN.x, b.text.toUpperCase(), f.bold, body + 0.5)
      advance(3)
      rules.push({ y })
      advance(3)
      continue
    }
    if (b.kind === 'entry') {
      const right = b.right ? f.regular.widthOfTextAtSize(b.right, body) : 0
      const lines = wrap(f, b.left, body, width - (right ? right + 12 : 0))
      lines.forEach((l, i) => {
        advance(line)
        for (const part of l) put(MARGIN.x + part.x, part.text, fontOf(f, part.run), body, part.run.italic ? SOFT : INK)
        if (i === 0 && b.right) put(PAGE.width - MARGIN.x - right, b.right, f.regular, body, SOFT)
      })
      continue
    }
    if (b.kind === 'bullet') {
      const indent = 11
      wrap(f, [{ text: b.text }], body, width - indent).forEach((l, i) => {
        advance(line)
        if (i === 0) put(MARGIN.x + 2, '•', f.regular, body)
        for (const part of l) put(MARGIN.x + indent + part.x, part.text, f.regular, body)
      })
      continue
    }
    for (const l of wrap(f, b.runs, body, width)) {
      advance(line)
      for (const part of l) put(MARGIN.x + part.x, part.text, fontOf(f, part.run), body)
    }
  }
  return { draws, rules, overflow }
}

// ── the PDF ───────────────────────────────────────────────────────────────

/** Every piece of text in the resume, for the character check. */
function allText(r: Resume): string {
  return JSON.stringify([r.basic, r.summary, r.education, r.experience, r.internship, r.projects, r.skills, r.languages])
}

function clean(r: Resume): Resume {
  const t = (s: string) => pdfText(s)
  const ml = (s: string) => s.split('\n').map(t).join('\n')
  return {
    ...r,
    basic: Object.fromEntries(Object.entries(r.basic).map(([k, v]) => [k, t(v)])) as Resume['basic'],
    summary: t(r.summary),
    education: r.education.map((e) => ({ ...e, school: t(e.school), degree: t(e.degree), major: t(e.major), gpa: t(e.gpa), start_date: t(e.start_date), end_date: t(e.end_date), location: t(e.location), description: ml(e.description) })),
    experience: r.experience.map((e) => ({ ...e, company: t(e.company), title: t(e.title), location: t(e.location), start_date: t(e.start_date), end_date: t(e.end_date), description: ml(e.description) })),
    internship: r.internship.map((e) => ({ ...e, company: t(e.company), title: t(e.title), location: t(e.location), start_date: t(e.start_date), end_date: t(e.end_date), description: ml(e.description) })),
    projects: r.projects.map((p) => ({ ...p, name: t(p.name), role: t(p.role), link: t(p.link), start_date: t(p.start_date), end_date: t(p.end_date), description: ml(p.description) })),
    skills: r.skills.map(t).filter(Boolean),
    languages: r.languages.map(t).filter(Boolean),
  }
}

/** The file name recruiters see: "Alex Chen Resume.pdf". */
export function resumePdfName(r: Resume): string {
  const name = pdfText(r.basic.name || [r.basic.firstName, r.basic.lastName].filter(Boolean).join(' ') || r.basic.englishName).replace(/[\\/:*?"<>|]/g, '')
  return `${name || 'Resume'}${name ? ' Resume' : ''}.pdf`
}

export async function makeResumePdf(resume: Resume, now = new Date()): Promise<ResumePdf> {
  const cjk = allText(resume).match(CJK)
  if (cjk) return { ok: false, reason: 'characters', sample: cjk[0] }
  const r = clean(resume)
  const list = blocks(r, now)
  if (!list.some((b) => b.kind === 'entry' || b.kind === 'para' || b.kind === 'bullet')) return { ok: false, reason: 'empty' }

  const doc = await PDFDocument.create()
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }
  let fitted: { body: number; result: Layout } | null = null
  let last: Layout | null = null
  for (const body of BODY_SIZES) {
    last = layout(fonts, list, body)
    if (last.overflow === 0) {
      fitted = { body, result: last }
      break
    }
  }
  if (!fitted) return { ok: false, reason: 'too_long', overLines: Math.max(1, Math.ceil(last!.overflow / (BODY_SIZES[BODY_SIZES.length - 1] * 1.28))) }

  const page: PDFPage = doc.addPage([PAGE.width, PAGE.height])
  for (const d of fitted.result.draws) page.drawText(d.text, { x: d.x, y: d.y, font: d.font, size: d.size, color: d.color })
  for (const rule of fitted.result.rules) {
    page.drawLine({ start: { x: MARGIN.x, y: rule.y }, end: { x: PAGE.width - MARGIN.x, y: rule.y }, thickness: 0.6, color: SOFT })
  }
  const name = resumePdfName(r)
  doc.setTitle(name.replace(/\.pdf$/, ''))
  if (r.basic.name) doc.setAuthor(r.basic.name)
  doc.setCreator('Landed')
  doc.setProducer('Landed')
  return { ok: true, bytes: await doc.save(), name, fontSize: fitted.body }
}

// ── for the extension: which version PDF it has, and the bytes ────────────

/** A version's content as a short fingerprint: its PDF is made again only
 *  when this changes. */
export async function versionHash(parsed: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parsed ?? null)))
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}
