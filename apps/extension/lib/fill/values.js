// @ts-check
// lib/fill/values.js — what value a field should get: the saved application answers or
// the resume, with site-specific rules (Workday) and sanity checks.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { clearField, deepAll, fillField, isRendered } = F;
const { getFieldLabel } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

function automationId(el) {
  return String(el && el.getAttribute && el.getAttribute('data-automation-id') || '').toLowerCase();
}

function isWorkdayPage() {
  try {
    const parser = window.LandedPortalParsers && window.LandedPortalParsers.workday;
    return parser ? parser.isWorkdayUrl(location.href) : /(^|\.)myworkday(jobs|site)\.com$/i.test(location.hostname);
  } catch {
    return false;
  }
}

/** Workday buttons use aria-haspopup="true" for both dropdowns and global
 *  chrome such as Settings. Only treat the former as form controls. */
function answerKindForElement(el, label) {
  if (!CA) return null;
  const aid = automationId(el).replace(/[^a-z0-9]/g, '');
  const rules = [
    ['preferredfirstname', 'preferred_first_name'],
    ['preferredlastname', 'preferred_last_name'],
    ['middlename', 'legal_middle_name'],
    ['firstname', 'legal_first_name'],
    ['lastname', 'legal_last_name'],
    ['dateofbirth', 'date_of_birth'],
    ['addressline1', 'address_line1'],
    ['addressline2', 'address_line2'],
    ['postalcode', 'postal_code'],
    ['countryphonecode', 'country'],
    ['countrydropdown', 'country'],
    ['countryregion', 'country'],
    ['city', 'city'],
    ['state', 'state'],
    ['province', 'state'],
    ['source', 'heard_from'],
  ];
  const direct = rules.find(([needle]) => aid.includes(needle));
  return direct ? direct[1] : CA.classify(label || '');
}

function comparable(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
}

/** Reject obvious profile corruption instead of faithfully spreading it to
 *  every application. These are contradictions, not guesses: a full name is
 *  not a middle name, and a city by itself is not a street address. */
function suspiciousApplicationAnswer(kind, value, answers, flat) {
  const v = comparable(value);
  if (!v) return true;
  const fullNames = [
    flat && flat.name,
    flat && [flat.firstName, flat.lastName].filter(Boolean).join(' '),
    answers && [answers.legal_first_name, answers.legal_last_name].filter(Boolean).join(' '),
  ].map(comparable).filter(Boolean);
  if (kind === 'legal_middle_name' && fullNames.includes(v)) return true;
  if (kind === 'address_line1' || kind === 'address_line2') {
    const notStreet = [
      answers && answers.city,
      answers && answers.state,
      answers && answers.country,
      flat && flat.location,
      flat && String(flat.location || '').split(',')[0],
    ].map(comparable).filter(Boolean);
    if (notStreet.includes(v)) return true;
    if (kind === 'address_line2' && comparable(answers && answers.address_line1) === v) return true;
  }
  return false;
}

function referralFromUrl() {
  try {
    const raw = new URL(location.href).searchParams.get('utm_source');
    if (!raw) return null;
    const n = raw.toLowerCase();
    if (n.includes('linkedin')) return 'LinkedIn';
    if (n.includes('indeed')) return 'Indeed';
    if (n.includes('google')) return 'Google';
    return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 100);
  } catch {
    return null;
  }
}

function applicationAnswerForElement(kind, answers, el, flat, ctx) {
  let answer = kind && answers ? CA.answerFor(kind, answers, { ...(ctx || {}), employers: F.employers, question: getFieldLabel(el), site: location.hostname }) : null;
  if (!answer && kind === 'heard_from') {
    const source = referralFromUrl();
    if (source) answer = { type: 'text', value: source };
  }
  // A question the user answered on the Extension page ("other questions"),
  // however this form words it.
  if (!answer && answers && !kind) answer = CA.customAnswerFor(getFieldLabel(el), answers);
  if (answer && answer.type === 'text' && suspiciousApplicationAnswer(kind, answer.value, answers, flat)) return null;
  return answer;
}

function workdayOptionalBlank(el, label) {
  if (!isWorkdayPage()) return false;
  const kind = answerKindForElement(el, label);
  return kind === 'legal_middle_name' || kind === 'address_line2' || /phone\s*(extension|ext\b)/i.test(label || '');
}

function hasSeparatePhoneCountryCode() {
  return deepAll('[data-automation-id], input, button').some((el) => {
    const text = `${automationId(el)} ${getFieldLabel(el)}`;
    return /country\s*phone\s*code|countryphonecode/i.test(text);
  });
}

function nationalPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function resumeValueForElement(el, key, value, label) {
  if (!value) return null;
  if (key === 'name' && /\b(middle|preferred)\b/i.test(label || '')) return null;
  if (key === 'phone') {
    const context = `${label || ''} ${automationId(el)}`;
    if (/extension|\bext\b|country\s*phone\s*code|countryphonecode|device\s*type/i.test(context)) return null;
    if (isWorkdayPage() && /phone\s*number|phonenumber/i.test(context) && hasSeparatePhoneCountryCode()) {
      return nationalPhone(value);
    }
  }
  if (key === 'location' && isWorkdayPage() && answerKindForElement(el, label) === 'city') {
    return String(value).split(',')[0].trim();
  }
  return value;
}
function repairKnownBadWorkdayValues(flat, answers) {
  if (!isWorkdayPage()) return;
  // Include Workday text inputs that declare role="combobox". The ordinary
  // text-field pass intentionally excludes those, but City often uses one and
  // is still needed here to identify old city-as-street corruption.
  const fields = deepAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea')
    .filter(isRendered);
  const byKind = (kind) => fields.find((el) => answerKindForElement(el, getFieldLabel(el)) === kind);
  const middle = byKind('legal_middle_name');
  if (middle && middle.value && suspiciousApplicationAnswer('legal_middle_name', middle.value, answers, flat)) clearField(middle);

  const city = byKind('city');
  const line1 = byKind('address_line1');
  const line2 = byKind('address_line2');
  const cityValue = comparable(city && city.value);
  if (line2 && line2.value && (
    suspiciousApplicationAnswer('address_line2', line2.value, answers, flat)
    || (cityValue && comparable(line2.value) === cityValue)
    || comparable(line2.value) === comparable(line1 && line1.value)
  )) clearField(line2);
  if (line1 && line1.value && (
    suspiciousApplicationAnswer('address_line1', line1.value, answers, flat)
    || (cityValue && comparable(line1.value) === cityValue)
  )) clearField(line1);

  const resumePhone = nationalPhone(flat && flat.phone);
  for (const el of fields) {
    const label = getFieldLabel(el);
    if (/phone\s*(extension|ext\b)/i.test(label) && nationalPhone(el.value) === resumePhone) clearField(el);
    if (/phone\s*number/i.test(label) && hasSeparatePhoneCountryCode()) {
      const fixed = nationalPhone(el.value || (flat && flat.phone));
      if (fixed && fixed !== el.value) fillField(el, fixed);
    }
  }
}

Object.assign(F, { automationId, isWorkdayPage, answerKindForElement, comparable, suspiciousApplicationAnswer, referralFromUrl, applicationAnswerForElement, workdayOptionalBlank, hasSeparatePhoneCountryCode, nationalPhone, resumeValueForElement, repairKnownBadWorkdayValues });
})(typeof window !== 'undefined' ? window : globalThis);
