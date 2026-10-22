// @ts-check
// lib/fill/unanswered.js — questions a fill had to leave empty, asked once.
// After a fill, the empty fields worth asking about (not sensitive, not a
// file, not open-ended text, not something the resume should hold) are
// reported; the service worker queues them and the Landed tab takes them to
// the Extension page, where the user answers. Once the answers come back to
// the extension, pages still open get those fields filled — only fields
// still empty and yellow, so nothing the user typed is touched.
// See packages/schema/src/application-answers.ts → addUnanswered.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { answerKindForElement, applicationAnswerForElement, choiceGroupQuestion, chooseInCombobox, clickChoice, deepAll, existingComboboxTexts, fillField, groupChoices, isCustomComboboxTrigger, isDateField, markField, neverSent, optionText, setSelectOption, setSource } = F;
const { getFieldLabel, matchResumeKey } = global.ResumeFillerFieldDetect;
const CA = global.LandedChoiceAnswers;

// Option texts that only say "pick one".
const PLACEHOLDER = /^(?:select|choose|please select|--|—|-)\b|^\s*$/i;

function radioGroups() {
  const byEl = new Map();
  for (const group of groupChoices(deepAll('input[type="radio"]'))) for (const el of group) byEl.set(el, group);
  return byEl;
}

/** What a field asks, its options, and whether it's still empty. Null for
 *  fields that are never asked about. */
function describe(el, groups) {
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    const group = groups.get(el) || [el];
    const options = group.map(optionText);
    return { el, group, question: choiceGroupQuestion(group) || '', options, empty: !group.some((r) => r.checked) };
  }
  if (el instanceof HTMLSelectElement) {
    const options = Array.from(el.options).map((o) => o.text.replace(/\s+/g, ' ').trim()).filter((t) => !PLACEHOLDER.test(t));
    return { el, question: getFieldLabel(el) || '', options, empty: !el.value };
  }
  if (el instanceof HTMLTextAreaElement) return null; // open-ended: answered per job (#98)
  if (el instanceof HTMLInputElement) {
    if (['checkbox', 'file', 'hidden', 'password', 'submit', 'button', 'date'].includes(el.type)) return null;
    return { el, question: getFieldLabel(el) || '', options: [], empty: !el.value.trim() };
  }
  if (isCustomComboboxTrigger(el)) {
    const question = getFieldLabel(el) || '';
    // "Select One" / "Required" is a prompt, not an answer. Workday puts
    // that text inside the button, so checking textContent made every empty
    // questionnaire dropdown look filled and prevented Landed from asking
    // the user about questions their saved answers do not cover.
    return { el, question, options: [], empty: existingComboboxTexts(el, question).length === 0 };
  }
  return null;
}

/** The empty fields on this page worth asking the user about, once each:
 *  `{question, key, options, site}` (key: the saved answer it's about). */
function unansweredQuestions(manual) {
  const groups = radioGroups();
  const out = [];
  const seen = new Set();
  for (const item of manual || []) {
    // Entries of Work Experience / Education (lib/fill/experience.js) come from the resume.
    // Another country's work authorization or sponsorship is yellow as a
    // legal question, but the saved (US) answers don't say: asked once.
    const otherCountry = item.hint === '敏感信息' && CA.asksAboutAnotherCountry(item.label);
    if (['敏感信息', '文件上传', '富文本', '多条目', '日期'].includes(item.hint) && !otherCountry) continue;
    const el = deepAll(`[data-landed-field-id="${item.id}"]`)[0];
    const field = el && describe(el, groups);
    if (!field || !field.empty) continue;
    const question = (field.question || item.label || '').replace(/\s+/g, ' ').trim();
    if (!question || question.length > 300 || neverSent(question) || isDateField(field.el)) continue;
    const kind = CA.classify(question);
    // A kind with no answer to save it to (today's date, a signature,
    // preferred location N…) is asked elsewhere or not at all.
    if (kind && !CA.ASKABLE_KEYS.has(kind)) continue;
    // A resume field (school, GPA, employer…) belongs on the resume, not here.
    const resumeMatch = !kind && !field.group && matchResumeKey(field.el);
    if (resumeMatch && resumeMatch.key) continue;
    const key = CA.questionKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, key: kind, options: field.options.slice(0, 20), site: location.hostname });
    if (out.length >= 20) break;
  }
  return out;
}

/** The user answered on the Extension page: fill the fields still empty and
 *  yellow that the saved answers now cover. Returns how many it filled. */
async function fillPendingFromAnswers(answers) {
  if (!answers) return 0;
  const groups = radioGroups();
  const done = new Set();
  let filled = 0;
  // Yellow ones, and optional ones left blank (content.js).
  for (const el of deepAll('[data-landed-status="review"], [data-landed-status="blank"]')) {
    const field = describe(el, groups);
    if (!field || !field.empty || done.has(field.group || el)) continue;
    done.add(field.group || el);
    const question = field.question;
    if (!question || neverSent(question)) continue;
    const kind = field.group ? CA.classify(question) : answerKindForElement(field.el, question);
    const answer = field.group
      ? (kind && CA.answerFor(kind, answers)) || (!kind ? CA.customAnswerFor(question, answers) : null)
      : applicationAnswerForElement(kind, answers, field.el, {});
    if (!answer) continue;
    let ok = false;
    if (field.group) {
      const index = CA.pickOption(answer, field.options);
      if (index >= 0) {
        clickChoice(field.group[index]);
        ok = field.group[index].checked;
      }
    } else if (field.el instanceof HTMLSelectElement) {
      const options = Array.from(field.el.options);
      const index = CA.pickOption(answer, options.map((o) => o.text));
      if (index >= 0) {
        setSelectOption(field.el, options[index]);
        ok = true;
      }
    } else if (answer.type === 'text' && isCustomComboboxTrigger(field.el)) {
      ok = await chooseInCombobox(field.el, (texts) => CA.pickOption(answer, texts), answer.value);
    } else if (answer.type === 'text' || answer.type === 'yesno') {
      fillField(field.el, answer.type === 'text' ? answer.value : answer.value === 'yes' ? 'Yes' : 'No');
      ok = !!field.el.value;
    }
    if (!ok) continue;
    for (const target of field.group || [field.el]) {
      markField(target, 'filled');
      target.removeAttribute('data-landed-source');
      setSource(target, 'answers');
    }
    filled++;
  }
  return filled;
}

Object.assign(F, { unansweredQuestions, fillPendingFromAnswers });
})(typeof window !== 'undefined' ? window : globalThis);
