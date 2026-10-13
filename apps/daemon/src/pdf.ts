// A PDF's text, for agents that can't read files themselves (everything but
// Claude Code): macOS's own PDFKit through JavaScript for Automation, so
// nothing to install. Scanned PDFs have no text; those come back null.
import { spawnSync } from 'node:child_process'

const SCRIPT = `ObjC.import('PDFKit')
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]))
  if (!doc || doc.isNil()) return ''
  return ObjC.unwrap(doc.string) || ''
}`

export function pdfText(file: string): string | null {
  if (process.platform !== 'darwin') return null
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', SCRIPT, file], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  const text = r.status === 0 ? r.stdout.trim() : ''
  return text.length >= 20 ? text : null
}
