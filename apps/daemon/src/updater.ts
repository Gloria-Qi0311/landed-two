// Landed for Mac updates itself. The background service asks the server it's
// paired with for the published build (GET /api/downloads/landed-mac.json),
// and when it's newer than this one: downloads the zip, checks its size and
// SHA-256 and the manifest's Ed25519 signature against the public key this
// install came with, unpacks it, replaces Landed.app where it's installed and
// opens the new one in the background — whose launch runs `setup`, which
// installs the new daemon, browser extension and native host and restarts
// this service. The server only hosts: a build not signed with the release
// key (scripts/build-mac.mjs) is never installed, so a compromised server
// can't push code to the Mac. Builds without build.json + update-key.pem
// (running from source, the mini's unsigned build) don't update.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { home } from './config.ts'

export const BUNDLE_ID = 'dev.landed.connector'
const CHECK_EVERY_MS = 6 * 60 * 60_000
const FIRST_CHECK_MS = 2 * 60_000

export type Manifest = { version: string; build: string; sha256: string; size: number; signature: string }
export type Installed = { build: string; publicKey: string; dir: string }

/** This install's build id and update key (next to the running daemon). */
export function installedBuild(script = process.argv[1] ?? ''): Installed | null {
  const dir = dirname(script)
  try {
    const { build } = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as { build?: unknown }
    const publicKey = readFileSync(join(dir, 'update-key.pem'), 'utf8')
    return typeof build === 'string' && build ? { build, publicKey, dir } : null
  } catch {
    return null
  }
}

const BUILD_ID = /^\d{8}T\d{6}Z-[0-9a-z]{1,40}$/

export function parseManifest(raw: unknown): Manifest | null {
  const m = raw as Record<string, unknown> | null
  if (!m || typeof m !== 'object') return null
  if (typeof m.build !== 'string' || !BUILD_ID.test(m.build)) return null
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null
  if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size <= 0 || m.size > 200 * 1024 * 1024) return null
  if (typeof m.signature !== 'string' || !m.signature) return null
  return { version: typeof m.version === 'string' ? m.version.slice(0, 40) : '', build: m.build, sha256: m.sha256, size: m.size, signature: m.signature }
}

export const signedText = (m: Pick<Manifest, 'build' | 'sha256' | 'size'>) => `landed-mac\n${m.build}\n${m.sha256}\n${m.size}`

export function signatureValid(m: Manifest, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(signedText(m)), createPublicKey(publicKeyPem), Buffer.from(m.signature, 'base64'))
  } catch {
    return false
  }
}

/** Build ids start with their UTC time, so newer sorts later. */
export const isNewer = (candidate: string, current: string) => candidate.slice(0, 16) > current.slice(0, 16)

export type UpdateDeps = {
  fetch: typeof fetch
  log: (message: string) => void
  /** where the new app goes (default: the installed one, found on disk) */
  target?: () => string
  /** quit the running menu-bar app, register and open the new one */
  quitApp?: () => void
  register?: (app: string) => void
  relaunch?: (app: string) => void
  notify?: (message: string) => void
  unzip?: (zip: string, into: string) => void
  workDir?: string
}

/** Where Landed.app is installed: the copy the menu bar is running from
 *  (unless macOS runs it from a randomized "translocated" path), else the
 *  one Spotlight knows, else /Applications or ~/Applications. */
export function installedAppPath(): string {
  const real = (p: string) => p && !p.includes('/AppTranslocation/') && !p.includes('/.landed/') && !p.includes('/.Trash/')
  try {
    const running = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).find((l) => l.endsWith('Landed.app/Contents/MacOS/Landed'))
    const app = running?.replace(/\/Contents\/MacOS\/Landed$/, '')
    if (app && real(app) && existsSync(app)) return app
  } catch { /* ps unavailable */ }
  try {
    const found = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter((p) => p.endsWith('.app') && real(p) && existsSync(p))
    const preferred = found.find((p) => p.startsWith('/Applications/')) ?? found.find((p) => p.startsWith(join(homedir(), 'Applications'))) ?? found[0]
    if (preferred) return preferred
  } catch { /* Spotlight off */ }
  return existsSync('/Applications') ? '/Applications/Landed.app' : join(homedir(), 'Applications', 'Landed.app')
}

