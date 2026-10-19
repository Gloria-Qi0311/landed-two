// Workday's "My Experience" page through the real content scripts
// (lib/fill/experience.js): every job and internship on the resume becomes
// its own Work Experience entry ("Add Another" for more), newest first, with
// its own location and MM/YYYY dates; Education gets its entry from "Add".
// The page-wide rules don't touch these fields: a job's Location is never
// the user's own city. Made-up person; the DOM follows Workday's
// data-automation-id structure.

let stored = {}
const listeners = []
global.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    // No local model here; it must not be asked about entry fields anyway.
    sendMessage: (message, callback) => {
      if (message?.request?.type === 'match_fields') asked.push(...message.request.fields.map((f) => f.label))
      callback?.({ ok: true, values: {} })
    },
  },
  storage: { local: { get: (key, cb) => cb({ [key]: stored[key] }) } },
}
const asked = []

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() { return this.parentNode ? this.parentElement || document.body : null },
})
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 }
}

require('../helpers/content-scripts').loadContentScripts({
  before: () => { window.LandedPortalParsers = { workday: { isWorkdayUrl: () => true } } },
})

const resume = {
  basic: { name: 'Alex Chen', firstName: 'Alex', lastName: 'Chen', email: 'alex.chen@example.com', phone: '+1 206 555 0100', location: 'Seattle, WA' },
  experience: [{ company: 'Northwind', title: 'Product Analyst', location: 'Bellevue, WA', start_date: '2023-01', end_date: '', current: true, description: '• Built the pricing dashboard.\n• Cut report time in half.' }],
  internship: [{ company: 'Globex', title: 'Product Management Intern', location: 'Redmond, WA', start_date: '2022-06', end_date: '2022-09', current: false, description: '• Shipped onboarding emails.' }],
  education: [{ school: 'University of Washington', degree: "Master's", major: 'Information Management', gpa: '3.9', start_date: '2021-09', end_date: '2023-06' }],
  projects: [], skills: ['SQL'], languages: [], summary: '',
}
const answers = { city: 'Seattle', state: 'Washington', country: 'United States', preferred_locations: [], custom: [], agree_to_terms: false }

const date = (n, which, label) => `
  <div data-automation-id="formField-${which}"><label>${label}<abbr>*</abbr></label>
    <div data-automation-id="dateInputWrapper">
      <input id="${n}-${which}-m" data-automation-id="dateSectionMonth-input" role="spinbutton" aria-label="Month" placeholder="MM">
      <input id="${n}-${which}-y" data-automation-id="dateSectionYear-input" role="spinbutton" aria-label="Year" placeholder="YYYY">
    </div>
  </div>`

const workEntry = (n) => `
  <div data-automation-id="workExperience-${n}" role="group" aria-labelledby="w${n}-h">
    <h4 id="w${n}-h">Work Experience ${n}</h4>
    <div data-automation-id="formField-jobTitle"><label for="w${n}-title">Job Title<abbr>*</abbr></label><input id="w${n}-title" aria-required="true"></div>
    <div data-automation-id="formField-companyName"><label for="w${n}-company">Company<abbr>*</abbr></label><input id="w${n}-company" aria-required="true"></div>
    <div data-automation-id="formField-location"><label for="w${n}-loc">Location</label><input id="w${n}-loc"></div>
    <div data-automation-id="formField-currentlyWorkHere"><label for="w${n}-cur">I currently work here</label><input type="checkbox" id="w${n}-cur"></div>
    ${date(`w${n}`, 'startDate', 'From')}
    ${date(`w${n}`, 'endDate', 'To')}
    <div data-automation-id="formField-roleDescription"><label for="w${n}-desc">Role Description</label><textarea id="w${n}-desc"></textarea></div>
  </div>`

const educationEntry = (n) => `
  <div data-automation-id="education-${n}" role="group">
    <h4>Education ${n}</h4>
    <div data-automation-id="formField-schoolName"><label for="e${n}-school">School or University<abbr>*</abbr></label><input id="e${n}-school"></div>
    <div data-automation-id="formField-degree"><label for="e${n}-degree">Degree<abbr>*</abbr></label>
      <select id="e${n}-degree"><option value="">Select One</option><option>Bachelor's Degree</option><option>Master's Degree</option><option>Doctorate</option></select></div>
    <div data-automation-id="formField-fieldOfStudy"><label for="e${n}-field">Field of Study</label><input id="e${n}-field"></div>
    <div data-automation-id="formField-gradeAverage"><label for="e${n}-gpa">Overall Result (GPA)</label><input id="e${n}-gpa"></div>
    <div data-automation-id="formField-firstYearAttended"><label>From</label><input id="e${n}-from" data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY"></div>
    <div data-automation-id="formField-lastYearAttended"><label>To (Actual or Expected)</label><input id="e${n}-to" data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY"></div>
  </div>`

/** "Add" / "Add Another" adds an entry the way Workday does, after a beat. */
function wireAdd(sectionId, make) {
  const section = document.querySelector(`[data-automation-id="${sectionId}"]`)
  const button = section.querySelector('[data-automation-id="add-button"]')
  button.addEventListener('click', () => {
    setTimeout(() => {
      const n = section.querySelectorAll('[role="group"][data-automation-id]').length + 1
      button.insertAdjacentHTML('beforebegin', make(n))
      button.textContent = 'Add Another'
    }, 150)
  })
}

