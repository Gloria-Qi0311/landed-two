import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeChatArgs, parseClaudeLine } from '../src/agents.ts'
import { coalesce, createSseParser } from '../src/connection.ts'

test('parses Claude Code stream-json into task events', () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"po"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"},{"type":"server_tool_use","name":"WebSearch"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"s1"}',
    'not json',
  ]
  assert.deepEqual(lines.flatMap(parseClaudeLine), [
    { type: 'delta', text: 'po' },
    { type: 'tool', name: 'WebSearch' },
    { type: 'done', text: 'pong', session_id: 's1' },
  ])
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true}'), [
    { type: 'error', message: 'error_max_turns' },
  ])
})

test('chat args: new sessions are created, later turns resume; only web tools', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const first = claudeChatArgs(id, false)
  assert.deepEqual(first.slice(first.indexOf('--session-id'), first.indexOf('--session-id') + 2), ['--session-id', id])
  assert.ok(claudeChatArgs(id, true).includes('--resume'))
  const tools = first.slice(first.indexOf('--tools') + 1, first.indexOf('--allowedTools'))
  assert.deepEqual(tools, ['WebSearch', 'WebFetch'])
  assert.equal(first[first.indexOf('--setting-sources') + 1], '', "ignores the user's own settings and hooks")
})

test('SSE parser handles split chunks, comments and multi-line data', () => {
  const parse = createSseParser()
  assert.deepEqual(parse('event: ready\ndata: {}\n\n: ping\n\nevent: job\ndata: {"id"'), [{ event: 'ready', data: '{}' }])
  assert.deepEqual(parse(':"x"}\n\ndata: a\ndata: b\n\n'), [{ event: 'job', data: '{"id":"x"}' }, { event: 'message', data: 'a\nb' }])
})

test('coalesce merges consecutive deltas only', () => {
  assert.deepEqual(coalesce([
    { type: 'started', agent: 'claude' }, { type: 'delta', text: 'a' }, { type: 'delta', text: 'b' },
    { type: 'tool', name: 'WebSearch' }, { type: 'delta', text: 'c' },
  ]), [{ type: 'started', agent: 'claude' }, { type: 'delta', text: 'ab' }, { type: 'tool', name: 'WebSearch' }, { type: 'delta', text: 'c' }])
})
