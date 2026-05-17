import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createClient } from '@supabase/supabase-js'

// Dev-only Vite middleware that mints a Supabase session for any email
// without bouncing through the email provider. Saves you from the
// "rate-limit exceeded" + "edu inbox eats the link" loop during dev.
//
// `apply: 'serve'` is the kill switch — this plugin only runs under
// `vite dev`, never in `vite build`. The service_role key stays in the
// Node process; nothing about this is ever sent to the browser.
function devAuthPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'landed-dev-auth',
    apply: 'serve',
    configureServer(server) {
      const url = env.VITE_SUPABASE_URL
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
      const anonKey = env.VITE_SUPABASE_ANON_KEY
      if (!url || !serviceKey || !anonKey) {
        console.warn(
          '[dev-auth] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ' +
            'in .env.local — /api/dev/login disabled.',
        )
        return
      }
      const admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const anon = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      server.middlewares.use('/api/dev/login', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        let email: string | undefined
        try {
          email = JSON.parse(body || '{}').email
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        if (!email) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'email required' }))
          return
        }

        try {
          // Mint an OTP for this email (creates the auth.users row if new)
          const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
            type: 'magiclink',
            email,
          })
          if (linkErr) throw linkErr
          const otp = linkData?.properties?.email_otp
          if (!otp) throw new Error('No OTP in generateLink response')

          // Exchange the OTP for a real session — no email round-trip
          const { data: sessData, error: sessErr } = await anon.auth.verifyOtp({
            email,
            token: otp,
            type: 'email',
          })
          if (sessErr) throw sessErr
          if (!sessData.session) throw new Error('verifyOtp returned no session')

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ session: sessData.session }))
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error('[dev-auth] login failed for', email, '·', msg)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: msg }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // loadEnv reads .env / .env.local / .env.<mode> / .env.<mode>.local with '' prefix = no filtering
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), devAuthPlugin(env)],
    server: {
      port: 5173,
      strictPort: false,
    },
  }
})
