// One-click Codex connector setup, invoked by Landed.app after the user
// approves a landed://connect-agent link. Use Codex's own CLI instead of
// editing config.toml: it owns the shared desktop/CLI/IDE config and the
// OAuth callback listener.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

type RunResult = Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>
export type CodexRunner = (executable: string, args: string[]) => RunResult

const runCodex: CodexRunner = (executable, args) => spawnSync(executable, args, {
  encoding: 'utf8',
  timeout: 10 * 60_000,
  maxBuffer: 1024 * 1024,
})

/** Find the CLI whether Codex was installed in PATH or bundled with the
 * desktop app. The desktop bundle path is not normally in launchd's PATH. */
export function findCodex(path = process.env.PATH ?? ''): string | null {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, 'codex')),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate))]
    .find((candidate) => existsSync(candidate)) ?? null
}

function output(result: RunResult): string {
  if (result.error) return result.error.message
  return `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
}

type ExistingConnector = {
  transport?: { type?: string; url?: string }
}

function existingConnector(executable: string, run: CodexRunner): { exists: boolean; url: string | null } {
  const result = run(executable, ['mcp', 'get', 'landed', '--json'])
  if (result.status !== 0) return { exists: false, url: null }
  try {
    const entry = JSON.parse(result.stdout) as ExistingConnector
    const url = entry.transport?.type === 'streamable_http' && typeof entry.transport.url === 'string'
      ? entry.transport.url
      : null
    return { exists: true, url }
  } catch {
    return { exists: true, url: null }
  }
}

export function existingLandedUrl(executable: string, run: CodexRunner = runCodex): string | null {
  return existingConnector(executable, run).url
}

export type CodexConnectResult =
  | { ok: true; replaced: boolean }
  | { ok: false; error: string }

/** Register Landed and run Codex's OAuth flow. If an older Landed URL is
 * replaced and add fails, restore it best-effort instead of leaving Codex
 * with no connector. */
export function connectCodex(
  executable: string,
  url: string,
  run: CodexRunner = runCodex,
): CodexConnectResult {
  const existing = existingConnector(executable, run)
  const previous = existing.url
  if (existing.exists && !previous) {
    return { ok: false, error: 'Codex already has a non-HTTP connector named "landed". Rename or remove that connector, then try again.' }
  }
  const replacing = !!previous && previous !== url

  if (!previous || replacing) {
    if (previous) {
      const removed = run(executable, ['mcp', 'remove', 'landed'])
      if (removed.status !== 0) {
        return { ok: false, error: `Codex couldn't replace its old Landed connector: ${output(removed) || 'remove failed'}` }
      }
    }

    const added = run(executable, ['mcp', 'add', 'landed', '--url', url])
    if (added.status !== 0) {
      if (previous) run(executable, ['mcp', 'add', 'landed', '--url', previous])
      return { ok: false, error: `Codex couldn't add Landed: ${output(added) || 'add failed'}` }
    }
  }

  const login = run(executable, ['mcp', 'login', 'landed'])
  if (login.status !== 0) {
    return { ok: false, error: `Codex couldn't finish signing in to Landed: ${output(login) || 'login failed'}` }
  }
  return { ok: true, replaced: replacing }
}
