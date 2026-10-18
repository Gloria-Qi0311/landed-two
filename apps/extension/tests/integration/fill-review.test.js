// The agent review after a fill (lib/fill/review.js), through the real
// content.js: what the reviewer is sent (never sensitive questions or
// facts), what it may change (values from the resume or the local model, and
// empty fields), and what it may only flag (the user's saved answers).
// Changed and flagged fields turn yellow with the reason. Submit is never
// clicked. The native host is stubbed; its own rules are tested in
// apps/daemon/test/native-host.test.ts.

const fs = require('fs')
const path = require('path')

const answers = {
  legal_first_name: 'Alex', legal_middle_name: null, legal_last_name: 'Chen', preferred_first_name: 'Lex', preferred_last_name: null,
  date_of_birth: 'March 3', address_line1: null, address_line2: null, city: 'Seattle', state: 'Washington', postal_code: null,
  country: 'United States', work_authorized: 'yes', needs_sponsorship: 'yes', earliest_start: null, relocate: null, travel: null,
  preferred_locations: [], open_to_other_locations: null, previously_employed: null, non_compete: null,
  heard_from: null, talent_network: null, gender: 'Male', hispanic_latino: 'no', race: 'Asian', veteran: 'no', disability: null,
  agree_to_terms: true, custom: [],
}

let stored = {}
let reviewReply = () => ({ ok: true, model: 'Claude Code', reviews: {} })
const requests = []
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      if (message?.action !== 'native-assist') return callback?.({ ok: true })
      const request = message.request
      requests.push(request)
      if (request.type === 'match_fields') {
        // The local model picks the wrong thing for the profile link.
        const profile = request.fields.find((f) => /profile url/i.test(f.label))
        return callback?.({ ok: true, values: profile ? { [profile.id]: { value: 'https://example.com/alice', resume_key: 'website', confidence: 0.95 } } : {} })
      }
      if (request.type === 'choose_options') {
        // …and the wrong option for the residency question.
        const q = request.questions.find((x) => /resident of China/.test(x.question))
        return callback?.({ ok: true, choices: q ? { [q.id]: { option_index: q.options.indexOf('Yes'), confidence: 0.9 } } : {} })
      }
      if (request.type === 'review_fill') return callback?.(reviewReply(request))
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
const fill = (aiTakeover = true) => new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume, aiTakeover }, null, resolve))
const radio = (name, value, text) => `<label><input type="radio" name="${name}" value="${value}"> ${text}</label>`
const $ = (sel) => document.querySelector(sel)
const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null

const FORM = `
  <form>
    <label for="lfn">Legal first name *</label><input id="lfn">
    <label for="email">Email</label><input id="email" type="email">
    <label for="profile">Public profile URL</label><input id="profile" type="url">
    <label for="callme">What name should we call you?</label><input id="callme">
    <label for="home">Hometown</label><input id="home">
    <label for="sp">Will you now or in the future require sponsorship?</label>
    <select id="sp"><option value="">Select</option><option value="y">Yes</option><option value="n">No</option></select>
    <div class="q"><p>Are you a resident of China or South Korea?</p>${radio('res', 'y', 'Yes')}${radio('res', 'n', 'No')}</div>
    <label for="dob">Please indicate your day and month of birth.</label><input id="dob">
    <label for="gender">Gender:</label>
    <select id="gender"><option value="">Select</option><option>Female</option><option>Male</option><option>I do not wish to answer</option></select>
    <label><input type="checkbox" id="privacy"> I confirm that I have read and agree to the Privacy Policy.</label>
    <button id="submit" type="submit">Submit</button>
  </form>`

const review = () => requests.find((r) => r.type === 'review_fill')
const fieldFor = (question) => review().fields.find((f) => question.test(f.question))

beforeEach(() => {
  document.body.innerHTML = FORM
  requests.length = 0
  stored = { 'landed:application-answers': { answers } }
  reviewReply = () => ({ ok: true, model: 'Claude Code', reviews: {} })
})

test('the reviewer sees each field, its value and where it came from — never sensitive questions or facts', async () => {
  await fill()
  const sent = review()
  expect(sent).toBeTruthy()
  expect(fieldFor(/Legal first name/)).toMatchObject({ value: 'Alex', source: 'answers' })
  expect(fieldFor(/^Email/)).toMatchObject({ value: 'alice.wong@example.com', source: 'resume' })
  expect(fieldFor(/Public profile URL/)).toMatchObject({ value: 'https://example.com/alice', source: 'model' })
  expect(fieldFor(/sponsorship/)).toMatchObject({ value: 'Yes', source: 'answers', options: ['Select', 'Yes', 'No'] })
  expect(fieldFor(/resident of China/)).toMatchObject({ value: 'Yes', source: 'model', options: ['Yes', 'No'] })
  expect(fieldFor(/call you/)).toMatchObject({ value: 'Alice Wong', source: 'resume' })
  expect(fieldFor(/Hometown/)).toMatchObject({ value: '', source: '' })

  const questions = sent.fields.map((f) => f.question).join('\n')
  expect(questions).not.toMatch(/birth|Gender|Privacy/i)
  expect(sent.facts).toMatchObject({ 'answers.needs_sponsorship': 'Yes', 'answers.preferred_first_name': 'Lex', 'resume.email': 'alice.wong@example.com' })
  const facts = JSON.stringify(sent.facts)
  expect(facts).not.toMatch(/March 3|Male|Asian|date_of_birth|gender|race/)
})

