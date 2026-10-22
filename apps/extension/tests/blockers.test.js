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

describe('invisible CAPTCHAs (they act on submit) never stop the fill; one on screen always does', () => {
  const noSize = (el) => { el.getClientRects = () => []; el.getBoundingClientRect = () => ({ width: 0, height: 0 }); return el }

  test('Lever: an hCaptcha with no height, its frames hidden', () => {
    document.body.innerHTML = '<label>Name <input name="name"></label><div class="h-captcha"><iframe style="visibility:hidden" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html"></iframe></div>'
    show(document.querySelector('input'))
    noSize(document.querySelector('.h-captcha'))
    show(document.querySelector('iframe'))
    expect(detectApplyBlocker()).toBeNull()
  })

  test("Greenhouse and Ashby: Google's invisible badge in the corner, a hidden challenge frame", () => {
    document.body.innerHTML = `<label>Name <input name="name"></label>
      <div class="grecaptcha-badge"><div class="grecaptcha-logo"><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=x&size=invisible"></iframe></div></div>
      <div style="visibility:hidden"><iframe src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x"></iframe></div>`
    document.querySelectorAll('input, iframe').forEach(show)
    expect(detectApplyBlocker()).toBeNull()
  })

  test('a "protected by hCaptcha" footer is not a challenge page', () => {
    document.body.innerHTML = '<label>Name <input name="name"></label><p>This site is protected by hCaptcha and its Privacy Policy applies.</p>'
    show(document.querySelector('input'))
    expect(detectApplyBlocker()).toBeNull()
  })

  test('a checkbox widget on screen, an open challenge, a "verify you are human" page: stop', () => {
    document.body.innerHTML = '<label>Name <input name="name"></label><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"></iframe>'
    document.querySelectorAll('input, iframe').forEach(show)
    expect(detectApplyBlocker()).toMatchObject({ kind: 'captcha' })
    document.body.innerHTML = '<div class="h-captcha" data-sitekey="x"></div>'
    show(document.querySelector('.h-captcha'))
    expect(detectApplyBlocker()).toMatchObject({ kind: 'captcha' })
    document.body.innerHTML = '<h1>Verify you are human</h1>\n<button>Continue</button>'
    show(document.querySelector('button'))
    expect(detectApplyBlocker()).toMatchObject({ kind: 'captcha' })
  })
})
