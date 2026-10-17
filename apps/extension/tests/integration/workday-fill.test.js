// Workday regression coverage. Real Workday pages expose stable
// data-automation-id attributes, portal their dropdown options to <body>,
// and use aria-haspopup="true" for unrelated global controls like Settings.

const fs = require('fs')
const path = require('path')

const answers = {
  legal_first_name: 'Alice', legal_last_name: 'Wong', address_line1: '123 Main Street',
  city: 'Seattle', state: 'Washington', postal_code: '98101', country: 'United States',
  heard_from: 'LinkedIn', preferred_locations: [], custom: [], agree_to_terms: false,
}
let stored = {}
const listeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: (_message, callback) => callback?.({ ok: true, values: {} }),
  },
  storage: { local: { get: (key, cb) => cb({ [key]: stored[key] }) } },
}

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() { return this.parentNode ? this.parentElement || document.body : null },
})
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 }
}

require('../../schema.js')
require('../../lib/field-detect.js')
require('../../lib/value-match.js')
require('../../lib/cross-lingual.js')
require('../../lib/choice-answers.js')
window.LandedPortalParsers = { workday: { isWorkdayUrl: () => true } }
require('../../content.js')

const resume = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'sample-resume.json'), 'utf8'))
const fill = (resumeData = resume) => new Promise((resolve) => listeners[0]({ action: 'fill', resume: resumeData }, null, resolve))

function wireButton(id, options) {
  const button = document.getElementById(id)
  button.addEventListener('click', () => {
    if (document.getElementById(`${id}-list`)) return
    const list = document.createElement('div')
    list.id = `${id}-list`
    list.setAttribute('role', 'listbox')
    for (const text of options) {
      const option = document.createElement('div')
      option.setAttribute('role', 'option')
      option.textContent = text
      option.addEventListener('click', () => {
        button.dataset.selected = text
        button.textContent = text
        button.setAttribute('aria-expanded', 'false')
        list.remove()
      })
      list.appendChild(option)
    }
    document.body.appendChild(list)
    button.setAttribute('aria-controls', list.id)
    button.setAttribute('aria-expanded', 'true')
  })
}

function wireCity() {
  const input = document.getElementById('city')
  const render = () => {
    document.getElementById('city-list')?.remove()
    const list = document.createElement('div')
    list.id = 'city-list'
    list.setAttribute('role', 'listbox')
    for (const text of ['Seattle Hill, Washington, United States', 'Seattle, Washington, United States', 'Laredo, Texas, United States']) {
      const option = document.createElement('div')
      option.setAttribute('role', 'option')
      option.textContent = text
      option.addEventListener('click', () => {
        input.dataset.selected = text
        input.value = ''
        input.setAttribute('aria-expanded', 'false')
        list.remove()
      })
      list.appendChild(option)
    }
    document.body.appendChild(list)
    input.setAttribute('aria-controls', list.id)
    input.setAttribute('aria-expanded', 'true')
  }
  input.addEventListener('input', render)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.getElementById('city-list')?.remove()
  })
}

function wireSearch(id, options) {
  const input = document.getElementById(id)
  input.addEventListener('input', () => {
    document.getElementById(`${id}-list`)?.remove()
    const list = document.createElement('div')
    list.id = `${id}-list`
    list.setAttribute('role', 'listbox')
    for (const text of options) {
      const option = document.createElement('div')
      option.setAttribute('role', 'option')
      option.textContent = text
      option.addEventListener('click', () => {
        input.dataset.selected = text
        input.value = ''
        input.setAttribute('aria-expanded', 'false')
        list.remove()
      })
      list.appendChild(option)
    }
    document.body.appendChild(list)
    input.setAttribute('aria-controls', list.id)
    input.setAttribute('aria-expanded', 'true')
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.getElementById(`${id}-list`)?.remove()
  })
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?utm_source=linkedin')
  stored = { 'landed:application-answers': { answers }, 'landed:application-files': {} }
  document.body.innerHTML = `
    <button id="settings" aria-haspopup="true" data-automation-id="globalNavigationSettings">Settings</button>
    <form>
      <input id="first" data-automation-id="legalNameSection_firstName">
      <input id="last" data-automation-id="legalNameSection_lastName">
      <input id="street" data-automation-id="addressSection_addressLine1">
      <input id="city" role="combobox" aria-autocomplete="list" aria-expanded="false" data-automation-id="addressSection_city">
      <button id="country" type="button" aria-haspopup="listbox" aria-expanded="false" data-automation-id="countryDropdown">Country</button>
      <button id="source" type="button" aria-haspopup="listbox" aria-expanded="false" data-automation-id="sourceDropdown">Source</button>
      <button id="submit" type="submit">Save and Continue</button>
    </form>`
})

