// Open-ended questions ("Why us?") through the real content scripts
// (lib/fill/open-answers.js): the user's own agent writes them from the job
// and the resume, only checked answers go in, nothing goes in without an
// agent (the required ones stay yellow and say why), and answers already
// written for the application go back in without asking again.

const fs = require('fs')
const path = require('path')

let stored = {}
let native = () => ({ ok: false, error: 'not available' })
const asked = []
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      if (message?.action === 'native-assist') {
        asked.push(message.request)
        return callback?.(native(message.request))
      }
      callback?.({ ok: true })
    },
  },
  storage: { local: { get: (key, cb) => cb(typeof key === 'string' ? { [key]: stored[key] } : {}) } },
}

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() { return this.parentNode && this.style.display !== 'none' ? this.parentElement || document.body : null },
})
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 }
}

require('../helpers/content-scripts').loadContentScripts()

const resume = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'sample-resume.json'), 'utf8'))
const fill = (extra = {}) => new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume, aiTakeover: true, ...extra }, null, resolve))
const $ = (sel) => document.querySelector(sel)

const FORM = `
  <form>
    <label for="name">Full name ✱</label><input id="name" required>
    <label for="why">Why do you want to work at Bluefin? (max 600 characters) ✱</label><textarea id="why" required maxlength="800"></textarea>
    <label for="proud">Tell us about a project you're proud of</label><textarea id="proud"></textarea>
    <label for="interest">What interests you about this role?</label><textarea id="interest"></textarea>
    <label for="salary">Desired salary — explain ✱</label><textarea id="salary" required></textarea>
  </form>`

const JOB = { role: 'Product Analyst', company: 'Bluefin Analytics', description: 'Own product metrics in SQL.' }
const WHY = 'I built SQL dashboards my team used daily; Bluefin asks for exactly that.'
const INTEREST = 'Owning product metrics end to end is the work I want to do next.'

beforeEach(() => {
  document.body.innerHTML = FORM
  stored = { 'landed:application-answers': { answers: { agree_to_terms: false, custom: [] } } }
  asked.length = 0
})

test('the user\'s agent writes the required one and the optional "why"; only checked answers go in, as the agent\'s', async () => {
  native = (req) => req.type === 'draft_answers'
    ? { ok: true, model: 'Claude Code', answers: Object.fromEntries(req.questions.filter((q) => q.question !== "Tell us about a project you're proud of").map((q) => [q.id, q.question.startsWith('Why') ? WHY : INTEREST])), rejected: {} }
    : { ok: false, error: 'not available' }
  const result = await fill({ job: JOB, examples: [{ question: 'Why Contoso?', answer: 'Tools people use.' }] })

  const draft = asked.find((r) => r.type === 'draft_answers')
  expect(draft.job).toEqual(JOB)
  expect(draft.examples).toEqual([{ question: 'Why Contoso?', answer: 'Tools people use.' }])
  // Required, or optional asking why; never a sensitive one (salary).
  expect(draft.questions.map((q) => q.question)).toEqual(['Why do you want to work at Bluefin? (max 600 characters)', 'What interests you about this role?'])
  // The tighter of the label's limit and the field's own.
  expect(draft.questions[0].max_chars).toBe(600)

  expect($('#why').value).toBe(WHY)
  expect($('#why').getAttribute('data-landed-status')).toBe('filled')
  expect($('#why').getAttribute('data-landed-source')).toBe('draft')
  expect($('#interest').value).toBe(INTEREST)
  // Optional and not asking why: left blank, not yellow.
  expect($('#proud').value).toBe('')
  expect($('#proud').getAttribute('data-landed-status')).toBe('blank')
  expect(result.open_answers).toEqual([
    { question: 'Why do you want to work at Bluefin? (max 600 characters)', answer: WHY },
    { question: 'What interests you about this role?', answer: INTEREST },
  ])
  expect(result.open_missing).toBe(0)
  expect(result.manual.map((m) => m.label)).not.toContain('Why do you want to work at Bluefin? (max 600 characters) ✱')
}, 20_000)

test('no agent: nothing is written, and the required one stays yellow saying why', async () => {
  native = () => ({ ok: false, error: 'Landed for Mac is not installed' })
  const result = await fill({ job: JOB })
  expect($('#why').value).toBe('')
  expect($('#why').getAttribute('data-landed-status')).toBe('review')
  expect($('#why').getAttribute('data-landed-note')).toMatch(/open-ended question/)
  expect(result.manual.find((m) => m.id === $('#why').getAttribute('data-landed-field-id'))).toMatchObject({ hint: '开放题' })
  expect(result.open_missing).toBe(1)
  expect(result.open_answers).toEqual([])
  // Not one of the questions the Extension page asks the user.
  expect(result.unanswered.map((q) => q.question)).not.toContain('Why do you want to work at Bluefin? (max 600 characters) ✱')
  expect($('#interest').getAttribute('data-landed-status')).toBe('blank')
}, 20_000)

test('an answer the check didn\'t pass stays out', async () => {
  native = (req) => req.type === 'draft_answers' ? { ok: true, model: 'Claude Code', answers: {}, rejected: { [req.questions[0].id]: 'The resume never mentions that.' } } : { ok: false }
  const result = await fill({ job: JOB })
  expect($('#why').value).toBe('')
  expect(result.open_missing).toBe(1)
}, 20_000)

test('answers already written for this application go back in without asking the agent again', async () => {
  native = () => { throw new Error('the agent must not be asked') }
  const result = await fill({ job: JOB, drafted: { 'Why do you want to work at Bluefin? (max 600 characters)': WHY, 'What interests you about this role?': INTEREST } })
  expect(asked.filter((r) => r.type === 'draft_answers')).toEqual([])
  expect($('#why').value).toBe(WHY)
  expect(result.open_missing).toBe(0)
}, 20_000)
