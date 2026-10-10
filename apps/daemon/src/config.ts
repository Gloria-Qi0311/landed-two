// ~/.landed — the daemon's config (server URL + runtime token), its agent
// workspace, and which conversations already have an agent session.
// LANDED_HOME overrides the location (tests).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Config = { server: string; token: string; name?: string }

export const home = () => process.env.LANDED_HOME ?? join(homedir(), '.landed')
const configPath = () => join(home(), 'config.json')
const sessionsPath = () => join(home(), 'sessions.json')

function ensureHome() {
  mkdirSync(home(), { recursive: true, mode: 0o700 })
}

export function loadConfig(): Config | null {
  if (!existsSync(configPath())) return null
  const c = JSON.parse(readFileSync(configPath(), 'utf8'))
  return typeof c.server === 'string' && typeof c.token === 'string' ? c : null
}

export function saveConfig(c: Config) {
  ensureHome()
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  chmodSync(configPath(), 0o600) // the token is a credential
}

/** Agents run here — an empty directory, never the user's projects. */
export function workspace() {
  const dir = join(home(), 'workspace')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Conversation ids that already have an agent session (so the next turn resumes it). */
export function knownSessions(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(sessionsPath(), 'utf8')))
  } catch {
    return new Set()
  }
}

export function rememberSession(id: string) {
  ensureHome()
  const s = knownSessions()
  s.add(id)
  writeFileSync(sessionsPath(), JSON.stringify([...s].slice(-1000)))
}
