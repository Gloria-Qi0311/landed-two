import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHROME_READ_TOOLS, chatImages, chatWithContext, chatWithHistory, contextToSend, claudeImageMessage, chromeFromInit, claudeChatArgs, claudeEmailArgs, claudePortalArgs, claudeParseArgs, claudeResumeArgs, claudeSearchArgs, emailPrompt, mailServer, mergePrompt, tailorPrompt,
  initHasServer, isReadOnlyTool, mailFromInit, parseClaudeAuthStatus, parseClaudeLine, portalPrompt, readOnlyMailTools, searchPrompt,
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

test('mail access: from the init event, only a connected mail server, only its read tools', () => {
  const gmail = ['search_threads', 'get_thread', 'list_labels', 'create_draft', 'send_message', 'modify_thread_labels', 'batch_get']
    .map((n) => `mcp__claude_ai_Gmail__${n}`)
  const init = {
    type: 'system', subtype: 'init',
    mcp_servers: [
      { name: 'claude.ai Google Drive', status: 'connected' }, { name: 'claude.ai Gmail', status: 'connected' },
      { name: 'claude.ai Outlook', status: 'needs-auth' },
    ],
    tools: ['ToolSearch', ...gmail, 'mcp__claude_ai_Google_Drive__search_files'],
  }
  assert.deepEqual(mailFromInit(init), {
    status: 'ready',
    mail: {
      server: 'claude.ai Gmail', label: 'Gmail',
      tools: ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_labels'],
      denied: ['mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__modify_thread_labels', 'mcp__claude_ai_Gmail__batch_get'],
    },
  })
  // Connected but its tools didn't come through, or still connecting: not usable yet.
  assert.deepEqual(mailFromInit({ ...init, tools: ['ToolSearch'] }), { status: 'confirming', mail: null })
  assert.deepEqual(mailFromInit({ mcp_servers: [{ name: 'claude.ai Gmail', status: 'pending' }] }), { status: 'confirming', mail: null })
  // Not connected (or connectors didn't load): nothing to read.
  assert.deepEqual(mailFromInit({ mcp_servers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }, { name: 'Mailchimp', status: 'connected' }] }), { status: 'missing', mail: null })
  assert.deepEqual(mailFromInit({ mcp_servers: [] }), { status: 'missing', mail: null })
  assert.deepEqual(mailFromInit(null), { status: 'missing', mail: null })
  assert.equal(mailServer([{ name: 'claude.ai Gmail', connected: false }, { name: 'Mailchimp', connected: true }]), null)
})

test('Claude auth status: explicit sign-in/out only; unknown versions do not disable the agent', () => {
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), 'signed_in')
  assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}'), 'signed_out')
  assert.equal(parseClaudeAuthStatus('{}'), 'unknown')
  assert.equal(parseClaudeAuthStatus('not json'), 'unknown')
})

test('read-only means by words: "thread" is not "read"', () => {
  for (const t of ['search_threads', 'get_thread', 'get_message', 'list_labels', 'readMessage', 'fetch_email']) assert.ok(isReadOnlyTool(t), t)
  for (const t of ['apply_sensitive_thread_label', 'modify_thread_labels', 'create_draft', 'send_message', 'get_and_delete', 'thread_reader', 'batch_get', 'list_and_archive', 'setLabel']) {
    assert.ok(!isReadOnlyTool(t), t)
  }
})

test('email check: mailbox read tools only (+ ToolSearch); findings come back as done.findings', () => {
  const args = claudeEmailArgs({ server: 'claude.ai Gmail', label: 'Gmail', tools: ['mcp__claude_ai_Gmail__search_threads'], denied: ['mcp__claude_ai_Gmail__apply_sensitive_thread_label'] })
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--disallowedTools') + 2), ['mcp__claude_ai_Gmail__apply_sensitive_thread_label'])
  assert.deepEqual(args.slice(args.indexOf('--tools') + 1, args.indexOf('--allowedTools')), ['ToolSearch'], 'no web, files or shell')
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')), ['ToolSearch', 'mcp__claude_ai_Gmail__search_threads'])
  const prompt = emailPrompt({ since: '2026-10-01T00:00:00.000Z', applications: [{ company: 'Figma', role: 'APM', stage: 'applied' }] })
  assert.match(prompt, /2026-10-01T00:00:00.000Z in UTC[\s\S]*- Figma — APM \(applied\)/)
  // An exact moment for Gmail, not a date (a date means local midnight and can skip the evening before).
  assert.ok(prompt.includes(`after:${Date.UTC(2026, 9, 1) / 1000}`))
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

test('init event: did the needed MCP server load?', () => {
  const init = (servers: string[]) => JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers.map((name) => ({ name, status: 'pending' })) })
  assert.equal(initHasServer(init(['claude.ai Gmail', 'claude.ai Google Drive']), 'claude.ai Gmail'), true)
  assert.equal(initHasServer(init([]), 'claude.ai Gmail'), false)
  assert.equal(initHasServer('{"type":"assistant"}', 'claude.ai Gmail'), null)
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

test('screenshots in a chat: one stream-json user message with image blocks; no file tools needed', () => {
  const images = chatImages([{ type: 'image/png', data_base64: 'aGk=' }, { type: 'text/html', data_base64: 'eA==' }, null])
  assert.deepEqual(images, [{ type: 'image/png', data_base64: 'aGk=' }])
  const line = claudeImageMessage('add this application', images)
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [
      { type: 'text', text: 'add this application' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ] },
  })
  // The chat's tools stay the web ones: images arrive in the message, not as files.
  assert.ok(!claudeChatArgs(crypto.randomUUID(), false).includes('Read'))
})

test('chat: what Landed knows about the user goes to a new session, and again only when it changes', () => {
  const ctx = 'From their master resume:\n- Education: MS, Information Management — University of Washington'
  assert.equal(contextToSend('c-1', ctx, true), ctx, 'a new session gets it')
  assert.equal(contextToSend('c-1', ctx, false), null, 'a resumed session already has it')
  assert.equal(contextToSend('c-1', `${ctx}\n- Skills: SQL`, false), `${ctx}\n- Skills: SQL`, 'changed: sent again')
  assert.equal(contextToSend('c-2', '   ', true), null)
  assert.equal(contextToSend('c-3', { not: 'text' }, true), null)
  const text = chatWithContext(ctx, 'set up a search for me')
  assert.match(text, /^\(What Landed knows about the user/)
  assert.ok(text.endsWith('set up a search for me'))
  assert.equal(chatWithContext(null, 'hi'), 'hi')
})
