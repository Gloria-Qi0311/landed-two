import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
// @ts-expect-error plain .mjs build script, no types
import { bundleDaemon } from '../scripts/bundle.mjs'

test('the bundled daemon Landed.app ships loads every module', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'landed-bundle-'))
  try {
    const file = join(dir, 'landed-daemon.mjs')
    await bundleDaemon(file)
    // An unknown command exits after every module has loaded, without touching
    // this computer.
    const run = spawnSync(process.execPath, [file, 'no-such-command'], { encoding: 'utf8', env: { ...process.env, HOME: dir } })
    assert.doesNotMatch(run.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/)
    assert.match(run.stderr, /Unknown command "no-such-command"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
