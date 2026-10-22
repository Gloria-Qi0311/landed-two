// Work authorization and sponsorship questions about another country, through
// the real content scripts: the saved answers (about the US) don't answer
// them, the local model isn't asked to pick them from those answers, and the
// review doesn't see them. They stay yellow and are reported to be asked
// once. The US questions on the same form still take the saved answers.
// Made-up person (fixture).

const fs = require('fs')
const path = require('path')

let stored = {}
const onMessageListeners = []
const asked = { choose: [], match: [], review: [] }
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      const request = message?.request
      // A model that answers everything with the first option / "yes": if a
      // question reached it, it would get filled.
      if (request?.type === 'choose_options') {
        asked.choose.push(...request.questions.map((q) => q.question))
        return callback?.({ ok: true, choices: Object.fromEntries(request.questions.map((q) => [q.id, { option_index: 0 }])) })
      }
      if (request?.type === 'match_fields') {
        asked.match.push(...request.fields.map((f) => f.label))
        return callback?.({ ok: true, values: {} })
      }
      if (request?.type === 'review_fill') {
        asked.review.push(...request.fields.map((f) => f.question))
        return callback?.({ ok: true, model: 'test', reviews: {} })
      }
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
const $ = (sel) => document.querySelector(sel)

beforeEach(() => {
  asked.choose.length = 0
  asked.match.length = 0
  asked.review.length = 0
  stored = {
    'landed:application-answers': { answers: { agree_to_terms: false, custom: [], work_authorized: 'yes', needs_sponsorship: 'yes' } },
    'landed:application-files': {},
  }
  document.body.innerHTML = `
    <form>
      <div class="q"><p>Are you legally authorized to work in the United States?</p>${radio('us', 'y', 'Yes')}${radio('us', 'n', 'No')}</div>
      <div class="q"><p>Are you legally authorized to work in the United Kingdom?</p>${radio('uk', 'y', 'Yes')}${radio('uk', 'n', 'No')}</div>
      <div class="q"><p>Do you require sponsorship to work in Germany?</p>${radio('de', 'y', 'Yes')}${radio('de', 'n', 'No')}</div>
      <label for="ca">Are you authorized to work in Canada?</label><input id="ca">
      <button type="submit">Submit</button>
    </form>`
})

test("another country's authorization or sponsorship is never answered from the US answers", async () => {
  const result = await fill()

  // The US question takes the saved answer.
  expect($('input[name="us"][value="y"]').checked).toBe(true)
  // The others stay empty and yellow, whatever the model would have said.
  for (const name of ['uk', 'de']) {
    expect(Array.from(document.querySelectorAll(`input[name="${name}"]`)).some((r) => r.checked)).toBe(false)
    expect($(`input[name="${name}"]`).getAttribute('data-landed-status')).toBe('review')
  }
  expect($('#ca').value).toBe('')

  const other = /United Kingdom|Germany|Canada/
  expect(asked.choose.filter((q) => other.test(q))).toEqual([])
  expect(asked.match.filter((q) => other.test(q))).toEqual([])
  expect(asked.review.filter((q) => other.test(q))).toEqual([])

  // Asked once on the Extension page instead.
  const questions = result.unanswered.map((q) => q.question)
  expect(questions).toEqual(expect.arrayContaining([
    'Are you legally authorized to work in the United Kingdom?',
    'Do you require sponsorship to work in Germany?',
  ]))
}, 20_000)

test('once the user answers the UK question, that answer fills it', async () => {
  stored['landed:application-answers'].answers.custom = [{ question: 'Are you legally authorized to work in the United Kingdom?', answer: 'No' }]
  await fill()
  expect($('input[name="uk"][value="n"]').checked).toBe(true)
  expect($('input[name="us"][value="y"]').checked).toBe(true)
}, 20_000)
