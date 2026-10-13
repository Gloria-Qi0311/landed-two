// Apply-by date on a lead or a not-yet-applied application: "Due in 3d"
// (red when close), "Closed Oct 1" once passed. Click to pick a date;
// clear it with the × in the picker row. Safe inside draggable cards: the
// picker stops pointer/key events from reaching the board's drag handlers.
import { useState, type SyntheticEvent } from 'react'
import { daysUntil } from '@landed/schema/pipeline'
import { Icon } from './primitives'

const stop = (e: SyntheticEvent) => e.stopPropagation()

function describe(deadline: string): { text: string; tone: 'urgent' | 'soon' | 'normal' | 'past' } {
  const days = daysUntil(deadline)
  const date = new Date(`${deadline}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (days < 0) return { text: `Closed ${date}`, tone: 'past' }
  if (days === 0) return { text: 'Due today', tone: 'urgent' }
  if (days === 1) return { text: 'Due tomorrow', tone: 'urgent' }
  if (days <= 3) return { text: `Due in ${days}d`, tone: 'urgent' }
  if (days <= 7) return { text: `Due in ${days}d · ${date}`, tone: 'soon' }
  return { text: `Due ${date}`, tone: 'normal' }
}

const TONES = {
  urgent: { color: 'oklch(0.48 0.17 28)', background: 'oklch(0.96 0.04 28)', border: 'oklch(0.86 0.07 28)' },
  soon: { color: 'oklch(0.45 0.11 70)', background: 'oklch(0.97 0.04 85)', border: 'oklch(0.87 0.07 85)' },
  normal: { color: 'var(--fg-muted)', background: 'var(--surface-2)', border: 'var(--border)' },
  past: { color: 'var(--fg-muted)', background: 'transparent', border: 'var(--border)' },
} as const

export function DeadlineChip({ deadline, onSave, compact = false }: {
  deadline: string | null | undefined
  onSave: (next: string | null) => void
  /** cards: hide the "add" affordance until hovered (see .deadline-add in globals.css) */
  compact?: boolean
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <span onPointerDown={stop} onKeyDown={stop} onClick={stop} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input type="date" autoFocus aria-label="Apply-by date" defaultValue={deadline ?? ''}
          onChange={(e) => { if (e.target.value) { onSave(e.target.value); setEditing(false) } }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
          style={{ fontSize: 11, fontFamily: 'inherit', padding: '1px 4px', border: '1px solid var(--accent)', borderRadius: 4 }} />
        {deadline && (
          <button type="button" title="No deadline" aria-label="Remove deadline" onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onSave(null); setEditing(false) }}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 1, display: 'flex' }}>
            <Icon name="x" size={10} />
          </button>
        )}
      </span>
    )
  }

  const open = (e: SyntheticEvent) => { e.stopPropagation(); setEditing(true) }
  if (!deadline) {
    return (
      <button type="button" className={compact ? 'deadline-add' : undefined} onPointerDown={stop} onClick={open}
        style={{ fontSize: 10.5, color: 'var(--fg-muted)', background: 'transparent', border: '0.5px dashed var(--border)', borderRadius: 4, padding: '1px 6px', cursor: 'pointer', fontFamily: 'inherit', width: 'fit-content' }}>
        + Apply-by date
      </button>
    )
  }
  const { text, tone } = describe(deadline)
  const t = TONES[tone]
  return (
    <button type="button" title={`Apply by ${deadline} — click to change`} onPointerDown={stop} onClick={open}
      style={{
        fontSize: 10.5, color: t.color, background: t.background, border: `0.5px solid ${t.border}`, borderRadius: 4,
        padding: '1px 6px', cursor: 'pointer', fontFamily: 'inherit', width: 'fit-content', display: 'inline-flex', alignItems: 'center', gap: 4,
        textDecoration: tone === 'past' ? 'line-through' : undefined,
      }}>
      <Icon name="calendar" size={10} /> {text}
    </button>
  )
}

/** Soonest deadline first; none last. */
export const byDeadline = <T extends { deadline?: string | null }>(a: T, b: T) =>
  (a.deadline ?? '9999-99-99').localeCompare(b.deadline ?? '9999-99-99')
