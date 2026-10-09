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
    proxy: {
      '/api': {
        target: process.env.LANDED_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
})
