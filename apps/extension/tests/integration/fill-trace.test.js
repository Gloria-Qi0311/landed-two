// A fill's trace (lib/fill/trace.js), through the real content scripts: the
// phases in order, every model call with what came back, and every field
// Landed touched with where its value came from — or why it was left. A
// sensitive question keeps no value, only whether it was filled. A sign-in
// page's trace says why nothing was filled. Made-up person (fixture).

const fs = require('fs')
const path = require('path')

let stored = {}
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      // Landed for Mac isn't running: every model call fails, and says so.
      if (message?.action === 'native-assist') return callback?.({ ok: false, error: 'Landed for Mac is not running' })
      callback?.({ ok: true })
    },
  },
  storage: { local: { get: (key, cb) => cb(typeof key === 'string' ? { [key]: stored[key] } : {}) } },
}

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() { return this.parentNode ? this.parentElement || document.body : null },
})
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 }
}

require('../helpers/content-scripts').loadContentScripts()

const resume = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'sample-resume.json'), 'utf8'))
const fill = () => new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume, aiTakeover: true }, null, resolve))
const radio = (name, value, text) => `<label><input type="radio" name="${name}" value="${value}"> ${text}</label>`

beforeEach(() => {
  stored = { 'landed:application-answers': { answers: { agree_to_terms: false, custom: [], adult: 'yes' } }, 'landed:application-files': {} }
})

test('the trace has each phase, each model call, and every field with its source or why it was left', async () => {
  document.body.innerHTML = `
    <form>
      <label for="email">Email</label><input id="email" type="email">
      <label for="heard">How did you hear about us?</label><input id="heard">
      <div class="q"><p>Are you 18 years of age or older?</p>${radio('adult', 'y', 'Yes')}${radio('adult', 'n', 'No')}</div>
      <label for="dob">Date of birth</label><input id="dob" value="1990-01-01">
      <label for="team">Which team interests you most?</label><input id="team">
      <button type="submit">Submit</button>
    </form>`
  const result = await fill()
  const trace = result.trace

  expect(trace.top).toBe(true)
  expect(trace.url).toBe(`${location.origin}${location.pathname}`)
  expect(trace.fields_on_page).toBeGreaterThan(0)
  expect(trace.blocker).toBeNull()
  // The phases in the order they ran, each with what it filled.
  const names = trace.phases.map((p) => p.name)
  expect(names.slice(0, 4)).toEqual(['files', 'entries', 'answers', 'resume'])
  expect(names).toContain('choices')
  expect(trace.phases.reduce((sum, p) => sum + p.filled, 0)).toBeGreaterThanOrEqual(2)

  const byQuestion = Object.fromEntries(trace.fields.map((f) => [f.question, f]))
  expect(byQuestion.Email).toMatchObject({ kind: 'text', status: 'filled', source: 'resume', value: 'alice.wong@example.com' })
  expect(byQuestion['Are you 18 years of age or older?']).toMatchObject({ kind: 'radio', status: 'filled', source: 'answers', value: 'Yes' })
  expect(byQuestion['How did you hear about us?']).toMatchObject({ status: 'review', reason: 'needs a saved answer' })
  expect(byQuestion['How did you hear about us?'].value).toBeUndefined()

  // A sensitive question never carries its value, filled or not.
  for (const f of trace.fields.filter((x) => /birth/i.test(x.question))) {
    expect(f.hidden).toBe(true)
    expect(f).not.toHaveProperty('value')
  }
  expect(JSON.stringify(trace)).not.toContain('1990-01-01')

  // Each model call that ran, with why it came back empty.
  const calls = Object.fromEntries(trace.models.map((m) => [m.kind, m]))
  expect(calls.match_fields).toMatchObject({ answered: 0, error: 'Landed for Mac is not running' })
  expect(calls.match_fields.asked).toBeGreaterThan(0)
  expect(calls.review_fill).toMatchObject({ error: 'Landed for Mac is not running' })
  expect(trace.unanswered).toContain('How did you hear about us?')
}, 20_000)

test("a sign-in page's trace says why nothing was filled", async () => {
  document.body.innerHTML = `
    <form><h2>Sign in</h2>
      <label for="u">Email</label><input id="u" type="email">
      <label for="p">Password</label><input id="p" type="password">
      <button>Sign in</button>
    </form>`
  const result = await fill()
  expect(result.blocker.kind).toBe('login')
  expect(result.trace.blocker).toMatchObject({ kind: 'login' })
  expect(result.trace.fields).toEqual([])
  expect(document.querySelector('#u').value).toBe('')
})
