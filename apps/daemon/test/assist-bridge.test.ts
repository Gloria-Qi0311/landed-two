import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  assistCommandsDir, assistSessionsDir, sanitizeSnapshot, takeAssistCommands, writeAssistSession,
} from '../src/assist-bridge.ts'

const roots: string[] = []
afterEach(() => {
  delete process.env.LANDED_HOME
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const useHome = () => {
  const root = mkdtempSync(join(tmpdir(), 'landed-assist-'))
  roots.push(root)
  process.env.LANDED_HOME = root
  return root
}

test('browser snapshots keep page and resume metadata, never resume contents', () => {
  const snapshot = sanitizeSnapshot({
    session_id: 'browser-1',
    browser: 'Google Chrome',
    tabs: [
      { id: 7, title: 'Apply', url: 'https://jobs.example/apply', active: true },
      { id: 8, title: 'Settings', url: 'chrome://settings', active: false },
    ],
    resumes: [{ id: 'r1', name: 'PM', is_current: true, created_at: '2026-10-14', parsed_json: { email: 'private' } }],
  })
  assert.deepEqual(snapshot, {
    session_id: 'browser-1',
    browser: 'Google Chrome',
    tabs: [{ id: 7, title: 'Apply', url: 'https://jobs.example/apply', active: true }],
    resumes: [{ id: 'r1', name: 'PM', is_current: true, created_at: '2026-10-14' }],
  })
})

test('menu commands are claimed only by their browser session', () => {
  useHome()
  mkdirSync(assistCommandsDir(), { recursive: true })
  writeFileSync(join(assistCommandsDir(), 'one.json'), JSON.stringify({
    type: 'assist_fill', command_id: 'c1', session_id: 'browser-1', tab_ids: [3, 3, 4, -1], resume_id: 'r1',
  }))
  writeFileSync(join(assistCommandsDir(), 'two.json'), JSON.stringify({
    type: 'assist_fill', command_id: 'c2', session_id: 'browser-2', tab_ids: [9], resume_id: 'r2',
  }))
  assert.deepEqual(takeAssistCommands('browser-1'), [{
    type: 'assist_fill', command_id: 'c1', session_id: 'browser-1', tab_ids: [3, 4], resume_id: 'r1',
  }])
  assert.deepEqual(takeAssistCommands('browser-1'), [])
  assert.equal(takeAssistCommands('browser-2')[0].command_id, 'c2')
})

test('session files are private and contain the live menu state', () => {
  useHome()
  writeAssistSession({
    session_id: 'browser-1', browser: 'Brave', tabs: [], resumes: [],
    connected_at: '2026-10-14T00:00:00.000Z', last_seen: '2026-10-14T00:00:01.000Z',
    ollama_ready: true, ollama_model: 'qwen3.5:4b', last_result: null,
  })
  const stored = JSON.parse(readFileSync(join(assistSessionsDir(), 'browser-1.json'), 'utf8'))
  assert.equal(stored.browser, 'Brave')
  assert.equal(stored.ollama_model, 'qwen3.5:4b')
})
