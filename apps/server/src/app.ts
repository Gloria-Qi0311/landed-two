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
import { pgErrorStatus } from './http.ts'
import type { PortalEventsHub } from './realtime.ts'
import { accountRoutes } from './routes/account.ts'
import { agentAccountRoutes, agentIngestRoutes } from './routes/agent.ts'
import { dataRoutes } from './routes/data.ts'
import { inboxRoutes } from './routes/inbox.ts'
import { searchRoutes } from './routes/searches.ts'
import { conversationRoutes } from './routes/conversations.ts'
import { downloadRoutes } from './routes/downloads.ts'
import { agentTaskRoutes, mcpRoutes } from './routes/mcp.ts'
import { oauthAccountRoutes, oauthRoutes } from './routes/oauth.ts'
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
// One agent observation is small; a large body is a misbehaving agent.
const agentBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge })
// A run's worth of results at once (up to 60 jobs / 100 email updates).
const agentBatchBody = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })

export function createApp(sql: Sql, config: Config, hub: PortalEventsHub, runtimes: RuntimeHub) {
  const app = new Hono<AppEnv>()

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
      : c.req.path === '/api/agent/jobs' || c.req.path === '/api/agent/email-updates' ? agentBatchBody
      : c.req.path.startsWith('/api/agent/') ? agentBody : smallBody
    return limit(c, next)
  })

  // Cloud agents (ChatGPT, Claude.ai, Gemini…): Landed's MCP server and the
  // OAuth endpoints that connect it. Called by the agents' servers or by
  // browser-based MCP clients with a Bearer token — never a cookie.
  for (const path of ['/mcp', '/oauth/*', '/.well-known/*']) {
    app.use(path, cors({
      origin: '*',
      allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['WWW-Authenticate'],
      maxAge: 86400,
    }))
  }
  app.use('/mcp', bodyLimit({ maxSize: 512 * 1024, onError: tooLarge }))
  app.use('/oauth/*', bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }))
  app.route('/', oauthRoutes(sql, config))
  app.route('/', mcpRoutes(sql, config))

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/auth', authRoutes(sql, config))
  app.route('/api/downloads', downloadRoutes())
  // External agents authenticate with a narrow connection token, never a
  // browser/extension session token.
  app.route('/api/agent', agentIngestRoutes(sql))
  app.route('/api/agent', agentTaskRoutes(sql))
  // The user's own computers (Landed daemon) authenticate with a runtime
  // token, never a session.
  app.route('/api/runtime', runtimeDaemonRoutes(sql, runtimes))

  // Signed-in routes. Account routes work for everyone; data routes only
  // for accounts with Landed Cloud sync on (Landed is local-first).
  const api = new Hono<AppEnv>()
  api.use('*', requireUser(sql))
  api.route('/', accountRoutes(sql))
  api.route('/', agentAccountRoutes(sql))
  api.route('/', runtimeAccountRoutes(sql, runtimes))
  api.route('/', oauthAccountRoutes(sql, config))
  const cloud = new Hono<AppEnv>()
  cloud.use('*', requireCloud)
  cloud.route('/', dataRoutes(sql, config))
  cloud.route('/', portalRoutes(sql, hub))
  cloud.route('/', syncRoutes(sql))
  cloud.route('/', inboxRoutes(sql))
  cloud.route('/', searchRoutes(sql))
  cloud.route('/', conversationRoutes(sql))
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
