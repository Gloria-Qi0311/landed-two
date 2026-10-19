// @ts-check
// lib/fill/experience.js — the repeating sections of English application
// forms, Workday's "My Experience" first. Work Experience gets every job and
// internship on the resume, newest first, one entry each ("Add" for the
// first, "Add Another" for more); Education gets each school. Each entry gets
// its own values: job title, company, that job's location, "I currently work
// here", From / To (MM/YYYY), role description; school, degree, field of
// study, GPA, years. The section owns its fields, so the page-wide rules
// (the user's own city, only the current job) never touch them.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { addManual, chooseInCombobox, clickChoice, deepAll, fillField, isCustomComboboxTrigger, isRendered, markField, setTextFieldValue, sleep, tryFillSelect } = F;
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const VM = global.ResumeFillerValueMatch;

const MAX_ENTRIES = 8;

const SECTIONS = {
  work: {
    automation: 'workExperienceSection',
    heading: /^(work experience|work history|employment( history)?|professional experience)$/i,
    entry: /^workExperience-\d+$/,
    entryHeading: /^work experience \d+$/i,
  },
  education: {
    automation: 'educationSection',
    heading: /^(education|education history)$/i,
    entry: /^education-\d+$/,
    entryHeading: /^education \d+$/i,
  },
};

// Each field of an entry: Workday's wrapper id, else its label.
const FIELDS = {
  title: { automation: /^formField-jobTitle$/, label: /^(job )?title\b|^position\b/i },
  company: { automation: /^formField-company(Name)?$/, label: /^company( name)?\b|^employer\b/i },
  location: { automation: /^formField-location$/, label: /^location\b/i },
  current: { automation: /^formField-currentlyWorkHere$/, label: /currently work here|i currently work|current(ly)? employed/i },
  from: { automation: /^formField-(startDate|firstYearAttended)$/, label: /^from\b|^start( date)?\b|first year/i },
  to: { automation: /^formField-(endDate|lastYearAttended)$/, label: /^to\b|^end( date)?\b|last year|graduation/i },
  description: { automation: /^formField-roleDescription$/, label: /role description|^description|responsibilit/i },
  school: { automation: /^formField-school(Name)?$/, label: /school|university|institution|college/i },
  degree: { automation: /^formField-degree$/, label: /^degree\b/i },
  field: { automation: /^formField-fieldOfStudy$/, label: /field of study|^major\b|discipline/i },
  gpa: { automation: /^formField-gradeAverage$/, label: /overall result|\bgpa\b|grade average/i },
};

const text = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
const aid = (el) => (el && el.getAttribute && el.getAttribute('data-automation-id')) || '';

// ── where the sections and their entries are ──────────────────────────────

function findSection(kind) {
  const spec = SECTIONS[kind];
  const byId = deepAll(`[data-automation-id="${spec.automation}"]`)[0];
  if (byId) return byId;
  const heading = deepAll('h2, h3, h4, legend, [role="heading"]').find((h) => spec.heading.test(text(h)) && isRendered(h));
  if (!heading) return null;
  // The smallest container that has its entries or its Add button.
  let p = heading.parentElement;
  for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
    if (entriesIn(p, kind).length || addButtonIn(p)) return p;
  }
  return null;
}

function entriesIn(section, kind) {
  const spec = SECTIONS[kind];
  const byId = Array.from(section.querySelectorAll('[data-automation-id]')).filter((el) => spec.entry.test(aid(el)));
  if (byId.length) return byId;
  return Array.from(section.querySelectorAll('h3, h4, h5, legend, [role="heading"]'))
    .filter((h) => spec.entryHeading.test(text(h)))
    .map((h) => {
      let p = h.parentElement;
      while (p && p !== section && p.querySelectorAll('input, textarea').length < 2) p = p.parentElement;
      return p;
    })
    .filter((p) => p && p !== section);
}

function addButtonIn(section) {
  return Array.from(section.querySelectorAll('button, [role="button"]')).find((b) => {
    const said = `${text(b)} ${b.getAttribute('aria-label') || ''}`.trim();
    return /^add( another)?\b/i.test(said) && isRendered(b) && !b.closest('[data-automation-id^="formField-"]');
  }) || null;
}

/** The i-th entry, adding entries until there is one (null if the page
 *  doesn't add any). */
