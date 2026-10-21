import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectCodex, existingLandedUrl, type CodexRunner } from '../src/codex-connector.ts'

const result = (status: number, stdout = '', stderr = '') => ({ status, stdout, stderr, error: undefined })

test('Codex connector: add then start OAuth login', () => {
  const calls: string[][] = []
  const run: CodexRunner = (_executable, args) => {
    calls.push(args)
    if (args[1] === 'get') return result(1)
    return result(0)
  }
  assert.deepEqual(connectCodex('/codex', 'https://landed.example.com/mcp', run), { ok: true, replaced: false })
  assert.deepEqual(calls, [
    ['mcp', 'get', 'landed', '--json'],
    ['mcp', 'add', 'landed', '--url', 'https://landed.example.com/mcp'],
    ['mcp', 'login', 'landed'],
  ])
})

test('Codex connector: keep the same URL and sign in again', () => {
  const calls: string[][] = []
  const run: CodexRunner = (_executable, args) => {
    calls.push(args)
    if (args[1] === 'get') return result(0, JSON.stringify({ transport: { type: 'streamable_http', url: 'https://landed.example.com/mcp' } }))
    return result(0)
  }
  assert.equal(existingLandedUrl('/codex', run), 'https://landed.example.com/mcp')
  calls.length = 0
  assert.deepEqual(connectCodex('/codex', 'https://landed.example.com/mcp', run), { ok: true, replaced: false })
  assert.deepEqual(calls, [
    ['mcp', 'get', 'landed', '--json'],
    ['mcp', 'login', 'landed'],
  ])
})

test('Codex connector: replace an old URL and restore it if add fails', () => {
  const calls: string[][] = []
  const run: CodexRunner = (_executable, args) => {
    calls.push(args)
    if (args[1] === 'get') return result(0, JSON.stringify({ transport: { type: 'streamable_http', url: 'https://old.example.com/mcp' } }))
    if (args[1] === 'add' && args.at(-1) === 'https://new.example.com/mcp') return result(1, '', 'bad URL')
    return result(0)
  }
  const connected = connectCodex('/codex', 'https://new.example.com/mcp', run)
  assert.equal(connected.ok, false)
  assert.match(connected.ok ? '' : connected.error, /bad URL/)
  assert.deepEqual(calls, [
    ['mcp', 'get', 'landed', '--json'],
    ['mcp', 'remove', 'landed'],
    ['mcp', 'add', 'landed', '--url', 'https://new.example.com/mcp'],
    ['mcp', 'add', 'landed', '--url', 'https://old.example.com/mcp'],
  ])
})

test('Codex connector: do not overwrite a different connector with the same name', () => {
  const calls: string[][] = []
  const run: CodexRunner = (_executable, args) => {
    calls.push(args)
    return result(0, JSON.stringify({ transport: { type: 'stdio', command: 'landed-mcp' } }))
  }
  const connected = connectCodex('/codex', 'https://landed.example.com/mcp', run)
  assert.equal(connected.ok, false)
  assert.match(connected.ok ? '' : connected.error, /non-HTTP/)
  assert.deepEqual(calls, [['mcp', 'get', 'landed', '--json']])
})
