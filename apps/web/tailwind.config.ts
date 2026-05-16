import type { Config } from 'tailwindcss'

/**
 * Surface tokens live as CSS custom properties in src/styles/globals.css
 * under :root and [data-theme="warm" | "editorial" | "dark"] selectors so
 * theme switching happens at runtime by flipping `data-theme` on <body>.
 *
 * Tailwind utilities reference those vars via `var(--token)` — that way
 * `bg-bg` / `text-fg-muted` / `border-border` etc. automatically respect
 * the active theme. The values below are pointers, not literals.
 *
 * Stage colors mirror the per-stage palette in components/primitives.jsx
 * (8 stages × {bg, fg, dot, ring}). Keeping a single source of truth in
 * primitives.jsx (the canonical JS object the components import) and
 * surfacing them here as utilities for any future Tailwind-styled UI.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          muted: 'var(--fg-muted)',
        },
        border: {
          DEFAULT: 'var(--border)',
          subtle: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
        },
        stage: {
          saved:    { bg: 'oklch(0.96 0.005 240)', fg: 'oklch(0.45 0.01 240)', dot: 'oklch(0.65 0.02 240)', ring: 'oklch(0.88 0.01 240)' },
          applied:  { bg: 'oklch(0.96 0.03 240)',  fg: 'oklch(0.45 0.12 240)', dot: 'oklch(0.62 0.15 240)', ring: 'oklch(0.88 0.05 240)' },
          oa:       { bg: 'oklch(0.96 0.04 275)',  fg: 'oklch(0.44 0.14 275)', dot: 'oklch(0.60 0.17 275)', ring: 'oklch(0.88 0.06 275)' },
          phone:    { bg: 'oklch(0.96 0.04 305)',  fg: 'oklch(0.44 0.14 305)', dot: 'oklch(0.60 0.17 305)', ring: 'oklch(0.88 0.06 305)' },
          onsite:   { bg: 'oklch(0.96 0.05 340)',  fg: 'oklch(0.45 0.15 340)', dot: 'oklch(0.62 0.18 340)', ring: 'oklch(0.88 0.07 340)' },
          offer:    { bg: 'oklch(0.96 0.05 155)',  fg: 'oklch(0.40 0.13 155)', dot: 'oklch(0.60 0.17 155)', ring: 'oklch(0.86 0.07 155)' },
          rejected: { bg: 'oklch(0.96 0.03 25)',   fg: 'oklch(0.50 0.12 25)',  dot: 'oklch(0.65 0.15 25)',  ring: 'oklch(0.88 0.05 25)' },
          ghosted:  { bg: 'oklch(0.96 0.003 60)',  fg: 'oklch(0.55 0.01 60)',  dot: 'oklch(0.70 0.01 60)',  ring: 'oklch(0.90 0.005 60)' },
        },
      },
      borderRadius: {
        chip: '4px',
        button: '6px',
        card: '8px',
        panel: '10px',
        pill: '999px',
      },
      borderWidth: {
        hairline: '0.5px',
      },
      fontFamily: {
        body: 'var(--font-body)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
      },
      // Prototype's documented type scale (design-system.html)
      fontSize: {
        'eyebrow': ['10.5px', { lineHeight: '1.4', letterSpacing: '0.06em' }],
        'micro':   ['11px',   { lineHeight: '1.4' }],
        'caption': ['11.5px', { lineHeight: '1.4' }],
        'small':   ['12px',   { lineHeight: '1.45' }],
        'body-sm': ['12.5px', { lineHeight: '1.5' }],
        'section': ['14px',   { lineHeight: '1.4', fontWeight: '600' }],
        'page':    ['15.5px', { lineHeight: '1.3', fontWeight: '600' }],
        'display': ['17px',   { lineHeight: '1.2', fontWeight: '600' }],
        'hero':    ['22px',   { lineHeight: '1.15', fontWeight: '600' }],
      },
      boxShadow: {
        drawer: '-12px 0 40px rgba(0,0,0,0.08)',
        popover: '0 12px 40px rgba(0,0,0,0.18)',
      },
      keyframes: {
        slideIn: {
          from: { transform: 'translateX(20px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        slideIn: 'slideIn 180ms cubic-bezier(0.2, 0, 0, 1)',
        pulse: 'pulse 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
