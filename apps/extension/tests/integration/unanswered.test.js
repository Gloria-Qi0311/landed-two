// Questions a fill had to leave empty (lib/fill/unanswered.js), through the
// real content scripts: which ones are reported to be asked once (never
// sensitive questions, files, open-ended text or resume fields), filling
// them on a page still open once they're answered (only fields still empty),
// and the next form answering them by rule, however it words them.

const fs = require('fs')
const path = require('path')

let stored = {}
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      // No local model or agent here: rules only.
      if (message?.action === 'native-assist') return callback?.({ ok: false, error: 'not available' })
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
const send = (msg) => new Promise((resolve) => onMessageListeners[0](msg, null, resolve))
const fill = () => send({ action: 'fill', resume, aiTakeover: true })
const radio = (name, value, text) => `<label><input type="radio" name="${name}" value="${value}"> ${text}</label>`
const $ = (sel) => document.querySelector(sel)
const answersWith = (extra) => ({ 'landed:application-answers': { answers: { agree_to_terms: false, custom: [], ...extra } } })

const FORM = `
  <form>
    <label for="email">Email</label><input id="email" type="email">
    <label for="shirt">What is your T-shirt size?</label>
    <select id="shirt"><option value="">Select…</option><option>S</option><option>M</option><option>L</option></select>
    <label for="heard">How did you hear about us?</label><input id="heard">
    <div class="q"><p>Are you 18 years of age or older?</p>${radio('adult', 'y', 'Yes')}${radio('adult', 'n', 'No')}</div>
    <label for="nick">What should we call you at the office?</label><input id="nick">
    <label for="gender">Gender</label>
    <select id="gender"><option value="">Select</option><option>Female</option><option>Male</option></select>
    <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
    <label for="gpa">GPA</label><input id="gpa">
    <label for="cv">Upload your resume</label><input id="cv" type="file">
    <label><input type="checkbox" id="terms"> I agree to the terms</label>
    <button id="submit" type="submit">Submit</button>
  </form>`

beforeEach(() => {
  document.body.innerHTML = FORM
  stored = answersWith({})
})

test('reports the empty questions worth asking — never sensitive ones, files, open-ended text or resume fields', async () => {
  const result = await fill()
  const byQuestion = Object.fromEntries(result.unanswered.map((q) => [q.question, q]))
  expect(Object.keys(byQuestion).sort()).toEqual([
    'Are you 18 years of age or older?', 'How did you hear about us?', 'What is your T-shirt size?', 'What should we call you at the office?',
  ])
  expect(byQuestion['What is your T-shirt size?']).toMatchObject({ key: null, options: ['S', 'M', 'L'], site: 'localhost' })
  expect(byQuestion['How did you hear about us?']).toMatchObject({ key: 'heard_from', options: [] })
  expect(byQuestion['Are you 18 years of age or older?']).toMatchObject({ key: 'adult', options: ['Yes', 'No'] })
})

test('once answered: a page still open fills the empty fields, and leaves what the user typed', async () => {
  let submitted = false
  $('#submit').addEventListener('click', () => { submitted = true })
  await fill()
  // The user typed a nickname themselves; then answered on the Extension page.
  $('#nick').value = 'Lexy'
  stored = answersWith({
    heard_from: 'A friend', adult: 'yes',
    custom: [{ question: 'What is your T-shirt size?', answer: 'M' }, { question: 'What should we call you at the office?', answer: 'Lex' }],
  })
  const { filled } = await send({ action: 'fill-answers' })
  expect(filled).toBe(3)
  expect($('#shirt').value).toBe('M')
  expect($('#heard').value).toBe('A friend')
  expect(document.querySelector('input[name="adult"]:checked')?.value).toBe('y')
  expect($('#nick').value).toBe('Lexy')
  for (const el of [$('#shirt'), $('#heard'), $('input[name="adult"]')]) {
    expect(el.getAttribute('data-landed-status')).toBe('filled')
    expect(el.getAttribute('data-landed-source')).toBe('answers')
  }
  expect($('#gender').value).toBe('')
  expect($('#terms').checked).toBe(false)
  expect(submitted).toBe(false)
})

test('the next form answers them by rule, however it words them — and asks nothing again', async () => {
  stored = answersWith({ heard_from: 'A friend', adult: 'yes', custom: [{ question: 'What is your T-shirt size?', answer: 'M' }] })
  document.body.innerHTML = `
    <form>
      <label for="shirt">T-shirt size *</label>
      <select id="shirt"><option value="">Choose one</option><option>Small</option><option>M</option><option>Large</option></select>
      <label for="src">Where did you hear about this job?</label><input id="src">
      <fieldset><legend>Are you at least 18 years old?</legend>${radio('a18', 'y', 'Yes')}${radio('a18', 'n', 'No')}</fieldset>
    </form>`
  const result = await fill()
  expect($('#shirt').value).toBe('M')
  expect($('#src').value).toBe('A friend')
  expect(document.querySelector('input[name="a18"]:checked')?.value).toBe('y')
  expect(result.unanswered).toEqual([])
})