async function entryAt(section, kind, i) {
  for (let tries = 0; tries <= i + 1; tries++) {
    const list = entriesIn(section, kind);
    if (list[i]) return list[i];
    const add = addButtonIn(section);
    if (!add) return null;
    add.click();
    let grown = false;
    for (let t = 0; t < 30 && !grown; t++) {
      await sleep(100);
      grown = entriesIn(section, kind).length > list.length;
    }
    if (!grown) return null;
  }
  return null;
}

/** The control(s) for one field of an entry. */
function fieldIn(entry, name) {
  const spec = FIELDS[name];
  const wrapper = Array.from(entry.querySelectorAll('[data-automation-id]')).find((el) => spec.automation.test(aid(el)));
  const controls = (root) => Array.from(root.querySelectorAll('input:not([type=hidden]), textarea, select, button[aria-haspopup], [role="combobox"]'))
    .filter((el) => isRendered(el) || (el instanceof HTMLInputElement && el.type === 'checkbox'));
  if (wrapper) return controls(wrapper);
  for (const el of controls(entry)) {
    const label = getFieldLabel(el) || el.getAttribute('aria-label') || '';
    if (spec.label.test(label.trim())) return [el];
  }
  return [];
}

// ── values ────────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2022-03", "2022.3", "Mar 2022", "03/2022", "2022" → {year, month|null}. */
function parseYm(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || /present|now|current|至今/.test(s)) return null;
  let m = s.match(/(\d{4})\s*[-./年]\s*(\d{1,2})/);
  if (m) return { year: m[1], month: m[2].padStart(2, '0') };
  m = s.match(/(\d{1,2})\s*[/.-]\s*(\d{4})/);
  if (m) return { year: m[2], month: m[1].padStart(2, '0') };
  m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{4})/);
  if (m && MONTHS.includes(m[1])) return { year: m[2], month: String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0') };
  m = s.match(/(\d{4})/);
  return m ? { year: m[1], month: null } : null;
}

const sortKey = (e) => {
  if (e.current || /present|now|current|至今/i.test(e.end_date || '')) return '9999-99';
  const d = parseYm(e.end_date) || parseYm(e.start_date);
  return d ? `${d.year}-${d.month || '00'}` : '0000-00';
};

/** Every job and internship, newest first. */
function workEntries(resume) {
  const all = [...(resume.experience || []), ...(resume.internship || [])].filter((e) => e && (e.company || e.title));
  return all.sort((a, b) => sortKey(b).localeCompare(sortKey(a))).slice(0, MAX_ENTRIES);
}

// ── putting values in ─────────────────────────────────────────────────────

/** Workday's "type it and press Enter" search boxes (school, field of study). */
const isPrompt = (el) => el instanceof HTMLInputElement && F.isWorkdayPage() && (
  aid(el) === 'searchBox' || !!el.closest('[data-automation-id="multiselectInputContainer"]')
  || !!(el.closest('[data-automation-id^="formField-"]') || el.parentElement).querySelector('[data-automation-id="promptIcon"]'))

/** Type, Enter, then click the result that is the value. Only on Workday,
 *  whose prompts take the Enter; elsewhere an Enter can submit the form. */
async function choosePrompt(el, value) {
  el.focus?.();
  F.comboboxBaselines.set(el, new Set(F.allVisibleOptions()));
  F.typeInto(el, value);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  const options = await F.waitForOptions(el, 4000);
  const texts = options.map((o) => text(o));
  const best = VM && VM.pickBestOption(value, texts.map((t, i) => ({ text: t, value: t, raw: i })));
  if (!best) return false;
  F.clickOption(options[best.candidate.raw]);
  await sleep(200);
  return true;
}

async function putText(controls, value) {
  const el = controls.find((c) => c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement || c instanceof HTMLSelectElement || isCustomComboboxTrigger(c));
  if (!el || !value) return null;
  if (el instanceof HTMLSelectElement) return tryFillSelect(el, value) ? el : null;
  if (isPrompt(el)) return (await choosePrompt(el, value)) ? el : null;
  if (isCustomComboboxTrigger(el) || el.getAttribute('role') === 'combobox') {
    const ok = await chooseInCombobox(el, (texts) => {
      const best = VM && VM.pickBestOption(value, texts.map((t, i) => ({ text: t, value: t, raw: i })));
      return best ? best.candidate.raw : -1;
    }, value);
    return ok ? el : null;
  }
  fillField(el, value);
  return el.value ? el : null;
}

