// A resume uploaded without a computer (docs/agents.md, "Resume upload"):
// the browser reads its text and takes only what a resume says plainly —
// name, email, phone, LinkedIn and GitHub — so auto-fill and the Extension
// page have them right away. The rest (experience, education, skills) is
// left to the user's own agent, which reads the kept file once a computer is
// connected. Nothing here leaves the browser.
import { emptyResume, type Resume } from '@landed/schema'

/** What can be uploaded without a computer: read here, and kept as the
 *  extension's resume file for the agent to read in full later. */
export const READABLE_HERE = /\.(pdf|docx)$/i

type PdfJs = { getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfDoc> } }
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> }

/** A PDF's text in reading order, a line per line (pages up to 4). */
export async function pdfText(data: ArrayBuffer, pdfjs: PdfJs): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise
  let out = ''
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      out += item.str ?? ''
      if (item.hasEOL) out += '\n'
    }
    out += '\n'
  }
  return out
}

async function browserPdfJs(): Promise<PdfJs> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs as unknown as PdfJs
}

/** A resume file's text, read in the browser. Photos can't be: an error. */
export async function resumeText(file: { name: string; arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }): Promise<string> {
  if (/\.pdf$/i.test(file.name)) return pdfText(await file.arrayBuffer(), await browserPdfJs())
  if (/\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value
  }
  if (/\.(txt|md|markdown)$/i.test(file.name)) return file.text()
  throw new Error("Only your computer can read this kind of file. Upload a PDF or Word (.docx) file, or connect your computer.")
}

// A heading or a job title on the first line isn't a name.
const NOT_A_NAME = /\b(resume|résumé|curriculum|vitae|cv|profile|summary|contact|email|phone|objective|education|experience|engineer|developer|manager|designer|analyst|scientist|intern|student|consultant|specialist|associate|director|lead)\b|简历|个人/i

const titleCase = (w: string) => (w === w.toUpperCase() && w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w)

/** The name a resume opens with, if its first line plainly is one: two to
 *  four words of letters ("ALEX RIVERA" → "Alex Rivera"), or two to four
 *  Chinese characters. Anything else: null — a wrong name would be filled
 *  into forms. */
export function nameLine(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)
  if (!first) return null
  const head = first.split(/\s*[|•·,，]\s*|\s{3,}/)[0].trim()
  if (NOT_A_NAME.test(head)) return null
  if (/^[一-鿿]{2,4}$/.test(head)) return head
  const words = head.split(/\s+/)
  if (words.length < 2 || words.length > 4 || !words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.-]*$/.test(w))) return null
  return words.map(titleCase).join(' ')
}

/** A phone number: 10 to 15 digits, not a date range ("2023-09 – 2027-06"). */
function phoneIn(text: string): string | null {
  for (const m of text.matchAll(/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 15) continue
    if (/^(19|20)\d{2}[-/.]\d{1,2}\b/.test(m[0].trim())) continue
    return m[0].trim()
  }
  return null
}

/** What the browser takes from a resume's text: name, email, phone,
 *  LinkedIn, GitHub. The rest of the resume stays empty for the agent. */
export function readBasics(text: string): Resume {
  const r = emptyResume()
  const name = nameLine(text)
  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? ''
  const linkedin = text.match(/(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/[\w%-]+/i)?.[0] ?? ''
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i)?.[0] ?? ''
  const words = name?.split(' ') ?? []
  r.basic = {
    ...r.basic,
    name: name ?? '',
    firstName: words.length === 2 ? words[0] : '',
    lastName: words.length === 2 ? words[1] : '',
    email,
    phone: phoneIn(text.replace(email, '')) ?? '',
    linkedin,
    github,
  }
  return r
}

/** What was read, for the page to say: "Alex Rivera, alex@…, LinkedIn". */
export function basicsFound(r: Resume | null): string[] {
  if (!r) return []
  const b = r.basic
  return [b.name, b.email, b.phone, b.linkedin && 'LinkedIn', b.github && 'GitHub'].filter((x): x is string => !!x)
}
