// Hono app wiring. Kept separate from index.ts so tests can build an app
// against a throwaway database without binding a port.
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { authRoutes, requireCloud, requireUser, type AppEnv } from './auth.ts'
import type { Config } from './config.ts'
import type { Sql } from './db.ts'
import { createPasswordResetSender, type PasswordResetSender } from './email.ts'
import { pgErrorStatus } from './http.ts'
import type { PortalEventsHub } from './realtime.ts'
import { accountRoutes } from './routes/account.ts'
import { dataRoutes } from './routes/data.ts'
import { inboxRoutes } from './routes/inbox.ts'
import { searchRoutes } from './routes/searches.ts'
import { answerRoutes } from './routes/answers.ts'
import { fileRoutes } from './routes/files.ts'
import { traceRoutes } from './routes/traces.ts'
import { downloadRoutes } from './routes/downloads.ts'
import { portalRoutes } from './routes/portal.ts'
import { syncRoutes } from './routes/sync.ts'
import { runtimeAccountRoutes, runtimeDaemonRoutes } from './routes/runtime.ts'
import type { RuntimeHub } from './runtime-hub.ts'

const tooLarge = (c: Context) => c.json({ error: 'request body too large' }, 413)
const smallBody = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge })
// A whole-device snapshot (resumes + AI run transcripts) can be big.
const uploadBody = bodyLimit({ maxSize: 50 * 1024 * 1024, onError: tooLarge })
// A resume file sent to the user's computer for parsing (base64, ≤ 8 MB).
const taskBody = bodyLimit({ maxSize: 12 * 1024 * 1024, onError: tooLarge })
// A resume or cover letter for the extension to upload (base64, ≤ 3 MB).
const fileBody = bodyLimit({ maxSize: 5 * 1024 * 1024, onError: tooLarge })

export function createApp(
  sql: Sql,
  config: Config,
  hub: PortalEventsHub,
  runtimes: RuntimeHub,
  services: { passwordResetSender?: PasswordResetSender | null } = {},
) {
  const app = new Hono<AppEnv>()
  const passwordResetSender = services.passwordResetSender === undefined
    ? (config.email ? createPasswordResetSender(config.email) : null)
    : services.passwordResetSender

  // The extension calls the API from chrome-extension://<id> with a Bearer
  // token. Wildcard origin without credentials: browsers never attach the
  // session cookie to cross-origin calls, so the cookie stays same-origin.
  app.use('/api/*', cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }))

  app.use('/api/*', (c, next) => {
    const limit = c.req.path === '/api/sync/upload' || c.req.path === '/api/cloud/enable'
      ? uploadBody
      : c.req.path === '/api/runtime-jobs' ? taskBody
      : c.req.path.startsWith('/api/application-files/') ? fileBody
      : smallBody
    return limit(c, next)
  })

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/auth', authRoutes(sql, config, passwordResetSender))
  app.route('/api/downloads', downloadRoutes())
  // The user's own computers (Landed daemon) authenticate with a runtime
  // token, never a session.
  app.route('/api/runtime', runtimeDaemonRoutes(sql, runtimes))

  // Signed-in routes. Account routes work for everyone; data routes only
  // for accounts with Landed Cloud sync on (Landed is local-first).
  const api = new Hono<AppEnv>()
  api.use('*', requireUser(sql))
  api.route('/', accountRoutes(sql))
  api.route('/', runtimeAccountRoutes(sql, runtimes))
  const cloud = new Hono<AppEnv>()
  cloud.use('*', requireCloud)
  cloud.route('/', dataRoutes(sql, config))
  cloud.route('/', portalRoutes(sql, hub))
  cloud.route('/', syncRoutes(sql))
  cloud.route('/', inboxRoutes(sql))
  cloud.route('/', searchRoutes(sql))
  cloud.route('/', answerRoutes(sql))
  cloud.route('/', fileRoutes(sql))
  cloud.route('/', traceRoutes(sql))
  api.route('/', cloud)
  app.route('/api', api)
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // Built web app + SPA fallback (react-router owns every non-/api path).
  if (config.webDist && existsSync(config.webDist)) {
    app.use('*', serveStatic({ root: config.webDist }))
    app.get('*', serveStatic({ root: config.webDist, path: 'index.html' }))
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    const status = pgErrorStatus(err)
    if (status) return c.json({ error: (err as Error).message }, status)
    console.error(`[api] ${c.req.method} ${c.req.path}`, err)
    return c.json({ error: 'internal server error' }, 500)
  })

  return app
}
