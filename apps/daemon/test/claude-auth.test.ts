import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const landedHome = mkdtempSync(join(tmpdir(), 'landed-claude-auth-'))
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const oldPath = process.env.PATH
process.env.LANDED_HOME = landedHome
process.env.PATH = `${fixtures}${delimiter}${oldPath ?? ''}`
process.env.FAKE_CLAUDE_AUTH = 'false'

const config = await import('../src/config.ts')
const agents = await import('../src/agents.ts')

test('cached Gmail never hides sign-out; a later capability pass restores it after login', async (t) => {
  t.after(() => {
    process.env.PATH = oldPath
    delete process.env.FAKE_CLAUDE_AUTH
    rmSync(landedHome, { recursive: true, force: true })
  })

  config.saveMailCache({
    server: 'claude.ai Gmail', label: 'Gmail',
    tools: ['mcp__claude_ai_Gmail__search_threads'],
    denied: ['mcp__claude_ai_Gmail__send_message'],
  })

  const signedOut = await agents.detectAgents({ quick: true })
  const claude = signedOut.find((a) => a.id === 'claude')!
  assert.deepEqual(claude, {
    id: 'claude', label: 'Claude Code', version: '2.1.999 (Claude Code)',
    kinds: ['automation_sync'], mail: null, browser: null, auth: 'signed_out',
  })
  assert.match(agents.detectionNotes.join('\n'), /claude auth login/)

  const events: import('../src/types.ts').TaskEvent[] = []
  await agents.runTask({
    id: 'email-1', agent: 'claude', kind: 'email_check',
    input: { since: '2026-10-01T00:00:00.000Z', applications: [] },
  }, (event) => events.push(event))
  assert.equal(events.at(-1)?.type, 'error')
  assert.match((events.at(-1) as { message: string }).message, /claude auth login/)

  // The daemon performs the same detection every 30 minutes. Once login is
  // healthy, the safe cached tool list makes email checks available again.
  process.env.FAKE_CLAUDE_AUTH = 'true'
  const recovered = await agents.detectAgents({ quick: true })
  const recoveredClaude = recovered.find((a) => a.id === 'claude')!
  assert.ok(recoveredClaude.kinds.includes('email_check'))
  assert.equal(recoveredClaude.mail, 'Gmail')
  assert.equal(recoveredClaude.auth, undefined)
})
