// Landed API server entry. Serves /api/* and (in production) the built web
// app from apps/web/dist, on HOST:PORT (default 127.0.0.1:8787 — public
// traffic arrives via Cloudflare Tunnel, never directly).
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { deleteExpiredSessions } from './auth.ts'
import { loadConfig } from './config.ts'
import { connect } from './db.ts'
import { migrate } from './migrate.ts'
import { PortalEventsHub } from './realtime.ts'

const config = loadConfig()
const sql = connect(config.databaseUrl)
await migrate(sql, (m) => console.log('[migrate]', m))

const hub = new PortalEventsHub(sql)
await hub.start()

const app = createApp(sql, config, hub)
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[landed] listening on http://${info.address}:${info.port}` +
    (config.webDist ? ` (web: ${config.webDist})` : ''))
})

const cleanup = setInterval(() => void deleteExpiredSessions(sql).catch(console.error), 3_600_000)

async function shutdown() {
  clearInterval(cleanup)
  server.close()
  await hub.stop()
  await sql.end({ timeout: 5 })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
