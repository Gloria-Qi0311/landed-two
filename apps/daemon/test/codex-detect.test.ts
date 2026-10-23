// Codex as an agent on the computer: found where the connector finds it
// (findCodex), including the CLI inside ChatGPT.app / Codex.app that isn't
// on the PATH, so Landed can run it on the Workflow schedule.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { detectCodex } from '../src/codex.ts'

const saved = { CODEX_CLI_PATH: process.env.CODEX_CLI_PATH, PATH: process.env.PATH }
afterEach(() => {
  if (saved.CODEX_CLI_PATH === undefined) delete process.env.CODEX_CLI_PATH
  else process.env.CODEX_CLI_PATH = saved.CODEX_CLI_PATH
  process.env.PATH = saved.PATH
})

function fakeCodex(signedIn: boolean): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'codex-cli-')), 'codex')
  writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi',
    `if [ "$1" = "login" ]; then ${signedIn ? 'echo "Logged in using ChatGPT"; exit 0' : 'echo "Not logged in"; exit 1'}; fi`,
    'exit 1',
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

test('a Codex CLI that is not on the PATH (inside ChatGPT.app) is found', () => {
  process.env.CODEX_CLI_PATH = fakeCodex(true)
  process.env.PATH = '/usr/bin:/bin'
  assert.deepEqual(detectCodex(), { version: '9.9.9' })
})

test('found but signed out says so', () => {
  process.env.CODEX_CLI_PATH = fakeCodex(false)
  process.env.PATH = '/usr/bin:/bin'
  assert.deepEqual(detectCodex(), { missing: 'Codex is installed but not signed in — run `codex login` once.' })
})
