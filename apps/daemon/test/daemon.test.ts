import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHROME_READ_TOOLS, chatWithHistory, chromeFromInit, claudeChatArgs, claudeEmailArgs, claudePortalArgs, claudeParseArgs, claudeResumeArgs, claudeSearchArgs, emailPrompt, mailServer, mergePrompt, tailorPrompt,
  parseClaudeLine, parseMcpList, portalPrompt, readOnlyMailTools, searchPrompt, toolReferences,
} from '../src/agents.ts'
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

test('job search: structured result becomes done + jobs; the result tool is not a step', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"server_tool_use","name":"WebSearch"},{"type":"tool_use","name":"StructuredOutput","input":{}}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"summary":"找到 1 个","jobs":[{"company":"Acme","title":"APM","job_url":"https://x.test/1"}]}}',
  ]
  assert.deepEqual(lines.flatMap(parseClaudeLine), [
    { type: 'tool', name: 'WebSearch' },
    { type: 'done', text: '找到 1 个', session_id: undefined, jobs: [{ company: 'Acme', title: 'APM', job_url: 'https://x.test/1' }] },
  ])
})

test('job search args + prompt: web tools only, no saved session, schema-bound output', () => {
  const args = claudeSearchArgs()
  assert.deepEqual(args.slice(args.indexOf('--tools') + 1, args.indexOf('--allowedTools')), ['WebSearch', 'WebFetch'])
  assert.ok(args.includes('--no-session-persistence'))
  assert.ok(!args.includes('--resume') && !args.includes('--session-id'))
  assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).required.join(), 'summary,jobs')
  const prompt = searchPrompt({ roles: ['AI Product Manager'], locations: [], needs_sponsorship: true, exclude_companies: ['Initech'] }, new Date('2026-10-11T12:00:00Z'))
  assert.match(prompt, /Roles: AI Product Manager/)
  assert.match(prompt, /Locations: anywhere/)
  assert.match(prompt, /Needs visa sponsorship: yes/)
  assert.match(prompt, /Companies to exclude: Initech/)
  assert.match(prompt, /Today is 2026-10-11/)
})

test('chat and search switch off every MCP server', () => {
  assert.ok(claudeChatArgs('11111111-2222-4333-8444-555555555555', false).includes('--strict-mcp-config'))
  assert.ok(claudeSearchArgs().includes('--strict-mcp-config'))
})

test('mail access: only a connected mail server, only its read tools', () => {
  const list = [
    'Checking MCP server health…', '',
    'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected',
    'claude.ai Gmail: https://gmail.mcp.example/mcp - ✔ Connected',
    'claude.ai Outlook: https://outlook.example/mcp - ! Needs authentication',
  ].join('\n')
  const servers = parseMcpList(list)
  assert.deepEqual(servers.map((s) => [s.name, s.connected]), [['claude.ai Google Drive', true], ['claude.ai Gmail', true], ['claude.ai Outlook', false]])
  assert.deepEqual(mailServer(servers), { name: 'claude.ai Gmail', keyword: 'gmail' })
  assert.equal(mailServer([{ name: 'claude.ai Gmail', connected: false }, { name: 'Mailchimp', connected: true }]), null)

  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [
    'search_threads', 'get_thread', 'list_labels', 'create_draft', 'send_message', 'modify_thread_labels', 'batch_get',
  ].map((n) => ({ type: 'tool_reference', tool_name: `mcp__claude_ai_Gmail__${n}` })).concat([{ type: 'tool_reference', tool_name: 'mcp__claude_ai_Google_Drive__search_files' }]) }] } })
  assert.deepEqual(readOnlyMailTools('claude.ai Gmail', toolReferences(line)), [
    'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_labels',
  ])
  assert.deepEqual(toolReferences('not json'), [])
})

test('email check: mailbox read tools only (+ ToolSearch); findings come back as done.findings', () => {
  const args = claudeEmailArgs({ server: 'claude.ai Gmail', label: 'Gmail', tools: ['mcp__claude_ai_Gmail__search_threads'] })
  assert.deepEqual(args.slice(args.indexOf('--tools') + 1, args.indexOf('--allowedTools')), ['ToolSearch'], 'no web, files or shell')
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--setting-sources')), ['ToolSearch', 'mcp__claude_ai_Gmail__search_threads'])
  assert.match(emailPrompt({ since: '2026-10-01T00:00:00.000Z', applications: [{ company: 'Figma', role: 'APM', stage: 'applied' }] }), /since 2026-10-01[\s\S]*- Figma — APM \(applied\)/)
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"summary":"1 update","findings":[{"company":"Figma","status":"assessment"}]}}'), [
    { type: 'done', text: '1 update', session_id: undefined, findings: [{ company: 'Figma', status: 'assessment' }] },
  ])
})