const defaults = {
  quitApp: () => { try { execFileSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { timeout: 10_000 }) } catch { /* not running */ } },
  register: (app: string) => {
    try {
      execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app])
    } catch { /* Launch Services finds it on open anyway */ }
  },
  // Its launch runs `setup`, which installs the new daemon and restarts this
  // service; --updated keeps the menu closed.
  relaunch: (app: string) => {
    spawn('/bin/sh', ['-c', `sleep 1; open -g -a "$0" --args --updated`, app], { detached: true, stdio: 'ignore' }).unref()
  },
  notify: (message: string) => {
    try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Landed"`]) } catch { /* fine */ }
  },
  unzip: (zip: string, into: string) => execFileSync('ditto', ['-x', '-k', zip, into]),
}

export type UpdateResult = 'not-installed' | 'no-release' | 'up-to-date' | 'bad-signature' | 'bad-download' | 'updated'

/** Check once; install a newer, correctly signed build. */
export async function checkForUpdate(server: string, installed: Installed, deps: UpdateDeps): Promise<UpdateResult> {
  const base = server.replace(/\/+$/, '')
  const res = await deps.fetch(`${base}/api/downloads/landed-mac.json`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) return 'no-release'
  const manifest = parseManifest(await res.json().catch(() => null))
  if (!manifest) return 'no-release'
  if (!isNewer(manifest.build, installed.build)) return 'up-to-date'
  if (!signatureValid(manifest, installed.publicKey)) {
    deps.log(`update ${manifest.build} is not signed with this install's key — not installing it`)
    return 'bad-signature'
  }

  const zipRes = await deps.fetch(`${base}/api/downloads/landed-mac.zip`, { signal: AbortSignal.timeout(5 * 60_000) })
  const zip = Buffer.from(await zipRes.arrayBuffer())
  if (!zipRes.ok || zip.length !== manifest.size || createHash('sha256').update(zip).digest('hex') !== manifest.sha256) {
    deps.log(`update ${manifest.build}: the download doesn't match its manifest — not installing it`)
    return 'bad-download'
  }

  const work = join(deps.workDir ?? join(home(), 'updates'), manifest.build)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true, mode: 0o700 })
  try {
    const zipPath = join(work, 'Landed-mac.zip')
    writeFileSync(zipPath, zip)
    ;(deps.unzip ?? defaults.unzip)(zipPath, join(work, 'unpacked'))
    const fresh = join(work, 'unpacked', 'Landed.app')
    const freshBuild = JSON.parse(readFileSync(join(fresh, 'Contents', 'Resources', 'build.json'), 'utf8')) as { build?: unknown }
    if (freshBuild.build !== manifest.build) {
      deps.log(`update ${manifest.build}: the app inside is ${String(freshBuild.build)} — not installing it`)
      return 'bad-download'
    }

    const target = (deps.target ?? installedAppPath)()
    ;(deps.quitApp ?? defaults.quitApp)()
    mkdirSync(dirname(target), { recursive: true })
    const old = `${target}.old`
    rmSync(old, { recursive: true, force: true })
    if (existsSync(target)) renameSync(target, old)
    try {
      renameSync(fresh, target)
    } catch (e) {
      if (existsSync(old)) renameSync(old, target) // put the previous one back
      throw e
    }
    rmSync(old, { recursive: true, force: true })
    ;(deps.register ?? defaults.register)(target)
    deps.log(`installed Landed ${manifest.version} (${manifest.build}) at ${target}; restarting`)
    ;(deps.notify ?? defaults.notify)(`Landed updated to ${manifest.version}`)
    ;(deps.relaunch ?? defaults.relaunch)(target)
    return 'updated'
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** In the background service: check shortly after start, then every 6 hours. */
export function startUpdater(server: () => string | null, log: (message: string) => void): () => void {
  const installed = installedBuild()
  if (!installed || process.platform !== 'darwin' || process.env.LANDED_NO_UPDATES === '1') return () => {}
  let busy = false
  const check = async () => {
    const url = server()
    if (!url || busy) return
    busy = true
    try {
      const result = await checkForUpdate(url, installed, { fetch, log })
      if (result !== 'up-to-date' && result !== 'no-release') log(`update check: ${result}`)
    } catch (e) {
      log(`update check failed: ${(e as Error).message}`)
    } finally {
      busy = false
    }
  }
  const first = setTimeout(check, FIRST_CHECK_MS)
  const timer = setInterval(check, CHECK_EVERY_MS)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
