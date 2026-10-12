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
const capabilitiesPath = () => join(home(), 'capabilities.json')

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

/** Last successful mailbox detection: claude.ai connectors don't always load,
 *  so a lookup that comes back empty falls back to what worked before. */
export type MailCache = { server: string; label: string; tools: string[] }

export function loadMailCache(): MailCache | null {
  try {
    const c = JSON.parse(readFileSync(capabilitiesPath(), 'utf8')).mail
    return c && typeof c.server === 'string' && Array.isArray(c.tools) ? c : null
  } catch {
    return null
  }
}

export function saveMailCache(mail: MailCache | null) {
  ensureHome()
  writeFileSync(capabilitiesPath(), JSON.stringify({ mail }, null, 2) + '\n')
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
