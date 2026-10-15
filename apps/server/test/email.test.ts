import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cloudflarePasswordResetSender, createPasswordResetSender, smtpPasswordResetSender } from '../src/email.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Cloudflare password email uses the REST field names and both body formats', async () => {
  const captured: { request?: { url: string; init?: RequestInit } } = {}
  globalThis.fetch = async (input, init) => {
    captured.request = { url: String(input), init }
    return Response.json({ success: true, errors: [], result: { delivered: ['user@example.com'], queued: [], permanent_bounces: [] } })
  }
  const send = cloudflarePasswordResetSender({
    provider: 'cloudflare',
    accountId: 'account id', apiToken: 'secret-token', fromAddress: 'no-reply@landed.example', fromName: 'Landed',
  })
  await send({ to: 'user@example.com', resetUrl: 'https://landed.example/reset-password#token=abc', expiresInMinutes: 30 })
  const request = captured.request
  assert.ok(request)
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/account%20id/email/sending/send')
  assert.equal((request.init!.headers as Record<string, string>).Authorization, 'Bearer secret-token')
  const body = JSON.parse(String(request.init!.body))
  assert.deepEqual(body.from, { address: 'no-reply@landed.example', name: 'Landed' })
  assert.equal(body.replyTo, undefined)
  assert.match(body.text, /https:\/\/landed\.example\/reset-password#token=abc/)
  assert.match(body.html, /Reset password/)
})

test('Cloudflare password email retries transient errors', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls < 3
      ? Response.json({ success: false, errors: [{ message: 'busy' }] }, { status: 429 })
      : Response.json({ success: true, errors: [], result: { delivered: [], queued: ['user@example.com'], permanent_bounces: [] } })
  }
  const send = cloudflarePasswordResetSender({
    provider: 'cloudflare',
    accountId: 'a', apiToken: 't', fromAddress: 'no-reply@landed.example', fromName: 'Landed',
  })
  await send({ to: 'user@example.com', resetUrl: 'https://landed.example/reset-password#token=abc', expiresInMinutes: 30 })
  assert.equal(calls, 3)
})

test('SMTP password email uses the standard transport with text and HTML bodies', async () => {
  let captured: Record<string, unknown> | undefined
  const send = smtpPasswordResetSender({
    provider: 'smtp', host: 'mail.landed.example', port: 587, secure: false,
    user: 'landed', password: 'secret', fromAddress: 'no-reply@landed.example', fromName: 'Landed',
  }, {
    sendMail: async (message) => { captured = message; return { accepted: ['user@example.com'] } },
  })
  await send({ to: 'user@example.com', resetUrl: 'https://landed.example/reset-password#token=a&b', expiresInMinutes: 30 })
  assert.ok(captured)
  assert.deepEqual(captured.from, { address: 'no-reply@landed.example', name: 'Landed' })
  assert.equal(captured.to, 'user@example.com')
  assert.match(String(captured.text), /#token=a&b/)
  assert.match(String(captured.html), /#token=a&amp;b/)
})

test('generic password reset sender selects the configured provider', () => {
  assert.equal(typeof createPasswordResetSender({
    provider: 'smtp', host: 'localhost', port: 25, secure: false,
    fromAddress: 'no-reply@landed.example', fromName: 'Landed',
  }), 'function')
  assert.equal(typeof createPasswordResetSender({
    provider: 'cloudflare', accountId: 'a', apiToken: 't',
    fromAddress: 'no-reply@landed.example', fromName: 'Landed',
  }), 'function')
})
