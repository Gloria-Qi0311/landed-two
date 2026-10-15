// Search-box dropdowns (react-select, as on Greenhouse's job boards) and
// file uploads, through the real content.js fill.
//
// The bug this guards: the text pass typed resume values into the dropdowns'
// search boxes, so "School" showed text while nothing was selected and the
// form said "This field is required". Now a dropdown is opened (or searched)
// and a real option is clicked; when nothing fits, the search text is cleared.

const fs = require('fs')
const path = require('path')

const answers = {
  country: 'United States', city: 'Seattle', work_authorized: 'yes', needs_sponsorship: null, preferred_locations: [], custom: [],
  agree_to_terms: false,
}
const pdf = Buffer.from('%PDF-1.4 fake resume').toString('base64')
let stored = {}
const onMessageListeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    sendMessage: (message, callback) => callback?.({ ok: true, values: {}, choices: {} }),
  },
  storage: { local: { get: (key, cb) => cb(typeof key === 'string' ? { [key]: stored[key] } : {}) } },
}

// jsdom has no DataTransfer and only takes a real FileList for input.files.
global.DataTransfer = class {
  constructor() { this.list = [] }
  get items() { return { add: (f) => this.list.push(f) } }
  get files() { return this.list }
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
try { require('../../lib/cross-lingual.js') } catch { /* optional */ }
require('../../lib/choice-answers.js')
require('../../content.js')

const resume = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'sample-resume.json'), 'utf8'))
const fill = () => new Promise((resolve) => onMessageListeners[0]({ action: 'fill', resume, aiTakeover: false }, null, resolve))
const $ = (sel) => document.querySelector(sel)

/** A react-select look-alike: a search box in a control, options rendered
 *  on open (or only after typing, for async search), a hidden input that
 *  holds the selection — the only thing the form checks. */
function select(id, label) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <div class="select__control"><div class="select__single-value"></div>
        <input id="${id}" role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off">
      </div>
      <input type="hidden" name="${id}" value="">
    </div>`
}

function wire(id, options, { asyncSearch = false } = {}) {
  const input = document.getElementById(id)
  const control = input.closest('.select__control')
  const hidden = document.querySelector(`input[type=hidden][name="${id}"]`)
  let menu = null
  const close = () => { menu?.remove(); menu = null; input.setAttribute('aria-expanded', 'false') }
  const render = (list) => {
    close()
    menu = document.createElement('div')
    menu.id = `${id}-listbox`
    list.forEach((text, i) => {
      // As react-select ≤ 5.6 renders them: no role, just a class and an id.
      const o = document.createElement('div')
      o.className = 'select__option'
      o.id = `react-select-${id}-option-${i}`
      o.textContent = text
      o.addEventListener('click', () => {
        hidden.value = text
        control.querySelector('.select__single-value').textContent = text
        input.value = ''
        close()
      })
      menu.appendChild(o)
    })
    control.parentElement.appendChild(menu)
    input.setAttribute('aria-expanded', 'true')
  }
  const openAll = () => { if (!asyncSearch) render(options) }
  control.addEventListener('mousedown', openAll)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') openAll()
    if (e.key === 'Escape') close()
  })
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase()
    if (!q) return close()
    const run = () => render(options.filter((o) => o.toLowerCase().includes(q)))
    if (asyncSearch) setTimeout(run, 400)
    else run()
  })
  return hidden
}

beforeEach(() => {
  stored = {
    'landed:application-answers': { answers },
    'landed:application-files': { resume: { id: 'f1', name: 'Alex Chen Resume.pdf', mime: 'application/pdf', data: pdf }, cover_letter: null },
  }
  document.body.innerHTML = `
    <form>
      ${select('school', 'School')}
      ${select('degree', 'Degree')}
      ${select('country', 'Country')}
      ${select('city', 'Location (City)')}
      ${select('auth', 'Are you legally authorized to work in the United States?')}
      ${select('discipline', 'Discipline')}
      <label for="resume">Resume/CV</label><input type="file" id="resume" accept=".pdf,.doc,.docx,.txt,.rtf">
      <label for="cover">Cover Letter</label><input type="file" id="cover" accept=".pdf,.doc,.docx">
      <button id="submit" type="submit">Submit application</button>
    </form>`
  for (const id of ['resume', 'cover']) {
    const el = document.getElementById(id)
    let files = []
    Object.defineProperty(el, 'files', { configurable: true, get: () => files, set: (v) => { files = v } })
  }
})

test('dropdowns get a real option; nothing typed is left behind; files are attached; never submits', async () => {
  const school = wire('school', ['Harvard University', 'Stanford University', 'University of Washington'], { asyncSearch: true })
  const degree = wire('degree', ["Bachelor's Degree", "Master's Degree", 'Doctor of Philosophy (Ph.D.)'])
  const country = wire('country', ['Canada', 'United States', 'Mexico'])
  const city = wire('city', ['Seattle, Washington, United States', 'Seaside, Oregon, United States'], { asyncSearch: true })
  const auth = wire('auth', ['Yes', 'No'])
  const discipline = wire('discipline', ['Accounting', 'Engineering'])
  let submitted = false
  $('#submit').addEventListener('click', () => { submitted = true })
  let changed = 0
  $('#resume').addEventListener('change', () => { changed++ })

  const result = await fill()

  expect(school.value).toBe('Stanford University')
  expect(degree.value).toBe("Master's Degree")
  expect(country.value).toBe('United States')
  expect(city.value).toBe('Seattle, Washington, United States')
  expect(auth.value).toBe('Yes')
  // No matching option for this one: left empty and yellow, no stray search text.
  expect(discipline.value).toBe('')
  for (const id of ['school', 'degree', 'country', 'city', 'auth', 'discipline']) {
    expect(document.getElementById(id).value).toBe('')
  }

  expect($('#resume').files.map((f) => f.name)).toEqual(['Alex Chen Resume.pdf'])
  expect(changed).toBe(1)
  expect($('#resume').getAttribute('data-landed-status')).toBe('filled')
  expect($('#cover').files).toEqual([])
  expect($('#cover').getAttribute('data-landed-status')).toBe('review')
  expect(result.filled).toEqual(expect.arrayContaining(['file:resume', 'answer:country', 'answer:city', 'answer:work_authorized']))
  expect(submitted).toBe(false)
}, 20_000)

test('a file the field doesn\'t accept is left for the user', async () => {
  wire('school', [])
  $('#resume').setAttribute('accept', '.docx')
  await fill()
  expect($('#resume').files).toEqual([])
  expect($('#resume').getAttribute('data-landed-status')).toBe('review')
}, 20_000)
