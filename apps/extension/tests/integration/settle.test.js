// After a fill, every field marked filled must really hold its value
// (lib/fill/settle.js), through the real content scripts:
// - a "type, then pick from the list" box that doesn't say so (Lever's
//   Current location: a plain input, options in plain divs, cleared on blur
//   unless one was picked) is typed into and its matching suggestion picked;
// - a field the page clears anyway turns yellow with the reason, never green;
// - optional questions nothing answers aren't yellow or counted, and are
//   still asked once.

const fs = require('fs')
const path = require('path')

let stored = {}
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      if (message?.action === 'native-assist') return callback?.({ ok: false, error: 'not available' })
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
const send = (msg) => new Promise((resolve) => onMessageListeners[0](msg, null, resolve))
const fill = () => send({ action: 'fill', resume, aiTakeover: true })
const $ = (sel) => document.querySelector(sel)

/** Lever's location box, as it behaves: searches on keyup (results come a
 *  moment later), fills a hidden field when a result is clicked, and clears
 *  the text on blur when none was. */
function wireLeverLocation(places) {
  const input = $('#location-input')
  const hidden = $('#selected-location')
  const results = $('.dropdown-results')
  input.addEventListener('keyup', () => {
    const q = input.value.toLowerCase()
    setTimeout(() => {
      results.innerHTML = ''
      for (const [i, place] of places.filter((p) => p.toLowerCase().startsWith(q)).entries()) {
        const div = document.createElement('div')
        div.className = 'dropdown-location'
        div.id = `location-${i}`
        div.textContent = place
        div.addEventListener('click', () => { input.value = place; hidden.value = JSON.stringify({ name: place }); results.innerHTML = '' })
        results.appendChild(div)
      }
    }, 200)
  })
  input.addEventListener('blur', () => { if (!hidden.value) input.value = '' })
}

const FORM = `
  <form>
    <label for="name">Full name ✱</label><input id="name" required>
    <label for="email">Email ✱</label><input id="email" type="email" required>
    <label>
      <div class="application-label">Current location ✱</div>
      <div class="application-field">
        <input class="location-input" id="location-input" type="text" name="location" required>
        <input id="selected-location" type="hidden" name="selectedLocation">
        <div class="dropdown-container"><div class="dropdown-results"></div></div>
      </div>
    </label>
    <label for="twitter">Twitter URL</label><input id="twitter">
    <label for="shirt">What is your T-shirt size?</label><input id="shirt">
    <label for="team">Which team are you most excited about? ✱</label><input id="team" required>
    <button id="submit" type="submit">Submit</button>
  </form>`

beforeEach(() => {
  document.body.innerHTML = FORM
  stored = { 'landed:application-answers': { answers: { agree_to_terms: false, custom: [] } } }
})

test('a location box that only takes a picked suggestion gets the matching one picked, and stays green', async () => {
  // The resume says "San Francisco, CA": the place named exactly that wins
  // over South San Francisco and San Francisco Bay Area.
  wireLeverLocation(['San Francisco Bay Area, CA, USA', 'San Francisco, CA, USA', 'San Fernando, CA, USA', 'South San Francisco, CA, USA'])
  let submits = 0
  $('#submit').addEventListener('click', (e) => { e.preventDefault(); submits++ })
  const result = await fill()
  expect($('#location-input').value).toBe('San Francisco, CA, USA')
  expect(JSON.parse($('#selected-location').value)).toEqual({ name: 'San Francisco, CA, USA' })
  expect($('#location-input').getAttribute('data-landed-status')).toBe('filled')
  expect(result.lost).toEqual([])
  expect(result.manual.map((m) => m.label)).not.toContain('Current location ✱')
  expect(submits).toBe(0)
}, 20_000)

test('a button, link or submit that reads like the value is never clicked, even inside the suggestion list', async () => {
  // Only controls show up: a submit button and a link with the very text.
  const input = $('#location-input')
  const results = $('.dropdown-results')
  let submits = 0
  let followed = 0
  $('form').addEventListener('submit', (e) => { e.preventDefault(); submits++ })
  input.addEventListener('keyup', () => {
    setTimeout(() => {
      results.innerHTML = '<button>San Francisco, CA, USA</button><a href="#sf">San Francisco, CA, USA</a><div role="button">San Francisco, CA, USA</div>'
      results.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); followed++ })
      results.querySelector('[role="button"]').addEventListener('click', () => { followed++ })
    }, 100)
  })
  input.addEventListener('blur', () => { if (!$('#selected-location').value) input.value = '' })
  const result = await fill()
  expect(submits).toBe(0)
  expect(followed).toBe(0)
  // Nothing was picked: the page cleared it, and it says so.
  expect(result.lost).toHaveLength(1)
  expect(result.lost[0]).toMatch(/^Current location/)
}, 20_000)

