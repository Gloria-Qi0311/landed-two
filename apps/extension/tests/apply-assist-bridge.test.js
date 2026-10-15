const bridge = require('../lib/apply-assist-bridge.js')

test('menu bridge exposes only http(s) tabs and resume metadata', () => {
  expect(bridge.publicTabs([
    { id: 1, title: 'Job', url: 'https://jobs.example/apply', active: true },
    { id: 2, title: 'Settings', url: 'chrome://settings', active: false },
  ])).toEqual([{ id: 1, title: 'Job', url: 'https://jobs.example/apply', active: true }])
  expect(bridge.publicResumes([
    { id: 'r1', name: 'PM', parsed_json: { email: 'private@example.com' }, is_current: true, created_at: '2026-10-14' },
  ])).toEqual([{ id: 'r1', name: 'PM', is_current: true, created_at: '2026-10-14' }])
})

test('menu bridge labels browsers and summarizes parallel fills', () => {
  expect(bridge.browserLabel('Mozilla Chrome/140.0', false)).toBe('Google Chrome')
  expect(bridge.browserLabel('Mozilla Chrome/140.0 Edg/140.0', false)).toBe('Microsoft Edge')
  expect(bridge.browserLabel('Mozilla Chrome/140.0', true)).toBe('Brave')
  expect(bridge.browserLabel('Mozilla/5.0 Version/27.0 Safari/620.1.14', false)).toBe('Safari')
  expect(bridge.isSafariUserAgent('Mozilla/5.0 Version/27.0 Safari/620.1.14')).toBe(true)
  expect(bridge.isSafariUserAgent('Mozilla/5.0 Chrome/140.0 Safari/537.36')).toBe(false)
  expect(bridge.fillSummary([
    { filled: 8, review: 2 },
    { filled: 3, review: 1 },
    { error: 'gone' },
  ])).toEqual({ filled: 11, review: 3, failed: 1, summary: '11 filled · 3 review · 1 unavailable' })
})