const $ = (sel) => document.querySelector(sel)
const fill = () => new Promise((resolve) => listeners[0]({ action: 'fill', resume, aiTakeover: true }, null, resolve))

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  asked.length = 0
  stored = { 'landed:application-answers': { answers }, 'landed:application-files': {} }
  document.body.innerHTML = `
    <form>
      <h2>My Experience</h2>
      <div data-automation-id="workExperienceSection">
        <h3>Work Experience</h3>
        ${workEntry(1)}
        <button type="button" data-automation-id="add-button" aria-label="Add Another Work Experience">Add Another</button>
      </div>
      <div data-automation-id="educationSection">
        <h3>Education</h3>
        <button type="button" data-automation-id="add-button" aria-label="Add Education">Add</button>
      </div>
      <button id="next" type="submit">Save and Continue</button>
    </form>`
  wireAdd('workExperienceSection', workEntry)
  wireAdd('educationSection', educationEntry)
})

test('every job and internship gets its own entry, newest first, with its own location and dates', async () => {
  let submitted = false
  $('#next').addEventListener('click', () => { submitted = true })
  await fill()

  // The current job first…
  expect($('#w1-title').value).toBe('Product Analyst')
  expect($('#w1-company').value).toBe('Northwind')
  expect($('#w1-loc').value).toBe('Bellevue, WA')
  expect($('#w1-cur').checked).toBe(true)
  expect([$('#w1-startDate-m').value, $('#w1-startDate-y').value]).toEqual(['01', '2023'])
  expect([$('#w1-endDate-m').value, $('#w1-endDate-y').value]).toEqual(['', ''])
  expect($('#w1-desc').value).toContain('Built the pricing dashboard.')
  // …then the internship, in an entry "Add Another" made.
  expect($('#w2-title').value).toBe('Product Management Intern')
  expect($('#w2-company').value).toBe('Globex')
  expect($('#w2-loc').value).toBe('Redmond, WA')
  expect($('#w2-cur').checked).toBe(false)
  expect([$('#w2-startDate-m').value, $('#w2-startDate-y').value, $('#w2-endDate-m').value, $('#w2-endDate-y').value]).toEqual(['06', '2022', '09', '2022'])
  expect(document.querySelectorAll('[data-automation-id^="workExperience-"]')).toHaveLength(2)

  // Education, from "Add".
  expect($('#e1-school').value).toBe('University of Washington')
  expect($('#e1-degree').value).toBe("Master's Degree")
  expect($('#e1-field').value).toBe('Information Management')
  expect($('#e1-gpa').value).toBe('3.9')
  expect([$('#e1-from').value, $('#e1-to').value]).toEqual(['2021', '2023'])

  for (const id of ['w1-title', 'w1-loc', 'w2-company', 'e1-school']) expect($(`#${id}`).getAttribute('data-landed-status')).toBe('filled')
  // The local model wasn't asked to guess any entry field.
  expect(asked).toEqual([])
  expect(submitted).toBe(false)
}, 20_000)

test("a job without a location leaves Location empty — never the user's own city", async () => {
  const noLocation = { ...resume, experience: [{ ...resume.experience[0], location: '' }], internship: [] }
  await new Promise((resolve) => listeners[0]({ action: 'fill', resume: noLocation, aiTakeover: true }, null, resolve))
  expect($('#w1-title').value).toBe('Product Analyst')
  expect($('#w1-loc').value).toBe('')
}, 20_000)

test("Workday's school search box: typed, Enter, and the matching result picked", async () => {
  // As on Workday: "Type the name of your school … and press Enter".
  const promptSchool = (n) => educationEntry(n).replace(
    `<div data-automation-id="formField-schoolName"><label for="e${n}-school">School or University<abbr>*</abbr></label><input id="e${n}-school"></div>`,
    `<div data-automation-id="formField-schoolName"><label for="e${n}-school">School or University<abbr>*</abbr></label>
      <div data-automation-id="multiselectInputContainer"><input id="e${n}-school" data-automation-id="searchBox" placeholder="Search"></div>
      <span data-automation-id="promptIcon"></span><div id="e${n}-picked" data-automation-id="selectedItem"></div></div>`)
  document.querySelector('[data-automation-id="educationSection"]').outerHTML = `
    <div data-automation-id="educationSection"><h3>Education</h3>
      <button type="button" data-automation-id="add-button" aria-label="Add Education">Add</button></div>`
  wireAdd('educationSection', (n) => {
    setTimeout(() => {
      const input = document.getElementById(`e${n}-school`)
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return
        ev.preventDefault()
        setTimeout(() => {
          const list = document.createElement('div')
          list.setAttribute('role', 'listbox')
          for (const name of ['University of Washington Tacoma', 'University of Washington', 'Washington State University']) {
            const o = document.createElement('div')
            o.setAttribute('role', 'option')
            o.textContent = name
            o.addEventListener('click', () => {
              document.getElementById(`e${n}-picked`).textContent = name
              input.value = ''
              list.remove()
            })
            list.appendChild(o)
          }
          document.body.appendChild(list)
        }, 200)
      })
    }, 0)
    return promptSchool(n)
  })
  await fill()
  expect($('#e1-picked').textContent).toBe('University of Washington')
  expect($('#e1-degree').value).toBe("Master's Degree")
}, 20_000)