test('fixes values from the model or a resume rule and fills empty fields; the saved answer is only flagged; never submits', async () => {
  let submitted = false
  $('#submit').addEventListener('click', () => { submitted = true })
  reviewReply = (request) => {
    const id = (q) => request.fields.find((f) => q.test(f.question)).id
    return {
      ok: true,
      model: 'Claude Code',
      reviews: {
        // The host supplies values from the facts; the stub plays the host.
        [id(/Public profile URL/)]: { verdict: 'fix', value: 'alicewong.dev', fact_key: 'resume.portfolio', confidence: 0.95, reason: 'Your resume lists alicewong.dev.' },
        [id(/resident of China/)]: { verdict: 'fix', option_index: 1, confidence: 0.92, reason: 'You live in the United States.' },
        [id(/call you/)]: { verdict: 'fix', value: 'Lex', fact_key: 'answers.preferred_first_name', confidence: 0.9, reason: 'Your preferred name is Lex.' },
        [id(/Hometown/)]: { verdict: 'fix', value: 'Seattle', fact_key: 'answers.city', confidence: 0.86, reason: 'You live in Seattle.' },
        [id(/sponsorship/)]: { verdict: 'fix', option_index: 2, confidence: 0.9, reason: 'Your resume suggests you are a citizen.' },
      },
    }
  }
  const result = await fill()

  // Corrected: the model's wrong picks, a resume rule's guess, an empty field.
  expect($('#profile').value).toBe('alicewong.dev')
  expect(checked('res')).toBe('n')
  expect($('#callme').value).toBe('Lex')
  expect($('#home').value).toBe('Seattle')
  for (const el of [$('#profile'), $('#callme'), $('#home'), $('input[name="res"]')]) {
    expect(el.getAttribute('data-landed-status')).toBe('review')
    expect(el.getAttribute('data-landed-note')).toMatch(/^changed: /)
  }
  // The user's saved answer stays; the field turns yellow with the reason.
  expect($('#sp').value).toBe('y')
  expect($('#sp').getAttribute('data-landed-status')).toBe('review')
  expect($('#sp').getAttribute('data-landed-note')).toBe('check this: Your resume suggests you are a citizen.')
  expect($('#sp').getAttribute('title')).toMatch(/^Landed review: /)

  expect(result.review).toMatchObject({ fixed: 4, flagged: 1, model: 'Claude Code', error: null })
  expect(result.review.left_out).toBeGreaterThanOrEqual(2)
  expect(result.manual.map((m) => m.label)).toEqual(expect.arrayContaining(['Will you now or in the future require sponsorship?']))
  // Untouched: the sensitive answers.
  expect($('#gender').value).toBe('Male')
  expect($('#dob').value).toBe('March 3')
  expect(submitted).toBe(false)
})

test('a doubt flags the field without changing it; without an agent the fill still completes', async () => {
  reviewReply = (request) => ({
    ok: true, model: 'qwen3.5:4b',
    reviews: { [request.fields.find((f) => /^Email/.test(f.question)).id]: { verdict: 'doubt', reason: 'This looks like a different person.' } },
  })
  let result = await fill()
  expect($('#email').value).toBe('alice.wong@example.com')
  expect($('#email').getAttribute('data-landed-status')).toBe('review')
  expect(result.review).toMatchObject({ fixed: 0, flagged: 1, model: 'qwen3.5:4b' })

  document.body.innerHTML = FORM
  requests.length = 0
  reviewReply = () => ({ ok: false, error: 'Neither Ollama nor Claude Code is available' })
  result = await fill()
  expect($('#lfn').value).toBe('Alex')
  expect($('#lfn').getAttribute('data-landed-status')).toBe('filled')
  expect(result.review).toMatchObject({ checked: 0, fixed: 0, flagged: 0, error: 'Neither Ollama nor Claude Code is available' })
})

test('no review without the full fill', async () => {
  const result = await fill(false)
  expect(review()).toBeUndefined()
  expect(result.review).toBeNull()
})
