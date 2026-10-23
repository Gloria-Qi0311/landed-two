import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'jsonc-parser'
import { connectGemini, existingGeminiLandedUrl, openGeminiForAuth, type GeminiRunner } from '../src/gemini-connector.ts'

const result = (status: number, stdout = '', stderr = '') => ({ status, stdout, stderr, error: undefined })

test('Gemini connector: add user-scoped HTTP server and enable automatic OAuth without dropping comments', () => {
  const root = mkdtempSync(join(tmpdir(), 'landed-gemini-'))
  const settingsPath = join(root, '.gemini', 'settings.json')
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, '{\n  // Keep my theme.\n  "theme": "dark"\n}\n')
  const calls: string[][] = []
  const run: GeminiRunner = (_executable, args) => {
    calls.push(args)
    writeFileSync(settingsPath, `{
  // Keep my theme.
  "theme": "dark",
  "mcpServers": {
    "landed": { "url": "https://landed.example.com/mcp", "type": "http" }
  }
}\n`)
    return result(0)
  }
  try {
    assert.deepEqual(connectGemini('/gemini', 'https://landed.example.com/mcp', { run, settingsPath }), { ok: true, replaced: false })
    assert.deepEqual(calls, [[
      'mcp', 'add', '--scope', 'user', '--transport', 'http', 'landed', 'https://landed.example.com/mcp',
    ]])
    const saved = readFileSync(settingsPath, 'utf8')
    assert.match(saved, /Keep my theme/)
    const settings = parse(saved) as { mcpServers: { landed: { oauth: { enabled: boolean } } } }
    assert.equal(settings.mcpServers.landed.oauth.enabled, true)
    assert.equal(existingGeminiLandedUrl(settingsPath), 'https://landed.example.com/mcp')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Gemini connector: do not overwrite a different connector named landed', () => {
  const root = mkdtempSync(join(tmpdir(), 'landed-gemini-'))
  const settingsPath = join(root, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ mcpServers: { landed: { command: 'other-server' } } }))
  let called = false
  const run: GeminiRunner = () => {
    called = true
    return result(0)
  }
  try {
    const connected = connectGemini('/gemini', 'https://landed.example.com/mcp', { run, settingsPath })
    assert.equal(connected.ok, false)
    assert.match(connected.ok ? '' : connected.error, /non-HTTP/)
    assert.equal(called, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Gemini connector: Terminal starts Gemini from the home directory', () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  const error = openGeminiForAuth("/Applications/Gemini CLI/bin/gem'ini", (executable, args) => {
    calls.push({ executable, args })
    return result(0)
  })
  assert.equal(error, null)
  assert.equal(calls[0].executable, '/usr/bin/osascript')
  assert.match(calls[0].args[1], /tell application "Terminal"/)
  assert.match(calls[0].args[1], /exec '\/Applications\/Gemini CLI\/bin\/gem/)
  assert.match(calls[0].args[1], /gem'\\"'\\"'ini'/)
})
