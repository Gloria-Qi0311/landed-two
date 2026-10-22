// The user corrects a form Landed filled: what Landed remembers
// (lib/fill/learn.js). Facts that hold for every application only; never
// date of birth, address, EEO, consent, "worked here before?" or open text;
// never a change Landed made itself.

let stored = {}
const sent = []
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage(message, callback) {
      sent.push(message)
      callback?.({ ok: true })
    },
  },
  storage: { local: { get: (key, cb) => cb(typeof key === 'string' ? { [key]: stored[key] } : {}) } },
}

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() { return this.parentNode && this.style.display !== 'none' ? this.parentElement || document.body : null },
})

require('../helpers/content-scripts').loadContentScripts()

const $ = (sel) => document.querySelector(sel)
const { correctionOf } = window.LandedFill

beforeEach(() => {
  sent.length = 0
  stored = { 'landed:application-answers': { answers: { city: 'Seattle', needs_sponsorship: 'no', custom: [] } } }
  document.body.innerHTML = `
    <form>
      <label for="city">City ✱</label><input id="city" value="Bellevue" data-landed-status="filled">
      <label for="start">When can you start?</label><input id="start" value="June 2027">
      <fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
        <label><input type="radio" name="spons" value="1" checked> Yes, I will</label>
        <label><input type="radio" name="spons" value="0"> No</label>
      </fieldset>
      <fieldset><legend>Have you worked at Bluefin before?</legend>
        <label><input type="radio" name="prev" value="1" checked> Yes</label>
        <label><input type="radio" name="prev" value="0"> No</label>
      </fieldset>
      <label for="dob">Date of birth</label><input id="dob" value="1999-10-30">
      <label for="street">Street address</label><input id="street" value="1 Main St">
      <label for="gender">Gender</label><select id="gender"><option>Select</option><option selected>Woman</option></select>
      <label for="why">Why do you want to work here?</label><textarea id="why">Because.</textarea>
      <label for="country">Country</label><select id="country"><option value="">Select…</option><option value="us" selected>United States</option></select>
      <label for="loc">Location</label><input id="loc" value="Bellevue, Washington, United States">
    </form>`
})

test('a fact for every application is read as its saved answer', () => {
  expect(correctionOf($('#city'))).toMatchObject({ key: 'city', value: 'Bellevue' })
  expect(correctionOf($('#start'))).toMatchObject({ key: 'earliest_start', value: 'June 2027' })
  expect(correctionOf(document.querySelector('input[name="spons"]'))).toMatchObject({ key: 'needs_sponsorship', value: 'yes' })
  expect(correctionOf($('#country'))).toMatchObject({ key: 'country', value: 'United States' })
  // A bare "Location" may be where they'd work, not where they live: not kept.
  expect(correctionOf($('#loc'))).toBeNull()
})

test('never a question about one place or amount: its answer isn\'t everyone\'s', () => {
  document.body.innerHTML = `
    <form>
      <fieldset><legend>Are you willing to relocate to Austin, TX?</legend>
        <label><input type="radio" name="reloc" value="0" checked> No</label><label><input type="radio" name="reloc" value="1"> Yes</label>
      </fieldset>
      <fieldset><legend>Are you willing to travel up to 75% of the time?</legend>
        <label><input type="radio" name="travel" value="0" checked> No</label><label><input type="radio" name="travel" value="1"> Yes</label>
      </fieldset>
      <fieldset><legend>Are you willing to relocate?</legend>
        <label><input type="radio" name="reloc2" value="0" checked> No</label><label><input type="radio" name="reloc2" value="1"> Yes</label>
      </fieldset>
    </form>`
  expect(correctionOf(document.querySelector('input[name="reloc"]'))).toBeNull()
  expect(correctionOf(document.querySelector('input[name="travel"]'))).toBeNull()
  expect(correctionOf(document.querySelector('input[name="reloc2"]'))).toMatchObject({ key: 'relocate', value: 'no', question: 'Are you willing to relocate?' })
})

test('never date of birth, street address, EEO, "worked here before?" or open-ended text', () => {
  for (const sel of ['#dob', '#street', '#gender', '#why', 'input[name="prev"]']) expect(correctionOf($(sel))).toBeNull()
})

test('a change Landed made itself (not the user\'s) is never reported', async () => {
  $('#city').dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 20))
  expect(sent.filter((m) => m.action === 'answer-corrected')).toEqual([])
})
