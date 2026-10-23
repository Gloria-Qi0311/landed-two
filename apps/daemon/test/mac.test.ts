import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { EXTENSION_ID, installNativeHost, launchAgentPlist, nativeHostManifest, parseAgentConnectUrl, parseConnectUrl, servicePath } from '../src/mac.ts'

test('connect links: only landed://connect with an http(s) server and a runtime token', () => {
  const token = 'landed_rt_' + 'a'.repeat(43)
  assert.deepEqual(parseConnectUrl(`landed://connect?server=${encodeURIComponent('http://localhost:5173')}&token=${token}&name=My%20Mac`), {
    server: 'http://localhost:5173', token, name: 'My Mac',
  })
  assert.equal(parseConnectUrl(`landed://connect?server=https://landed.example.com/some/path&token=${token}`)?.server, 'https://landed.example.com')
  for (const bad of [
    `landed://connect?server=file:///etc&token=${token}`,
    `landed://connect?server=https://x.com&token=nope`,
    `landed://hack?server=https://x.com&token=${token}`,
    `https://connect?server=https://x.com&token=${token}`,
    'not a url',
  ]) assert.equal(parseConnectUrl(bad), null, bad)
})

test('agent connect links: only supported agents and a secure Landed MCP endpoint', () => {
  assert.deepEqual(parseAgentConnectUrl(`landed://connect-agent?agent=codex&url=${encodeURIComponent('https://landed.example.com/mcp')}`), {
    agent: 'codex', url: 'https://landed.example.com/mcp',
  })
  assert.deepEqual(parseAgentConnectUrl(`landed://connect-agent?agent=gemini&url=${encodeURIComponent('https://landed.example.com/mcp')}`), {
    agent: 'gemini', url: 'https://landed.example.com/mcp',
  })
  assert.equal(parseAgentConnectUrl(`landed://connect-agent?agent=codex&url=${encodeURIComponent('http://localhost:5173/mcp')}`)?.url, 'http://localhost:5173/mcp')
  for (const bad of [
    'landed://connect-agent?agent=claude&url=https%3A%2F%2Flanded.example.com%2Fmcp',
    'landed://connect-agent?agent=codex&url=http%3A%2F%2Flanded.example.com%2Fmcp',
    'landed://connect-agent?agent=codex&url=https%3A%2F%2Flanded.example.com%2Fother',
    'landed://connect-agent?agent=codex&url=https%3A%2F%2Fuser%3Apass%40landed.example.com%2Fmcp',
    'landed://connect-agent?agent=codex&url=https%3A%2F%2Flanded.example.com%2Fmcp%3Fx%3D1',
    'https://connect-agent?agent=codex&url=https%3A%2F%2Flanded.example.com%2Fmcp',
  ]) assert.equal(parseAgentConnectUrl(bad), null, bad)
})

test('the LaunchAgent starts at login, restarts, and escapes paths', () => {
  const plist = launchAgentPlist({ node: '/opt/homebrew/bin/node', script: '/Users/a&b/.landed/bin/landed-daemon.mjs', path: '/usr/bin', logFile: '/tmp/x.log' })
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /<string>\/Users\/a&amp;b\/\.landed\/bin\/landed-daemon\.mjs<\/string>\s*<string>service<\/string>/)
  assert.ok(servicePath('/custom/bin').startsWith('/custom/bin:'))
  assert.ok(servicePath('').includes('/opt/homebrew/bin'))
})

test('the Native Messaging host only accepts the stable Landed extension', () => {
  const manifest = nativeHostManifest('/Users/me/.landed/bin/landed-native-host')
  assert.equal(manifest.name, 'dev.landed.assist')
  assert.equal(manifest.path, '/Users/me/.landed/bin/landed-native-host')
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`])
})

test('Native Messaging install writes an executable wrapper and browser manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'landed-native-'))
  const previousHome = process.env.LANDED_HOME
  const previousDirs = process.env.LANDED_NATIVE_HOST_DIRS
  try {
    const one = join(root, 'chrome')
    const two = join(root, 'brave')
    process.env.LANDED_HOME = join(root, 'home')
    process.env.LANDED_NATIVE_HOST_DIRS = [one, two].join(delimiter)
    const manifests = installNativeHost('/usr/bin/node', "/tmp/Landed app/daemon.mjs")
    assert.equal(manifests.length, 2)
    const manifest = JSON.parse(readFileSync(manifests[0], 'utf8'))
    assert.equal(manifest.allowed_origins[0], `chrome-extension://${EXTENSION_ID}/`)
    assert.equal(statSync(manifest.path).mode & 0o777, 0o700)
    assert.match(readFileSync(manifest.path, 'utf8'), /exec '\/usr\/bin\/node' '\/tmp\/Landed app\/daemon\.mjs' native-host/)
  } finally {
    if (previousHome === undefined) delete process.env.LANDED_HOME
    else process.env.LANDED_HOME = previousHome
    if (previousDirs === undefined) delete process.env.LANDED_NATIVE_HOST_DIRS
    else process.env.LANDED_NATIVE_HOST_DIRS = previousDirs
    rmSync(root, { recursive: true, force: true })
  }
})
