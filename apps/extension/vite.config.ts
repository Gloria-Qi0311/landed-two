// Vite config for the Landed extension's bundled surfaces (popup → #29
// here; options → #30; future React-driven content shells if needed).
//
// Layout:
//   apps/extension/
//     src/popup/index.html  ← Vite entry
//     src/popup/main.tsx
//     src/popup/App.tsx
//     vite.config.ts        ← this
//     dist/                 ← build output, gitignored
//       popup/index.html        ← bundled
//       assets/popup-<hash>.js
//       manifest.json           ← copied from root by closeBundle hook
//       background.js / content.js / schema.js / i18n.js  ← copied
//       lib/*.js / icons/* / assets/*                     ← copied
//
// Once built, "Load Unpacked" the dist/ directory in chrome://extensions
// (NOT apps/extension/ — that points at the old vanilla popup.html which
// will be retired in a follow-up once all popup features are ported).
//
// Static-file copy is a tiny inline plugin instead of vite-plugin-static-copy
// to keep the dep tree small. cpSync(..., { recursive: true }) is Node ≥ 16.7
// (we require ≥ 20 per root package.json).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { cpSync, existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function copyMv3Static() {
  return {
    name: 'copy-mv3-static',
    apply: 'build' as const,
    closeBundle() {
      const root = __dirname
      const dist = resolve(__dirname, 'dist')
      // Single files
      for (const f of ['manifest.json', 'background.js', 'content.js', 'schema.js', 'i18n.js']) {
        cpSync(resolve(root, f), resolve(dist, f))
      }
      // Directories
      for (const d of ['lib', 'icons', 'assets']) {
        const src = resolve(root, d)
        if (existsSync(src)) {
          cpSync(src, resolve(dist, d), { recursive: true })
        }
      }
    },
  }
}

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      // Lets popup TSX import the vanilla MV3 lib/* modules without ../../
      // path-climbing past the Vite root.
      '@lib': resolve(__dirname, 'lib'),
    },
  },
  plugins: [react(), copyMv3Static()],
})
