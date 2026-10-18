# Visual style

After the 2026-10-14 design pass.

- **Tokens** live in `apps/web/src/styles/globals.css`, per theme: cool (default),
  warm, editorial, dark. Use the variables, not literal colors.
- **Surfaces are white cards with `var(--shadow-sm)`, not hairline borders.**
  Avoid boxes inside boxes. A list inside a card uses
  `1px solid var(--border-subtle)` dividers.
- **Shared small styles** are in `apps/web/src/components/ui.ts`: `muted`,
  `mutedLarge`, `card`, `danger`. Import them instead of writing the same
  inline style again.
- **Board lanes** are soft rounded columns with no border. A company with several
  cards in a lane is **one card with a row per application** (`CompanyGroup` in
  `components/kanban.tsx`).
- **Company marks** derive a color and initials from the name when the company has
  none (`hueFor` / `initialsFor` in `components/primitives.tsx`; CJK names show
  one character).
- **Form controls** are styled globally: text/number/time/date inputs, selects
  with a chevron that inline styles can't hide, `accent-color` for checkboxes and
  radios. On/off settings use `<input type="checkbox" className="switch">`.
- **Buttons**: `btn-primary` (dark), `btn-secondary` (white, shadow), `btn-ghost`.

## Screenshots

Before/after screenshots of every page: seed a throwaway account against
`landed_test` and capture with Playwright using the installed Chrome
(`chromium.launch({ channel: 'chrome' })`). Use made-up people and companies.
