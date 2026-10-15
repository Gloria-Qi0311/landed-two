// Downloads: Landed for Mac (apps/daemon/scripts/build-mac.mjs → the
// connector app that pairs this computer with one click and runs the daemon
// in the background) and its signed update manifest. Public: they carry no
// account data. Built on the
// machine that serves Landed (macOS); 404 with a hint otherwise.
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'

const MAC_ZIP = new URL('../../../daemon/dist/Landed-mac.zip', import.meta.url)
// The signed update manifest (scripts/build-mac.mjs, release machine only):
// installed apps check it and update themselves (apps/daemon/src/updater.ts).
const MAC_MANIFEST = new URL('../../../daemon/dist/Landed-mac.json', import.meta.url)

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
  app.get('/landed-mac.json', async (c) => {
    try {
      return c.json(JSON.parse(await readFile(MAC_MANIFEST, 'utf8')), 200, { 'Cache-Control': 'no-cache' })
    } catch {
      return c.json({ error: 'no signed release published' }, 404)
    }
  })
  return app
}
