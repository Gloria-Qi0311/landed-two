import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api/* goes to the Landed API server (apps/server, `pnpm dev`
// starts both). In production the server serves the built bundle itself,
// so the app is always same-origin with the API and the session cookie.
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // The initial route needs React, local storage/query state, and the
        // draggable board. Keep those stable dependency families separate
        // from Landed's code so no single entry chunk dominates downloads
        // and repeat deployments can reuse the vendor cache.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'data',
              test: /node_modules[\\/](?:dexie|zod|@tanstack)[\\/]/,
              priority: 20,
            },
            {
              name: 'drag-drop',
              test: /node_modules[\\/]@dnd-kit[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // Cloud agents' MCP + OAuth endpoints live on the API server too; the
    // consent page (/authorize-agent) is this app's.
    proxy: Object.fromEntries(['/api', '/mcp', '/oauth', '/.well-known'].map((path) => [path, {
      target: process.env.LANDED_API_URL ?? 'http://127.0.0.1:8787',
      changeOrigin: false,
    }])),
  },
})
