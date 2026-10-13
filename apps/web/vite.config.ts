import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api/* goes to the Landed API server (apps/server, `pnpm dev`
// starts both). In production the server serves the built bundle itself,
// so the app is always same-origin with the API and the session cookie.
export default defineConfig({
  plugins: [react()],
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
