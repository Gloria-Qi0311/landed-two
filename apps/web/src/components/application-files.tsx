// "Files to upload" on the Extension page: the user's own resume file and an
// optional cover letter. The extension puts them into "Resume/CV" and "Cover
// letter" upload fields when it fills a form (apps/extension/content.js).
// Stored like the rest of the data (this browser, or Landed Cloud with sync
// on); the extension keeps a copy in its own storage.
import { useRef, useState } from 'react'
import { MAX_FILE_BYTES, type FileKind } from '@landed/schema/application-files'
import { Icon } from './primitives'
import { formatRelative } from '../lib/time'
import { useApplicationFiles, useDeleteApplicationFile, useSaveApplicationFile } from '../hooks/answers'
import { muted, danger, card } from './ui'


const SLOTS: { kind: FileKind; title: string; help: string }[] = [
  { kind: 'resume', title: 'Resume / CV', help: 'Goes into “Resume”, “CV” and “Attach resume” upload fields. The newest file you add on My Resume lands here too. A fill with a tailored version uploads that version’s one-page PDF instead.' },
  { kind: 'cover_letter', title: 'Cover letter', help: 'Optional. A general one for “Cover letter” fields; leave empty to write them yourself.' },
]

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
    reader.readAsDataURL(file)
  })
}

function Slot({ kind, title, help }: { kind: FileKind; title: string; help: string }) {
  const files = useApplicationFiles().data ?? []
  const save = useSaveApplicationFile()
  const remove = useDeleteApplicationFile()
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const current = files.find((f) => f.kind === kind)
  const busy = save.isPending || remove.isPending

  const onPick = async (file: File | undefined) => {
    setError(null)
    if (!file) return
    if (file.size > MAX_FILE_BYTES) return setError('Files can be up to 3 MB.')
    try {
      await save.mutateAsync({ kind, name: file.name, data: await readBase64(file) })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.3fr)', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 500 }}>{title}</div>
        <div style={muted}>{help}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {current ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, minWidth: 0 }}>
            <Icon name="doc" size={13} />
            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{current.name}</span>
            <span style={muted}>{kb(current.size)} · {formatRelative(current.created_at)}</span>
          </span>
        ) : (
          <span style={muted}>{kind === 'resume' ? 'No file yet — upload your resume on My Resume, or choose it here.' : 'No file — these fields stay yellow for you.'}</span>
        )}
        <input ref={picker} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
          onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = '' }} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => picker.current?.click()}>
            <Icon name="upload" size={12} /> {save.isPending ? 'Saving…' : current ? 'Replace' : 'Choose a file'}
          </button>
          {current && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => remove.mutate(kind)} aria-label={`Remove ${title}`}>
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      </div>
      {error && <div role="alert" style={{ ...muted, color: danger, gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  )
}

export function ApplicationFilesCard() {
  return (
    <div style={card}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>Files to upload</div>
        <div style={muted}>PDF or Word, up to 3 MB each. The extension attaches them when it fills a form; you still check and submit yourself.</div>
      </div>
      <div>{SLOTS.map((s) => <Slot key={s.kind} {...s} />)}</div>
    </div>
  )
}