test('a field the page clears anyway turns yellow with the reason — never green and empty', async () => {
  // No suggestions ever: the box just drops what was typed on blur.
  $('#location-input').addEventListener('blur', () => { $('#location-input').value = '' })
  const result = await fill()
  const el = $('#location-input')
  expect(el.value).toBe('')
  expect(el.getAttribute('data-landed-status')).toBe('review')
  expect(el.getAttribute('data-landed-note')).toMatch(/didn't keep the value/)
  expect(result.lost).toEqual(['Current location ✱'])
  expect(result.manual.find((m) => m.label === 'Current location ✱')).toMatchObject({ hint: '没留住' })
  // Fields that kept their value stay green.
  expect($('#name').getAttribute('data-landed-status')).toBe('filled')
}, 20_000)

test('optional questions nothing answers are not yellow or counted, and are still asked once', async () => {
  wireLeverLocation(['San Francisco, CA, USA'])
  const result = await fill()
  for (const id of ['#twitter', '#shirt']) expect($(id).getAttribute('data-landed-status')).toBe('blank')
  expect(result.optional_blank).toEqual(expect.arrayContaining(['Twitter URL', 'What is your T-shirt size?']))
  const yellow = result.manual.map((m) => m.label)
  expect(yellow).not.toContain('Twitter URL')
  expect(yellow).not.toContain('What is your T-shirt size?')
  // A required one nothing answers stays the user's to-do.
  expect(yellow).toContain('Which team are you most excited about? ✱')
  expect(result.unanswered.map((q) => q.question)).toEqual(expect.arrayContaining(['What is your T-shirt size?']))
  // For an approved application only required questions stop the submit:
  // optional ones come back marked, so they're asked but never count.
  const byQuestion = Object.fromEntries(result.unanswered.map((q) => [q.question, q]))
  expect(byQuestion['What is your T-shirt size?'].optional).toBe(true)
  expect(byQuestion['Which team are you most excited about? ✱']).toBeDefined()
  expect(byQuestion['Which team are you most excited about? ✱'].optional).toBeUndefined()
}, 20_000)

test('a dropdown holds its choice when the choice shows beside an empty search box (react-select), not when it shows a placeholder', () => {
  const { holds } = window.LandedFill
  document.body.innerHTML = `
    <div class="question"><label for="city">Location (City)*</label>
      <div class="select__control"><div class="select__value-container">
        <div class="select__single-value">Seattle, Washington, United States</div>
        <input id="city" role="combobox" aria-autocomplete="list" value="">
      </div><div class="select__indicators"></div></div>
    </div>
    <div class="question"><label for="gender">Gender</label>
      <div class="select__control"><div class="select__value-container">
        <div class="select__placeholder">Select...</div>
        <input id="gender" role="combobox" aria-autocomplete="list" value="">
      </div></div>
    </div>`
  expect(holds($('#city'))).toBe(true)
  expect(holds($('#gender'))).toBe(false)
})

test('a company or school is picked only when it is the same name — never a different one that starts alike', () => {
  const { pickSuggestion } = window.LandedFill
  expect(pickSuggestion('Google', ['Google Cloud', 'Google LLC', 'Googleplex'], false)).toBe(1)
  expect(pickSuggestion('Google', ['Google Cloud', 'Google DeepMind'], false)).toBe(-1)
  expect(pickSuggestion('University of Washington', ['University of Washington Tacoma', 'University of Washington - Seattle'], false)).toBe(1)
  expect(pickSuggestion('Stripe, Inc.', ['Stripe'], false)).toBe(0)
  expect(pickSuggestion('Seattle, WA', ['Seattle Hill, WA, USA', 'Seattle, WA, USA'], true)).toBe(1)
})

test('the popup can show a field left for the user: it gets focus', async () => {
  document.body.innerHTML = FORM
  const result = await fill()
  const team = result.manual.find((m) => m.label === 'Which team are you most excited about? ✱')
  const shown = await send({ action: 'focus-field', id: team.id })
  expect(shown).toEqual({ ok: true })
  expect(document.activeElement).toBe($('#team'))
  expect(await send({ action: 'focus-field', id: 'landed-nope' })).toEqual({ ok: false })
}, 20_000)
