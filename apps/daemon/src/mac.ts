// macOS: run the daemon as a background service and pair it from the
// browser, so connecting a computer takes a click instead of a terminal.
//
//   Landed.app (scripts/build-mac.mjs) — an AppleScript applet that owns the
//   landed:// URL scheme and carries the bundled daemon. Opening it once runs
//   `setup`: a LaunchAgent that starts the daemon at login and restarts it.
//   "Connect this computer" in Landed opens landed://connect?server=…&token=…;
//   the app runs `open-url`, which asks the user in a native dialog (any web
//   page can open a URL, so pairing never happens without that click), saves
//   the connection and restarts the service.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { home } from './config.ts'

export const LABEL = 'dev.landed.daemon'
export const NATIVE_HOST_NAME = 'dev.landed.assist'
export const EXTENSION_ID = 'cffgejoffofpdgncoebljpidlmmmiigb'
const agentsDir = () => process.env.LANDED_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents')
export const plistPath = () => join(agentsDir(), `${LABEL}.plist`)
const domain = () => `gui/${userInfo().uid}`

/** landed://connect?server=…&token=…&name=… → what to pair with; null unless
 *  it's exactly that, with an http(s) server and a runtime token. */
export function parseConnectUrl(raw: string): { server: string; token: string; name: string | null } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'landed:' || (url.hostname || url.pathname.replace(/^\/+/, '')) !== 'connect') return null
  const server = url.searchParams.get('server') ?? ''
  const token = url.searchParams.get('token') ?? ''
  if (!/^landed_rt_[A-Za-z0-9_-]{20,}$/.test(token)) return null
  let origin: URL
  try {
    origin = new URL(server)
  } catch {
    return null
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null
  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 80) || null
  return { server: origin.origin, token, name }
}

/** landed://connect-agent?agent=codex&url=https://…/mcp. Any web page can
 * open a custom URL, so accept only the action and endpoint Landed needs;
 * cli.ts still shows a native confirmation before changing Codex. */
export function parseAgentConnectUrl(raw: string): { agent: 'codex'; url: string } | null {
  let link: URL
  try {
    link = new URL(raw)
  } catch {
    return null
  }
  if (link.protocol !== 'landed:' || (link.hostname || link.pathname.replace(/^\/+/, '')) !== 'connect-agent') return null
  if (link.searchParams.get('agent') !== 'codex') return null
  const rawUrl = link.searchParams.get('url') ?? ''
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) return null
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') return null
  return { agent: 'codex', url: url.toString() }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The LaunchAgent: start at login, restart if it stops, log to ~/.landed. */
export function launchAgentPlist(o: { node: string; script: string; path: string; logFile: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(o.script)}</string>
    <string>service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(o.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(o.logFile)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
}

/** The PATH the service runs with: the one we were started with (a login
 *  shell's, from Landed.app) plus where Node and agent CLIs usually live. */
export function servicePath(current = process.env.PATH ?? ''): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set([...current.split(':').filter(Boolean), ...extra])].join(':')
}

// LANDED_DRY_RUN=1 (tests): write files, but don't touch launchd.
const launchctl = (...args: string[]) => process.env.LANDED_DRY_RUN === '1'
  ? { status: 0, stderr: '', stdout: '' }
  : spawnSync('launchctl', args, { encoding: 'utf8' })

/** A Node path that survives upgrades: the first `node` on PATH (e.g. the
 *  /opt/homebrew/bin symlink), not the versioned Cellar path it points to. */
export function stableNode(path = process.env.PATH ?? '', fallback = process.execPath): string {
  for (const dir of path.split(':').filter(Boolean)) {
    if (existsSync(join(dir, 'node'))) return join(dir, 'node')
  }
  return fallback
}

