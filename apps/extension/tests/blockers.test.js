// Apply Assist stops before touching sign-in, account-creation and CAPTCHA
// pages. These are deterministic DOM checks; no model is involved.
require('../lib/field-detect.js')
require('../lib/fill/core.js')
require('../lib/fill/blockers.js')

const { detectApplyBlocker } = window.LandedFill

function show(el) {
  el.getClientRects = () => [{ width: 100, height: 20 }]
  return el
}

beforeEach(() => { document.body.innerHTML = '' })

test('a visible password form stops for sign-in', () => {
  document.body.innerHTML = '<h1>Sign in</h1><input type="password">'
  show(document.querySelector('input'))
  expect(detectApplyBlocker()).toMatchObject({ kind: 'login' })
})

test('registration and password confirmation stop for account creation', () => {
  document.body.innerHTML = '<h1>Create an account</h1><input type="password"><input type="password">'
  document.querySelectorAll('input').forEach(show)
  expect(detectApplyBlocker()).toMatchObject({ kind: 'account' })
})

test('CAPTCHA wins over a login form and is never bypassed', () => {
  document.body.innerHTML = '<input type="password"><iframe src="https://challenges.cloudflare.com/turnstile/v0/x"></iframe>'
  document.querySelectorAll('input, iframe').forEach(show)
  expect(detectApplyBlocker()).toMatchObject({ kind: 'captcha' })
})

test('an ordinary application form is not a blocker', () => {
  document.body.innerHTML = '<label>Name <input name="name"></label><textarea name="why"></textarea>'
  document.querySelectorAll('input, textarea').forEach(show)
  expect(detectApplyBlocker()).toBeNull()
})