/** From / To: Workday's MM and YYYY boxes, a single "MM/YYYY" box, or a year. */
function putDate(controls, ym) {
  const boxes = controls.filter((c) => c instanceof HTMLInputElement && c.type !== 'checkbox');
  if (!ym || boxes.length === 0) return [];
  const isMonth = (b) => /month/i.test(`${aid(b)} ${b.getAttribute('aria-label') || ''}`) || /^mm$/i.test(b.placeholder || '');
  const isYear = (b) => /year/i.test(`${aid(b)} ${b.getAttribute('aria-label') || ''}`) || /^y{4}$/i.test(b.placeholder || '');
  const month = boxes.find(isMonth);
  const year = boxes.find(isYear);
  const done = [];
  const set = (el, v) => {
    el.focus?.();
    setTextFieldValue(el, v);
    if (el.value) done.push(el);
  };
  if (month || year) {
    if (month && ym.month) set(month, ym.month);
    if (year) set(year, ym.year);
    return done;
  }
  const one = boxes[0];
  set(one, /y{4}/i.test(one.placeholder || '') && !/m/i.test(one.placeholder || '') ? ym.year : ym.month ? `${ym.month}/${ym.year}` : ym.year);
  return done;
}

function isRequired(el) {
  const wrapper = el.closest('[data-automation-id^="formField-"]') || el.parentElement;
  return el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(text(wrapper && wrapper.querySelector('label')) || getFieldLabel(el) || '');
}

function mark(els, filled, label) {
  for (const el of els) {
    markField(el, 'filled');
    el.setAttribute('data-landed-source', 'entries');
  }
  if (els.length) filled.push(`entry:${label}`);
}

/** One entry's fields; what couldn't be filled stays yellow. */
async function fillEntry(entry, values, filled, manual) {
  for (const [name, value] of Object.entries(values)) {
    const controls = fieldIn(entry, name);
    if (controls.length === 0) continue;
    if (name === 'current') {
      const box = controls.find((c) => c instanceof HTMLInputElement && c.type === 'checkbox');
      if (box && value && !box.checked) clickChoice(box);
      if (box) mark([box], filled, name);
      continue;
    }
    const done = name === 'from' || name === 'to' ? putDate(controls, value) : [await putText(controls, value)].filter(Boolean);
    if (done.length) {
      mark(done, filled, name);
      continue;
    }
    // Couldn't fill it: yellow when there was a value, or the form needs one.
    const el = controls[0];
    if (value || isRequired(el)) addManual(manual, el, getFieldLabel(el) || name, name === 'from' || name === 'to' ? '日期' : '多条目', null);
  }
}

/** Fill the Work Experience and Education sections. Returns the elements
 *  they own (the other phases leave those alone) and whether any section
 *  was handled. */
async function fillExperienceSections(resume, filled, manual) {
  const owned = new Set();
  let handled = false;
  if (!resume) return { owned, handled };
  const jobs = workEntries(resume);
  const schools = (resume.education || []).filter((e) => e && e.school).slice(0, MAX_ENTRIES);
  for (const [kind, list] of [['work', jobs], ['education', schools]]) {
    const section = findSection(kind);
    if (!section) continue;
    handled = true;
    for (let i = 0; i < list.length; i++) {
      const entry = await entryAt(section, kind, i);
      if (!entry) break;
      const e = list[i];
      const current = !!e.current || /present|now|current|至今/i.test(e.end_date || '');
      const values = kind === 'work'
        ? {
          title: e.title, company: e.company, location: e.location, current,
          from: parseYm(e.start_date), to: current ? null : parseYm(e.end_date), description: e.description,
        }
        : { school: e.school, degree: e.degree, field: e.major, gpa: e.gpa, from: parseYm(e.start_date), to: parseYm(e.end_date) };
      await fillEntry(entry, values, filled, manual);
    }
    for (const el of section.querySelectorAll('input, textarea, select, button, [role="combobox"]')) owned.add(el);
  }
  return { owned, handled };
}

Object.assign(F, { parseYm, workEntries, fillExperienceSections });
})(typeof window !== 'undefined' ? window : globalThis);
