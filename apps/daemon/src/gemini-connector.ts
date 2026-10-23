// One-click Gemini CLI connector setup, invoked by Landed.app after the user
// approves a landed://connect-agent link. Gemini owns the server entry; Landed
// adds the OAuth opt-in that makes Gemini open the browser on its next start.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'

type RunResult = Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>
export type GeminiRunner = (executable: string, args: string[]) => RunResult

const runGemini: GeminiRunner = (executable, args) => spawnSync(executable, args, {
  encoding: 'utf8',
  timeout: 2 * 60_000,
  maxBuffer: 1024 * 1024,
})

export function findGemini(path = process.env.PATH ?? ''): string | null {
  const candidates = [
    process.env.GEMINI_CLI_PATH,
    ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, 'gemini')),
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
    join(homedir(), '.local', 'bin', 'gemini'),
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate))]
    .find((candidate) => existsSync(candidate)) ?? null
}

const defaultSettingsPath = () => join(homedir(), '.gemini', 'settings.json')

type GeminiSettings = {
  mcpServers?: Record<string, {
    url?: string
    httpUrl?: string
    type?: string
  }>
}

function readSettings(path: string): GeminiSettings {
  if (!existsSync(path)) return {}
  const errors: ParseError[] = []
  const settings = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true }) as GeminiSettings | undefined
  if (!settings || errors.length) throw new Error(`Gemini settings are not valid JSON (${path}).`)
  return settings
}

export function existingGeminiLandedUrl(path = defaultSettingsPath()): string | null {
  const entry = readSettings(path).mcpServers?.landed
  if (!entry) return null
  if (typeof entry.httpUrl === 'string') return entry.httpUrl
  return typeof entry.url === 'string' && (!entry.type || entry.type === 'http') ? entry.url : null
}

function enableAutomaticOAuth(path: string) {
  const source = readFileSync(path, 'utf8')
  const updated = applyEdits(source, modify(source, ['mcpServers', 'landed', 'oauth', 'enabled'], true, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }))
  const dir = dirname(path)
  const temporary = join(dir, `.settings.json.landed-${process.pid}`)
  const mode = statSync(path).mode & 0o777
  try {
    writeFileSync(temporary, updated, { mode })
    renameSync(temporary, path)
    chmodSync(path, mode)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function output(result: RunResult): string {
  if (result.error) return result.error.message
  return `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
}

export type GeminiConnectResult =
  | { ok: true; replaced: boolean }
  | { ok: false; error: string }

/** Add a user-scoped HTTP server with Gemini's CLI, then opt it into the CLI's
 * automatic OAuth flow. Restore the exact settings file if the second step
 * fails, so a click never leaves a half-configured connector. */
export function connectGemini(
  executable: string,
  url: string,
  options: { run?: GeminiRunner; settingsPath?: string } = {},
): GeminiConnectResult {
  const run = options.run ?? runGemini
  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  let existing: string | null
  try {
    const settings = readSettings(settingsPath)
    const entry = settings.mcpServers?.landed
    existing = existingGeminiLandedUrl(settingsPath)
    if (entry && !existing) {
      return { ok: false, error: 'Gemini CLI already has a non-HTTP connector named "landed". Rename or remove that connector, then try again.' }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Gemini settings could not be read.' }
  }

  const hadSettings = existsSync(settingsPath)
  const previousSettings = hadSettings ? readFileSync(settingsPath, 'utf8') : null
  const added = run(executable, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'landed', url])
  if (added.status !== 0) {
    return { ok: false, error: `Gemini CLI couldn't add Landed: ${output(added) || 'add failed'}` }
  }

  try {
    enableAutomaticOAuth(settingsPath)
  } catch (error) {
    try {
      if (previousSettings === null) rmSync(settingsPath, { force: true })
      else {
        mkdirSync(dirname(settingsPath), { recursive: true })
        writeFileSync(settingsPath, previousSettings)
      }
    } catch {
      // The actionable error is the configuration failure below.
    }
    return { ok: false, error: `Gemini CLI added Landed but automatic sign-in could not be enabled: ${error instanceof Error ? error.message : 'settings update failed'}` }
  }

  return { ok: true, replaced: !!existing && existing !== url }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
const appleString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export type ScriptRunner = (executable: string, args: string[]) => RunResult
const runScript: ScriptRunner = (executable, args) => spawnSync(executable, args, { encoding: 'utf8' })

/** Gemini performs MCP discovery at startup. With oauth.enabled set, this
 * opens Landed's browser consent automatically; Terminal stays open as the
 * user's normal Gemini CLI session. */
export function openGeminiForAuth(executable: string, run: ScriptRunner = runScript): string | null {
  const command = `cd ${shellQuote(homedir())}; exec ${shellQuote(executable)}`
  const script = `tell application "Terminal"\nactivate\ndo script ${appleString(command)}\nend tell`
  const result = run('/usr/bin/osascript', ['-e', script])
  return result.status === 0 ? null : output(result) || 'Terminal could not be opened.'
}
