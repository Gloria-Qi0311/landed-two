// Downloads: Landed for Mac (apps/daemon/scripts/build-mac.mjs → the
// connector app that pairs this computer with one click and runs the daemon
// in the background). Public: it carries no account data. Built on the
// machine that serves Landed (macOS); 404 with a hint otherwise.
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'

const MAC_ZIP = new URL('../../../daemon/dist/Landed-mac.zip', import.meta.url)

export function downloadRoutes() {
  const app = new Hono()
  app.get('/landed-mac.zip', async (c) => {
    let zip: Buffer
    try {
      zip = await readFile(MAC_ZIP)
    } catch {
      return c.json({ error: "Landed for Mac hasn't been built on this server yet (pnpm --filter @landed/daemon build:mac)." }, 404)
    }
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="Landed-mac.zip"',
      'Cache-Control': 'no-cache',
    })
  })
  return app
}