test('portal check: Chrome only, read-only by construction', () => {
  const args = claudePortalArgs()
  assert.ok(args.includes('--chrome') && args.includes('--strict-mcp-config'), 'Claude in Chrome and no other MCP server')
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
  assert.deepEqual(allowed, ['ToolSearch', ...CHROME_READ_TOOLS])
  for (const t of ['computer', 'form_input', 'javascript_tool', 'file_upload', 'browser_batch']) {
    assert.ok(!allowed.some((a) => a.endsWith(`__${t}`)), `${t} is not allowed`)
  }
  const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--setting-sources'))
  assert.ok(denied.includes('mcp__claude-in-chrome__computer') && denied.includes('mcp__claude-in-chrome__form_input'))
  assert.match(portalPrompt([{ ref: '1', company: 'Databricks', role: 'APM', stage: 'applied', url: 'https://x.wd1.myworkdayjobs.com/j' }]), /1\. Databricks — APM \(Landed has it at "applied"\)\. Job link: https:/)
  assert.equal(chromeFromInit({ mcp_servers: [{ name: 'claude-in-chrome', status: 'connected' }] }), true)
  assert.equal(chromeFromInit({ mcp_servers: [{ name: 'claude-in-chrome', status: 'failed' }] }), false)
  assert.equal(chromeFromInit(null), false)
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"summary":"ok","results":[{"ref":"1","outcome":"login_required"}]}}'), [
    { type: 'done', text: 'ok', session_id: undefined, results: [{ ref: '1', outcome: 'login_required' }] },
  ])
})

test('resume merge/tailor: text-only (no MCP, no tools); tailoring reads the posting only when asked', () => {
  const merge = claudeResumeArgs('resume_merge')
  assert.equal(merge[merge.indexOf('--tools') + 1], '')
  assert.ok(merge.includes('--strict-mcp-config') && !merge.includes('--allowedTools'))
  assert.ok(JSON.parse(merge[merge.indexOf('--json-schema') + 1]).required.includes('entries'))
  const tailorWeb = claudeResumeArgs('resume_tailor', { web: true })
  assert.deepEqual(tailorWeb.slice(tailorWeb.indexOf('--allowedTools') + 1, tailorWeb.indexOf('--allowedTools') + 2), ['WebFetch'])
  assert.equal(claudeResumeArgs('resume_tailor')[claudeResumeArgs('resume_tailor').indexOf('--tools') + 1], '')
  assert.match(mergePrompt({ sources: [{ id: 'r1', name: 'PM', resume: { a: 1 } }], master: { entries: [] } }), /resume id "r1" \(PM\)[\s\S]*current master/)
  assert.match(tailorPrompt({ master: {}, target: { role: 'APM', company: 'Figma', job_url: null, jd_text: 'Build AI' } }), /Target role: APM at Figma[\s\S]*Build AI/)
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"{}","structured_output":{"entries":[]}}'), [
    { type: 'done', text: '', session_id: undefined, output: { entries: [] } },
  ])
})

test('resume parse: the agent may read that one file and nothing else', () => {
  const withFile = claudeParseArgs('/Users/me/.landed/workspace/uploads/t1/resume.pdf')
  assert.deepEqual(withFile.slice(withFile.indexOf('--tools'), withFile.indexOf('--strict-mcp-config')), [
    '--tools', 'Read', '--allowedTools', 'Read(//Users/me/.landed/workspace/uploads/t1/resume.pdf)',
  ])
  const text = claudeParseArgs(null)
  assert.equal(text[text.indexOf('--tools') + 1], '')
  assert.ok(!text.includes('--allowedTools'))
})

test('chat: an old conversation on a computer without its session gets the history', () => {
  assert.equal(chatWithHistory([], 'hi'), 'hi')
  const text = chatWithHistory([{ role: 'user', text: 'AI PM roles in the US?' }, { role: 'agent', text: 'Do you need sponsorship?' }], 'Yes, H-1B')
  assert.match(text, /User: AI PM roles in the US\?[\s\S]*You \(the assistant\): Do you need sponsorship\?[\s\S]*Yes, H-1B$/)
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
