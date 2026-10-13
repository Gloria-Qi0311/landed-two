#!/usr/bin/env node
// A tiny ACP agent for tests. FAKE_ACP_MODE picks what it does in a turn:
//   json     — searches the web (allowed), then answers with a ```json block
//   chat     — streams a plain answer
//   ask      — asks permission to run a command, reports what it was told
//   rogue    — runs a command without asking
//   noweb    — answers with JSON without searching
//   auth     — refuses to open a session (not signed in)
//   prose    — first answer has no JSON; answers JSON when asked again
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_ACP_MODE ?? 'json'
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
let nextId = 1000
const waiting = new Map()
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }) })
let turns = 0

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line)
  if (msg.id !== undefined && msg.method === undefined) return waiting.get(msg.id)?.(msg.result ?? msg.error)
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: 'fake', version: '9.9.9' }, authMethods: [] } })
  }
  if (method === 'session/new') {
    if (mode === 'auth') return send({ id, error: { code: -32000, message: 'Authentication required' } })
    if (params.mcpServers.length !== 0 || !params.cwd) return send({ id, error: { code: -32602, message: 'unexpected session params' } })
    return send({ id, result: { sessionId: 'sess-1' } })
  }
  if (method === 'session/cancel') return
  if (method === 'session/prompt') {
    const s = params.sessionId
    turns++
    if (mode === 'json' || mode === 'noweb') {
      if (mode === 'json') {
        update(s, { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Searching the web', kind: 'search', status: 'pending' })
        const answer = await ask('session/request_permission', {
          sessionId: s, toolCall: { toolCallId: 'w1', kind: 'search', title: 'Searching the web' },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        })
        if (answer?.outcome?.optionId !== 'yes') return send({ id, error: { code: -32603, message: 'search was refused' } })
        update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed' })
      }
      say(s, 'Here you go:\n```json\n{"summary": "found one", "jobs": [{"company": "Blorp", "title": "Engineer", "job_url": "https://blorp.example/jobs/1"}]}\n```')
      return send({ id, result: { stopReason: 'end_turn' } })
    }
    if (mode === 'chat') {
      say(s, 'Hello ')
      say(s, 'there.')
      return send({ id, result: { stopReason: 'end_turn' } })
    }
    if (mode === 'ask') {
      update(s, { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'ls ~', kind: 'execute', status: 'pending' })
      const answer = await ask('session/request_permission', {
        sessionId: s, toolCall: { toolCallId: 'x1', kind: 'execute', title: 'ls ~' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'x1', status: 'failed' })
      say(s, `told: ${answer?.outcome?.optionId ?? answer?.outcome?.outcome}`)
      return send({ id, result: { stopReason: 'end_turn' } })
    }
    if (mode === 'rogue') {
      update(s, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'rm -rf something', kind: 'execute', status: 'in_progress' })
      setTimeout(() => { say(s, 'done'); send({ id, result: { stopReason: 'end_turn' } }) }, 300)
      return
    }
    if (mode === 'prose') {
      say(s, turns === 1 ? 'I found a role at Blorp.' : '```json\n{"summary": "ok", "jobs": []}\n```')
      return send({ id, result: { stopReason: 'end_turn' } })
    }
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } })
})
