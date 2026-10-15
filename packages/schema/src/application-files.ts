// Files the extension uploads into application forms: the user's own resume
// file and, optionally, a cover letter (one of each per account). Kept
// local-first like the rest of the job-hunt data; the bytes travel as base64
// (snapshots are JSON). Managed on the Extension page; the extension puts
// them into "Resume/CV" and "Cover letter" file inputs. Plain TS.

export const FILE_KINDS = ['resume', 'cover_letter'] as const
export type FileKind = typeof FILE_KINDS[number]

export const MAX_FILE_BYTES = 3 * 1024 * 1024

export const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export type ApplicationFile = {
  id: string
  kind: FileKind
  name: string
  mime: string
  size: number
  created_at: string
}

export type ApplicationFileInput = { id: string; kind: FileKind; name: string; data: string }

export const isFileKind = (v: unknown): v is FileKind => typeof v === 'string' && (FILE_KINDS as readonly string[]).includes(v)

/** Bytes in a base64 string, or -1 when it isn't base64. */
export function base64Size(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return -1
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

/** Validate an upload: a uuid id, a known kind, a .pdf/.doc/.docx name, base64
 *  data within the size limit. Returns the stored shape or an error. */
export function parseApplicationFile(raw: unknown): { ok: true; file: ApplicationFile & { data: string } } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.id)) return { ok: false, error: 'id must be a uuid' }
  if (!isFileKind(r.kind)) return { ok: false, error: `kind must be one of: ${FILE_KINDS.join(', ')}` }
  const name = typeof r.name === 'string' ? r.name.replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (!name || !FILE_TYPES[ext]) return { ok: false, error: 'a .pdf, .doc or .docx file is needed' }
  const data = typeof r.data === 'string' ? r.data : ''
  const size = base64Size(data)
  if (size <= 0) return { ok: false, error: 'the file is empty or not base64' }
  if (size > MAX_FILE_BYTES) return { ok: false, error: 'files can be up to 3 MB' }
  return {
    ok: true,
    file: {
      id: r.id, kind: r.kind, name, mime: FILE_TYPES[ext], size, data,
      created_at: typeof r.created_at === 'string' && !Number.isNaN(Date.parse(r.created_at)) ? r.created_at : new Date().toISOString(),
    },
  }
}
