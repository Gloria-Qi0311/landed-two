// The real content.js fill on an IBM-style form, with saved application
// answers: text fields, radio groups, dropdowns, consent — and the local
// model for a choice question no rule covers. Submit is never clicked.

const fs = require('fs')
const path = require('path')

const answers = {
  legal_first_name: 'Alex', legal_middle_name: null, legal_last_name: 'Chen', preferred_first_name: 'Lex', preferred_last_name: 'Chen',
  date_of_birth: 'March 3', address_line1: '100 Main St', address_line2: null, city: 'Seattle', state: 'Washington', postal_code: '98105',
  country: 'United States', work_authorized: 'yes', needs_sponsorship: 'yes', earliest_start: 'June 2027', relocate: 'yes', travel: null,
  preferred_locations: ['San Francisco, CA'], open_to_other_locations: 'yes', previously_employed: 'no', non_compete: null,
  heard_from: null, talent_network: 'yes', gender: 'Male', hispanic_latino: 'no', race: 'Asian', veteran: 'no', disability: null,
  agree_to_terms: true, custom: [],
}

let stored = { 'landed:application-answers': { answers } }
const nativeRequests = []
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      if (message?.action === 'native-assist') {
        nativeRequests.push(message.request)
        if (message.request.type === 'choose_options') {
          const q = message.request.questions.find((x) => /resident of China/.test(x.question))
          callback?.({ ok: true, choices: q ? { [q.id]: { option_index: q.options.indexOf('No'), confidence: 0.95 } } : {} })
          return
        }
        callback?.({ ok: true, values: {} })
        return
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
const fill = (aiTakeover = true) => new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume, aiTakeover }, null, resolve))
const radio = (name, value, text) => `<label><input type="radio" name="${name}" value="${value}"> ${text}</label>`
const $ = (sel) => document.querySelector(sel)

const FORM = `
  <form>
    <fieldset><legend>You consent to IBM processing the information you provide for the purpose of processing your application *</legend>
      ${radio('consent', 'y', 'I consent to IBM processing the information')}${radio('consent', 'n', 'I do not consent to IBM Processing the information.')}
    </fieldset>
    <label><input type="checkbox" id="privacy"> I confirm that I have read, understand and agree to IBM's Privacy Policy.</label>
    <label for="lfn">Legal first name *</label><input id="lfn">
    <label for="lln">Legal last name *</label><input id="lln">
    <fieldset><legend>If you have a preferred name that is different from your legal name, please select yes below; otherwise, please select no.</legend>
      ${radio('pref', 'y', 'Yes')}${radio('pref', 'n', 'No')}
    </fieldset>
    <label for="pfn">Preferred first name</label><input id="pfn">
    <label for="dob">Please indicate your day and month of birth.</label><input id="dob">
    <label for="addr">Address line 1</label><input id="addr">
    <label for="zip">Zip code/Postal code</label><input id="zip">
    <label for="country">Country</label>
    <select id="country"><option value="">Select</option><option value="CA">Canada</option><option value="US">United States of America</option></select>
    <label for="state">State/Province</label>
    <select id="state"><option value="">Select</option><option value="OR">OR</option><option value="WA">WA</option></select>
    <div class="q"><p>Are you legally authorized to work in the United States?</p>${radio('auth', 'y', 'Yes')}${radio('auth', 'n', 'No')}</div>
    <div class="q"><p>If you are currently authorized to work in the US, will you require IBM sponsorship for an employment visa in the future?</p>${radio('sp', 'y', 'Yes')}${radio('sp', 'n', 'No')}</div>
    <div class="q"><p>Have you ever worked at IBM before?</p>${radio('prev', 'y', 'Yes')}${radio('prev', 'n', 'No')}</div>
    <div class="q"><p>Are you a resident of China or South Korea?</p>${radio('res', 'y', 'Yes')}${radio('res', 'n', 'No')}</div>
    <label for="gender">Gender:</label>
    <select id="gender"><option value="">Select</option><option>Female</option><option>Male</option><option>I do not wish to answer</option></select>
    <div class="q"><p>Disability status</p>${radio('dis', 'y', 'Yes, I have a disability')}${radio('dis', 'n', "No, I don't have a disability")}${radio('dis', 'd', "I don't wish to answer")}</div>
    <div class="q"><p>Are you a protected veteran?</p>${radio('vet', 'y', 'Yes')}${radio('vet', 'n', 'No')}</div>
    <label for="sig">Your name:</label><input id="sig">
    <button id="submit" type="submit">Submit</button>
  </form>`

beforeEach(() => {
  document.body.innerHTML = FORM
  nativeRequests.length = 0
  stored = { 'landed:application-answers': { answers } }
})

const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null