test('fills Workday controls without touching Settings, wrong city, or submit', async () => {
  let settingsClicks = 0
  let submitClicks = 0
  document.getElementById('settings').addEventListener('click', () => { settingsClicks++ })
  document.getElementById('submit').addEventListener('click', (event) => { event.preventDefault(); submitClicks++ })
  wireButton('country', ['Canada', 'United States', 'Mexico'])
  wireButton('source', ['Company Website', 'LinkedIn', 'Employee Referral'])
  wireCity()

  const result = await fill()

  expect(document.getElementById('first').value).toBe('Alice')
  expect(document.getElementById('last').value).toBe('Wong')
  expect(document.getElementById('street').value).toBe('123 Main Street')
  expect(document.getElementById('country').dataset.selected).toBe('United States')
  expect(document.getElementById('source').dataset.selected).toBe('LinkedIn')
  expect(document.getElementById('city').dataset.selected).toBe('Seattle, Washington, United States')
  expect(settingsClicks).toBe(0)
  expect(submitClicks).toBe(0)
  expect(result.filled).toEqual(expect.arrayContaining([
    'answer:legal_first_name', 'answer:legal_last_name', 'answer:address_line1',
    'answer:country', 'answer:city', 'answer:heard_from',
  ]))
}, 15_000)

test('repairs the exact corrupt values seen on a real U.S. Bank Workday form', async () => {
  const dirtyResume = {
    ...resume,
    basic: {
      ...resume.basic,
      name: 'Alex Chen', firstName: 'Alex', lastName: 'Chen',
      location: 'Seattle', phone: '+1 206-555-0100',
    },
  }
  stored['landed:application-answers'] = { answers: {
    ...answers,
    legal_first_name: 'Alex', legal_middle_name: 'Alex Chen', legal_last_name: 'Chen',
    address_line1: 'Seattle', address_line2: 'Seattle', city: 'Seattle',
    state: null, postal_code: null, heard_from: null, previously_employed: null,
  } }
  document.body.innerHTML = `
    <button id="settings" aria-haspopup="true" data-automation-id="globalNavigationSettings">Settings</button>
    <form>
      <label for="first">First Name</label><input id="first" value="Alex" data-automation-id="legalNameSection_firstName">
      <label for="middle">Middle Name</label><input id="middle" value="Alex Chen" data-automation-id="legalNameSection_middleName">
      <label for="last">Last Name</label><input id="last" value="Chen" data-automation-id="legalNameSection_lastName">
      <label for="street">Address Line 1</label><input id="street" value="Seattle" data-automation-id="addressSection_addressLine1">
      <label for="line2">Address Line 2</label><input id="line2" value="Seattle" data-automation-id="addressSection_addressLine2">
      <label for="city">City</label><input id="city" value="Seattle" data-automation-id="addressSection_city">
      <label for="postal">Postal Code</label><input id="postal" data-automation-id="addressSection_postalCode">
      <label for="source">How Did You Hear About Us?</label>
      <input id="source" role="combobox" aria-autocomplete="list" aria-expanded="false" data-automation-id="sourceDropdown">
      <label for="state">State</label><button id="state" type="button" aria-haspopup="listbox" data-automation-id="stateDropdown">Select One</button>
      <label for="country">Country</label><button id="country" type="button" aria-haspopup="listbox" data-automation-id="countryDropdown">United States of America</button>
      <label for="device">Phone Device Type</label><button id="device" type="button" aria-haspopup="listbox" data-automation-id="phoneDeviceType">Mobile</button>
      <div><label for="country-code">Country Phone Code</label>
        <input id="country-code" role="combobox" data-automation-id="countryPhoneCode">
        <div role="list">United States of America (+1)</div>
      </div>
      <label for="phone">Phone Number</label><input id="phone" value="+1 206-555-0100" data-automation-id="phone-number">
      <label for="extension">Phone Extension</label><input id="extension" value="+1 206-555-0100" data-automation-id="phone-extension">
      <button id="submit" type="submit">Save and Continue</button>
    </form>`

  let countryClicks = 0
  let deviceClicks = 0
  let settingsClicks = 0
  let submitClicks = 0
  document.getElementById('country').addEventListener('click', () => { countryClicks++ })
  document.getElementById('device').addEventListener('click', () => { deviceClicks++ })
  document.getElementById('settings').addEventListener('click', () => { settingsClicks++ })
  document.getElementById('submit').addEventListener('click', (event) => { event.preventDefault(); submitClicks++ })
  wireSearch('source', ['Company Website', 'LinkedIn', 'Employee Referral'])

  const result = await fill(dirtyResume)

  expect(document.getElementById('middle').value).toBe('')
  expect(document.getElementById('street').value).toBe('')
  expect(document.getElementById('line2').value).toBe('')
  expect(document.getElementById('city').value).toBe('Seattle')
  expect(document.getElementById('phone').value).toBe('2065550100')
  expect(document.getElementById('extension').value).toBe('')
  expect(document.getElementById('source').dataset.selected).toBe('LinkedIn')
  expect(countryClicks).toBe(0)
  expect(deviceClicks).toBe(0)
  expect(settingsClicks).toBe(0)
  expect(submitClicks).toBe(0)
  expect(result.manual.map((item) => item.label)).toEqual(expect.arrayContaining(['Address Line 1', 'Postal Code', 'State']))
}, 15_000)