const sh = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
const nativeWrapperPath = () => join(home(), 'bin', 'landed-native-host')
const nativeHostDirs = () => process.env.LANDED_NATIVE_HOST_DIRS
  ? process.env.LANDED_NATIVE_HOST_DIRS.split(delimiter).filter(Boolean)
  : [
      join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(homedir(), 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      join(homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      join(homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
    ]

export function nativeHostManifest(path: string) {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Landed Apply Assist local model bridge',
    path,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }
}

/** Register the bundled daemon as a Native Messaging host. Chrome starts a
 * short-lived copy for Apply Assist; the normal background service remains
 * separate and keeps its server connection. */
export function installNativeHost(node: string, script: string): string[] {
  const wrapper = nativeWrapperPath()
  mkdirSync(join(home(), 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(wrapper, `#!/bin/sh\nexec ${sh(node)} ${sh(script)} native-host\n`, { mode: 0o700 })
  chmodSync(wrapper, 0o700)
  const manifests = nativeHostDirs().map((dir) => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${NATIVE_HOST_NAME}.json`)
    writeFileSync(path, `${JSON.stringify(nativeHostManifest(wrapper), null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  })
  return manifests
}

/** Install (or refresh) the background service and start it. */
export function installService(opts: { dryRun?: boolean } = {}): { plist: string; script: string; nativeHosts: string[]; extension: string | null } {
  const self = realpathSync(process.argv[1])
  // Bundled (Landed.app): keep our own copy, so moving or deleting the app
  // doesn't break the service. From source (the repo): run the source.
  let script = self
  if (self.endsWith('.mjs')) {
    const bin = join(home(), 'bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    script = join(bin, 'landed-daemon.mjs')
    if (self !== script) {
      copyFileSync(self, script)
      // Which build this is, and the key its updates must be signed with
      // (src/updater.ts). A build without them doesn't update itself.
      for (const name of ['build.json', 'update-key.pem']) {
        const from = join(dirname(self), name)
        if (existsSync(from)) copyFileSync(from, join(bin, name))
        else rmSync(join(bin, name), { force: true })
      }
    }
  }
  const bundledExtension = join(dirname(self), 'extension')
  const installedExtension = join(home(), 'extension')
  let extension: string | null = null
  if (existsSync(bundledExtension)) {
    rmSync(installedExtension, { recursive: true, force: true })
    cpSync(bundledExtension, installedExtension, { recursive: true })
    extension = installedExtension
  }
  mkdirSync(agentsDir(), { recursive: true })
  const plist = launchAgentPlist({ node: stableNode(), script, path: servicePath(), logFile: join(home(), 'daemon.log') })
  writeFileSync(plistPath(), plist)
  const nativeHosts = installNativeHost(stableNode(), script)
  if (!opts.dryRun) reload()
  return { plist: plistPath(), script, nativeHosts, extension }
}

const loaded = () => launchctl('print', `${domain()}/${LABEL}`).status === 0
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Unload (if loaded) and load the service again. launchd finishes an unload
 *  asynchronously, and loading too soon fails ("Input/output error"), so
 *  wait for it to be gone and retry the load a few times. */
function reload() {
  if (loaded()) {
    launchctl('bootout', `${domain()}/${LABEL}`)
    for (let i = 0; i < 50 && loaded(); i++) pause(100)
  }
  let last = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = launchctl('bootstrap', domain(), plistPath())
    if (r.status === 0 || loaded()) return
    last = r.stderr.trim()
    pause(500 * (attempt + 1))
  }
  throw new Error(`Couldn't start the Landed background service (launchctl: ${last})`)
}

export function uninstallService() {
  launchctl('bootout', `${domain()}/${LABEL}`)
  rmSync(plistPath(), { force: true })
  rmSync(nativeWrapperPath(), { force: true })
  for (const dir of nativeHostDirs()) rmSync(join(dir, `${NATIVE_HOST_NAME}.json`), { force: true })
}

export const serviceInstalled = () => existsSync(plistPath())

/** Restart the service (e.g. after a new pairing); load it if it isn't. */
export function restartService() {
  if (process.env.LANDED_DRY_RUN === '1') return
  if (!loaded()) return reload()
  launchctl('kickstart', '-k', `${domain()}/${LABEL}`)
}

const osaString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** A native Connect / Cancel dialog. LANDED_ASSUME_YES=1 skips it (tests only). */
export function confirm(message: string, button = 'Connect'): boolean {
  if (process.env.LANDED_ASSUME_YES === '1') return true
  const r = spawnSync('osascript', ['-e',
    `display dialog ${osaString(message)} buttons {"Cancel", ${osaString(button)}} default button ${osaString(button)} with title "Landed" with icon note`,
  ], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.includes(button)
}

export function notify(message: string) {
  if (process.env.LANDED_ASSUME_YES === '1') return
  spawnSync('osascript', ['-e', `display notification ${osaString(message)} with title "Landed"`])
}

export function alert(message: string) {
  if (process.env.LANDED_ASSUME_YES === '1') return
  spawnSync('osascript', ['-e',
    `display alert "Landed" message ${osaString(message)} buttons {"OK"} default button "OK" as critical`,
  ])
}

export function computerName(): string | null {
  try {
    return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

// ── one daemon at a time ──────────────────────────────────────────────────
// A terminal daemon and the background service on the same config would
// both run tasks and the schedule.

const lockFile = () => join(home(), 'daemon.pid')

/** The pid of another running daemon, if any. */
export function otherDaemon(): number | null {
  try {
    const pid = Number(readFileSync(lockFile(), 'utf8'))
    if (!pid || pid === process.pid) return null
    process.kill(pid, 0) // throws if it's gone
    return pid
  } catch {
    return null
  }
}

export function takeLock() {
  mkdirSync(home(), { recursive: true, mode: 0o700 })
  writeFileSync(lockFile(), String(process.pid))
  chmodSync(lockFile(), 0o600)
  const release = () => {
    try {
      if (readFileSync(lockFile(), 'utf8') === String(process.pid)) rmSync(lockFile())
    } catch {
      // already gone
    }
  }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { release(); process.exit(0) })
}
