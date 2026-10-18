// Small styles shared by the app's components, so a tweak lands everywhere.
// Colors and shadows come from the tokens in styles/globals.css; see
// docs/ui.md.
import type { CSSProperties } from 'react'

/** Secondary text: hints, notes, metadata. */
export const muted: CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5 }

/** Secondary text one size up, for a page's or a card's explanation. */
export const mutedLarge: CSSProperties = { fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }

/** Error text. */
export const danger = 'oklch(0.45 0.15 30)'

/** A white card on the page: a soft shadow, no border. */
export const card: CSSProperties = {
  background: 'var(--surface)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: '16px 18px',
  display: 'flex', flexDirection: 'column', gap: 10,
}
