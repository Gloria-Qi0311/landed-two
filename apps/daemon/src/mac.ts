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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { home } from './config.ts'

export const LABEL = 'dev.landed.daemon'
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

/** Install (or refresh) the background service and start it. */
export function installService(opts: { dryRun?: boolean } = {}): { plist: string; script: string } {
  const self = realpathSync(process.argv[1])
  // Bundled (Landed.app): keep our own copy, so moving or deleting the app
  // doesn't break the service. From source (the repo): run the source.
  let script = self
  if (self.endsWith('.mjs')) {
    const bin = join(home(), 'bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    script = join(bin, 'landed-daemon.mjs')
    if (self !== script) copyFileSync(self, script)
  }
  mkdirSync(agentsDir(), { recursive: true })
  const plist = launchAgentPlist({ node: stableNode(), script, path: servicePath(), logFile: join(home(), 'daemon.log') })
  writeFileSync(plistPath(), plist)
  if (!opts.dryRun) {
    launchctl('bootout', `${domain()}/${LABEL}`) // fine if it wasn't loaded
    const r = launchctl('bootstrap', domain(), plistPath())
    if (r.status !== 0 && !/already/i.test(r.stderr)) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`)
  }
  return { plist: plistPath(), script }
}

export function uninstallService() {
  launchctl('bootout', `${domain()}/${LABEL}`)
  rmSync(plistPath(), { force: true })
}

export const serviceInstalled = () => existsSync(plistPath())

/** Restart the service (e.g. after a new pairing). */
export function restartService() {
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
