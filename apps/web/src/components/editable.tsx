// Click-to-edit text, used wherever saved data should be editable in place
// (application details, resumes, the master resume). Click → field; Enter
// (⌘/Ctrl+Enter when multi-line) or clicking away saves; Esc cancels.
// Saves only when the text actually changed.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'

export function EditableText({ value, onSave, placeholder = 'Add…', multiline = false, style, inputStyle, label }: {
  value: string | null | undefined
  onSave: (next: string) => void
  placeholder?: string
  multiline?: boolean
  style?: CSSProperties
  inputStyle?: CSSProperties
  /** accessible name for the field */
  label?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  useEffect(() => {
    const el = field.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    if (multiline) fit(el)
  }, [editing, multiline])

  const commit = () => {
    setEditing(false)
    const next = multiline ? draft.replace(/\s+$/, '') : draft.trim()
    if (next !== (value ?? '')) onSave(next)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(value ?? '')
      setEditing(false)
    } else if (e.key === 'Enter' && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commit()
    }
  }

  if (editing) {
    const common = {
      ref: field, value: draft, onBlur: commit, onKeyDown, 'aria-label': label,
      style: {
        width: '100%', font: 'inherit', color: 'var(--fg)', padding: '2px 6px',
        border: '1px solid var(--accent)', borderRadius: 5, background: 'var(--surface)', boxSizing: 'border-box' as const,
        ...inputStyle,
      },
    }
    return multiline
      ? <textarea {...common} rows={2} onChange={(e) => { setDraft(e.target.value); fit(e.target) }} style={{ ...common.style, resize: 'none', lineHeight: 'inherit' }} />
      : <input {...common} onChange={(e) => setDraft(e.target.value)} />
  }

  const empty = !(value ?? '').trim()
  return (
    <span
      role="button" tabIndex={0} title="Click to edit" aria-label={label ? `Edit ${label}` : undefined}
      className="editable"
      onClick={(e) => { e.stopPropagation(); setEditing(true) }}
      onKeyDown={(e) => { if (e.key === 'Enter') setEditing(true) }}
      style={{
        cursor: 'text', borderRadius: 4, whiteSpace: multiline ? 'pre-wrap' : undefined,
        color: empty ? 'var(--fg-muted)' : undefined, fontStyle: empty ? 'italic' : undefined,
        display: multiline ? 'block' : 'inline', ...style,
      }}>
      {empty ? placeholder : value}
    </span>
  )
}

function fit(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** A comma-separated list edited as text ("SQL, Python, Figma"). */
export function EditableList({ items, onSave, placeholder = 'Add…', label }: {
  items: string[]
  onSave: (next: string[]) => void
  placeholder?: string
  label?: string
}) {
  return (
    <EditableText
      label={label}
      value={items.join(', ')}
      placeholder={placeholder}
      onSave={(text) => onSave([...new Set(text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean))])}
    />
  )
}