test('answers text fields, radio groups, dropdowns and consent; never submits', async () => {
  let submitted = false
  $('#submit').addEventListener('click', () => { submitted = true })
  await fill()

  expect($('#lfn').value).toBe('Alex')
  expect($('#lln').value).toBe('Chen')
  expect($('#pfn').value).toBe('Lex')
  expect($('#dob').value).toBe('March 3')
  expect($('#addr').value).toBe('100 Main St')
  expect($('#zip').value).toBe('98105')
  expect($('#sig').value).toBe('Alex Chen')
  expect($('#country').value).toBe('US')
  expect($('#state').value).toBe('WA')
  expect($('#gender').value).toBe('Male')

  expect(checked('consent')).toBe('y')
  expect($('#privacy').checked).toBe(true)
  expect(checked('pref')).toBe('y')
  expect(checked('auth')).toBe('y')
  expect(checked('sp')).toBe('y')
  expect(checked('prev')).toBe('n')
  expect(checked('dis')).toBe('d')
  expect(checked('vet')).toBe('n')
  // No rule: the local model chose from the saved facts.
  expect(checked('res')).toBe('n')
  const choose = nativeRequests.find((r) => r.type === 'choose_options')
  expect(choose.facts.join('\n')).toMatch(/Country of residence: United States/)
  expect(choose.questions.map((q) => q.question)).toEqual(['Are you a resident of China or South Korea?'])

  expect(submitted).toBe(false)
})

test('consent stays yellow without the switch; nothing is guessed without answers', async () => {
  stored = { 'landed:application-answers': { answers: { ...answers, agree_to_terms: false } } }
  await fill()
  expect(checked('consent')).toBeNull()
  expect($('#privacy').checked).toBe(false)
  expect($('#privacy').getAttribute('data-landed-status')).toBe('review')

  document.body.innerHTML = FORM
  stored = {}
  nativeRequests.length = 0
  const result = await fill()
  expect(checked('auth')).toBeNull()
  expect($('#gender').value).toBe('')
  expect(nativeRequests.some((r) => r.type === 'choose_options')).toBe(false)
  expect(result.manual.length).toBeGreaterThan(5)
})

test('a dialog built as a web component (open shadow root) is filled too', async () => {
  document.body.innerHTML = '<profile-dialog></profile-dialog>'
  const root = document.querySelector('profile-dialog').attachShadow({ mode: 'open' })
  root.innerHTML = `
    <div role="dialog"><h2>Complete Your Profile</h2>
      <label for="fn">Legal first name *</label><input id="fn">
      <label for="zip">Zip Code *</label><input id="zip">
      <fieldset><legend>Are you legally authorized to work in the United States?</legend>
        <label><input type="radio" name="auth" value="y"> Yes</label><label><input type="radio" name="auth" value="n"> No</label></fieldset>
    </div>`
  await fill()
  expect(root.getElementById('fn').value).toBe('Alex')
  expect(root.getElementById('zip').value).toBe('98105')
  expect(root.querySelector('input[name=auth]:checked').value).toBe('y')
  expect(root.getElementById('fn').getAttribute('data-landed-status')).toBe('filled')
  expect(root.getElementById('landed-apply-assist-styles')).not.toBeNull() // outlines show inside the component
})

test('"worked here before?" follows the resume: a saved Yes no longer makes every company Yes', async () => {
  const usBank = (name) => `<fieldset><legend>Have you previously worked as an employee or contractor for U.S. Bank or any of its related companies including any affiliates, subsidiaries, or predecessor organizations such as Elavon, U.S. Bancorp Investments, or Union Bank? If yes, please answer the questions below. *</legend>${radio(name, 'y', 'Yes')}${radio(name, 'n', 'No')}</fieldset>`
  // Saved Yes (from one company's form); the resume shows Stripe, not U.S. Bank.
  stored = { 'landed:application-answers': { answers: { ...answers, previously_employed: 'yes' } } }
  document.body.innerHTML = `<form>${usBank('usb')}</form>`
  await fill()
  expect(checked('usb')).toBeNull()
  expect(document.querySelector('input[name="usb"]').getAttribute('data-landed-status')).toBe('review')

  // Nothing saved: not on the resume → No.
  stored = { 'landed:application-answers': { answers: { ...answers, previously_employed: null } } }
  document.body.innerHTML = `<form>${usBank('usb2')}</form>`
  await fill()
  expect(checked('usb2')).toBe('n')

  // U.S. Bank on the resume → Yes.
  const withUsBank = { ...resume, experience: [...resume.experience, { company: 'U.S. Bank', title: 'Analyst', start_date: '2019-06', end_date: '2021-05', description: '' }] }
  document.body.innerHTML = `<form>${usBank('usb3')}</form>`
  await new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume: withUsBank, aiTakeover: true }, null, resolve))
  expect(checked('usb3')).toBe('y')
})
