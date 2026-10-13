import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchAgentPlist, parseConnectUrl, servicePath } from '../src/mac.ts'

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

test('the LaunchAgent starts at login, restarts, and escapes paths', () => {
  const plist = launchAgentPlist({ node: '/opt/homebrew/bin/node', script: '/Users/a&b/.landed/bin/landed-daemon.mjs', path: '/usr/bin', logFile: '/tmp/x.log' })
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /<string>\/Users\/a&amp;b\/\.landed\/bin\/landed-daemon\.mjs<\/string>\s*<string>service<\/string>/)
  assert.ok(servicePath('/custom/bin').startsWith('/custom/bin:'))
  assert.ok(servicePath('').includes('/opt/homebrew/bin'))
})
