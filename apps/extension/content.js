// @ts-check
// content.js — fill the page: the phases of a fill, in order, and the
// messages that start one. The pieces live in lib/fill/ (loaded first, see
// manifest.json content_scripts):
//
//   core      finding fields (shadow roots too), visibility, marks, review list
//   selects   native <select>
//   values    what a field should get: saved answers or the resume (+ Workday rules)
//   combobox  custom dropdowns and search boxes
//   files     resume / cover letter uploads
//   choices   radio buttons and checkboxes
//   inputs    text fields from the resume
//   dates     date pickers and multi-entry sections
//   experience  Work Experience / Education sections: every job and school, one entry each
//   ai        local-model fallbacks (key or option picks, never invented values)
//   review    the user's own agent checks the filled form (picks, never writes)
//   unanswered  empty fields worth asking the user about, once; filling them when answered
//   frames    forms in iframes report to the service worker
//   portal    portal confirmation pages → events
//
// Field detection lives in lib/field-detect.js, option matching in
// lib/value-match.js, CN↔EN translation in lib/cross-lingual.js, saved
// answers in lib/choice-answers.js. Type-checked via JSDoc + checkJs
// (tsconfig.json).

const { acceptsFile, addManual, answerKindForElement, applicationAnswerForElement, attachFile, choiceGroupQuestion, chooseCity, chooseInCombobox, clickChoice, deepAll, detectPortalEventForCurrentPage, existingComboboxTexts, fieldId, fileInputKind, fillAllSectionDates, fillExperienceSections, fillField, fillInputBatch, fillPendingFromAnswers, getVisibleInputs, groupChoices, isCustomComboboxTrigger, isMonthSelect, isRendered, isSensitiveLabel, isWorkdayPage, isYearSelect, loadApplicationAnswers, loadApplicationFiles, markField, optionText, peekComboboxOptions, repairKnownBadWorkdayValues, resumeValueForElement, runChoiceFallback, runFillReview, runLLMFallback, setSelectOption, setSource, tagFilled, tryFillCombobox, tryFillSelect, unansweredQuestions } = window.LandedFill;
const { normalize, getFieldLabel, matchResumeKey } = window.ResumeFillerFieldDetect;
const CL = window.ResumeFillerCrossLingual;
const CA = window.LandedChoiceAnswers;

// ─── 主消息处理 ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fill') {
    handleFill(msg.resume, msg.customFields || {}, { aiTakeover: !!msg.aiTakeover, resumeId: typeof msg.resumeId === 'string' ? msg.resumeId : null }).then(sendResponse);
    return true;
  }
  // The user answered questions on the Extension page: fill the fields still
  // empty that the answers now cover (lib/fill/unanswered.js).
  if (msg.action === 'fill-answers') {
    loadApplicationAnswers().then(fillPendingFromAnswers).then((filled) => sendResponse({ filled }), () => sendResponse({ filled: 0 }));
    return true;
  }
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return true;
  }
  // SW-initiated portal poll (background.js → here). We run the
  // appropriate portal parser on the current page and return the event
  // (or null) synchronously — SW dedupes via snapshot-store.
  if (msg.action === 'parse-portal') {
    sendResponse(detectPortalEventForCurrentPage());
    return true;
  }
});

async function handleFill(resumeData, customFields, opts) {
  opts = opts || {};
  let flat;
  if (typeof window.flattenResumeForFill === 'function') {
    flat = window.flattenResumeForFill(resumeData);
  } else {
    flat = resumeData || {};
  }

  const filled = [];
  const manual = [];
  // Who they've worked for, from the resume: "Have you worked here before?"
  // is answered from this (lib/choice-answers.js → previouslyEmployed).
  const normalized = typeof window.normalizeResume === 'function' ? window.normalizeResume(resumeData) : null;
  const employers = normalized
    ? [...normalized.experience, ...normalized.internship].map((e) => e && e.company).filter((c) => typeof c === 'string' && c.trim())
    : [];
  window.LandedFill.employers = employers;
  // Saved application answers (null when the user has none): names, address,
  // yes/no questions, EEO — see lib/choice-answers.js. Choice questions they
  // don't answer may go to the local model below.
  const answers = await loadApplicationAnswers();
  const aiChoices = [];
  repairKnownBadWorkdayValues(flat, answers);

  // Upload fields: the saved resume / cover letter files go in; others (and
  // fields with nothing saved) stay yellow. Hidden inputs behind an
  // "Attach" button count too.
  const fileInputs = /** @type {HTMLInputElement[]} */ (deepAll('input[type="file"]'));
  const files = fileInputs.length ? await loadApplicationFiles(opts.resumeId) : {};
  const answered = /** @type {Set<Element>} */ (new Set(fileInputs));
  const missingFiles = new Set();
  for (const el of fileInputs) {
    const { kind, label } = fileInputKind(el);
    const file = kind && files[kind];
    if (file && acceptsFile(el, file) && attachFile(el, file)) {
      markField(el, 'filled');
      filled.push('file:' + kind);
      continue;
    }
    if (kind && !file) missingFiles.add(kind);
    if (isRendered(el) || label) addManual(manual, el, label || '文件上传', '文件上传', null);
  }
  // Where each value came from, for the review at the end (lib/fill/review.js).
  tagFilled('file');

  // Work Experience and Education sections (Workday's "My Experience"): every
  // job, internship and school as its own entry, with its own location and
  // dates. They own their fields, so the rules below leave them alone (no
  // more "Location: <your city>" in a job, or only the current job).
  const sections = await fillExperienceSections(normalized, filled, manual);
  for (const el of sections.owned) answered.add(el);

  // Phase 0: text fields the answers cover (legal names, address, date of
  // birth, signature, today's date…) — before the resume rules, which would
  // put a preferred name into "Legal first name".
  if (answers) {
    for (const el of getVisibleInputs()) {
      if (el instanceof HTMLInputElement && el.type === 'file') continue;
      const kind = answerKindForElement(el, getFieldLabel(el) || '');
      const isDate = el instanceof HTMLInputElement && el.type === 'date';
      const answer = applicationAnswerForElement(kind, answers, el, flat, { dateInput: isDate });
      if (!answer) {
        // These structured Workday fields must never fall through to broad
        // resume rules. Optional blanks stay blank; required blanks are
        // surfaced for review.
        if (isWorkdayPage() && ['legal_middle_name', 'address_line1', 'address_line2', 'postal_code'].includes(kind)) {
          answered.add(el);
          if (kind === 'address_line1' || kind === 'postal_code') addManual(manual, el, getFieldLabel(el), '需要申请资料', null);
        }
        continue;
      }
      const value = answer.type === 'text' ? answer.value : answer.type === 'yesno' ? (answer.value === 'yes' ? 'Yes' : 'No') : null;
      if (!value || (isDate && !/^\d{4}-\d{2}-\d{2}$/.test(value))) continue;
      fillField(el, value);
      filled.push('answer:' + kind);
      answered.add(el);
    }
  }
  // Questions only the user's answers can answer stay theirs: never a resume
  // field that happens to match.
  for (const el of getVisibleInputs()) {
    if (answered.has(el) || (el instanceof HTMLInputElement && el.type === 'file')) continue;
    const label = getFieldLabel(el) || '';
    if (!CA.ANSWER_ONLY.has(answerKindForElement(el, label))) continue;
    answered.add(el);
    addManual(manual, el, label, '需要申请资料', null);
  }
  tagFilled('answers');

  // Phase 1：填所有可见 input / textarea
  fillInputBatch(getVisibleInputs(), flat, filled, manual, answered);
  tagFilled('resume');

  // Phase 2：原生 <select> 匹配填值
  for (const el of /** @type {HTMLSelectElement[]} */ (deepAll('select'))) {
    if (!isRendered(el) || sections.owned.has(el)) continue;
    const label = getFieldLabel(el) || el.name || el.id || '下拉选择';

    // 年/月 select 交给日期模块处理
    if (isYearSelect(el) || isMonthSelect(el)) continue;

    const options = Array.from(el.options);
    const kind = answerKindForElement(el, label);
    const answer = applicationAnswerForElement(kind, answers, el, flat);
    if (answer) {
      const index = CA.pickOption(answer, options.map((o) => o.text));
      if (index >= 0) {
        setSelectOption(el, options[index]);
        setSource(el, 'answers');
        filled.push('answer:' + kind);
        continue;
      }
    }

    if (isSensitiveLabel(label)) {
      addManual(manual, el, label, '敏感信息', null);
      continue;
    }

    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const value = CL.maybeTranslate(key, flat[key], label);
      if (tryFillSelect(el, value)) {
        filled.push(key);
        continue;
      }
    }
    const hint = key ? flat[key] || '—' : '—';
    addManual(manual, el, label, '下拉框', hint);
    if (answers && kind !== 'consent') {
      aiChoices.push({ id: fieldId(el), question: label, options: options.map((o) => o.text), apply: (i) => setSelectOption(el, options[i]) });
    }
  }

  // Phase 3：combobox / 自定义下拉
  const comboboxes = /** @type {HTMLElement[]} */ (
    deepAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"], [data-automation-id]')
  ).filter(el => isRendered(el) && isCustomComboboxTrigger(el) && !sections.owned.has(el));

  let peeked = 0;
  for (const el of comboboxes) {
    const label = getFieldLabel(el) || '下拉选择';
    const kind = answerKindForElement(el, label);
    const answer = applicationAnswerForElement(kind, answers, el, flat);
    const choose = answer && (kind === 'city' && answer.type === 'text' ? chooseCity(answer.value, answers.state) : (texts) => CA.pickOption(answer, texts));
    const existing = existingComboboxTexts(el, label);
    if (answer && existing.length && choose(existing) >= 0) {
      markField(el, 'filled');
      setSource(el, 'answers');
      filled.push('answer:' + kind);
      continue;
    }
    if (answer && await chooseInCombobox(el, choose, answer.type === 'text' ? answer.value : '')) {
      setSource(el, 'answers');
      filled.push('answer:' + kind);
      continue;
    }
    if (!answer && existing.length) {
      markField(el, 'filled');
      setSource(el, 'page');
      continue;
    }
    if (isSensitiveLabel(label)) {
      addManual(manual, el, label, '敏感信息', null);
      continue;
    }
    const match = matchResumeKey(el);
    const key = match && match.key;
    if (key && flat[key]) {
      const raw = CL.maybeTranslate(key, flat[key], label);
      const value = resumeValueForElement(el, key, raw, label);
      if (!value) continue;
      const ok = await tryFillCombobox(el, value, { city: key === 'location' || /city|城市/i.test(label), state: answers && answers.state });
      if (ok) {
        filled.push(key);
        continue;
      }
      addManual(manual, el, label, '自定义下拉框', value);
    } else {
      addManual(manual, el, label, '自定义下拉框', null);
    }
    // No rule answer: the local model may pick from its options (searched
    // lists show none until typed in, so they stay with the user).
    if (answers && kind !== 'consent' && peeked < 12) {
      peeked++;
      const texts = await peekComboboxOptions(el);
      if (texts.length >= 2 && texts.length <= 40) {
        aiChoices.push({ id: fieldId(el), question: label, options: texts, apply: (i) => chooseInCombobox(el, (now) => now.indexOf(texts[i]), '') });
      }
    }
  }

  tagFilled('resume');

  // Phase 4：富文本 / contenteditable
  for (const el of deepAll('[contenteditable="true"], [role="textbox"]').filter((x) => !sections.owned.has(x))) {
    const label = getFieldLabel(el) || '富文本编辑器';
    const match = matchResumeKey(el);
    const key = match && match.key;
    addManual(manual, el, label, '富文本', key && flat[key] ? flat[key] : null);
  }

  // Phase 5：日期 select + 多条目（合并处理，按 section 定位容器避免乱填）
  const resume = typeof window.normalizeResume === 'function'
    ? window.normalizeResume(resumeData)
    : null;
  if (resume && !sections.handled) await fillAllSectionDates(resume, filled);
  tagFilled('entries');

  // Phase 6: radio buttons and checkboxes. Answered only from the user's
  // saved application answers (never guessed); consent boxes only when they
  // turned on "Tick consent boxes for me". The rest stay yellow, and radio
  // groups without a rule answer may go to the local model below. Date
  // "current/present" boxes are handled above and omitted once selected.
  const choiceInputs = /** @type {HTMLInputElement[]} */ (
    deepAll('input[type="checkbox"], input[type="radio"]')
  ).filter((el) => isRendered(el) && !sections.owned.has(el));
  for (const group of groupChoices(choiceInputs)) {
    const first = group[0];
    const firstText = optionText(first) || first.parentElement?.textContent?.trim() || first.name || '选择题';
    if (group.length === 1 && first.checked && /至今|present|current|ongoing/i.test(firstText)) continue;
    const question = choiceGroupQuestion(group) || firstText;
    const kind = answers ? CA.classify(question) : null;

    if (answers && first.type === 'radio') {
      const answer = (kind && CA.answerFor(kind, answers, { employers, question, site: location.hostname })) || (!kind ? CA.customAnswerFor(question, answers) : null);
      const index = answer ? CA.pickOption(answer, group.map(optionText)) : -1;
      if (index >= 0) {
        clickChoice(group[index]);
        group.forEach((el) => markField(el, 'filled'));
        filled.push('answer:' + kind);
        continue;
      }
    }
    if (answers && first.type === 'checkbox' && answers.agree_to_terms === true) {
      for (const box of group) {
        const text = optionText(box);
        const consent = CA.classify(text) === 'consent' || kind === 'consent';
        if (consent && CA.pickOption({ type: 'agree' }, [text]) === 0) {
          clickChoice(box);
          markField(box, 'filled');
          filled.push('answer:consent');
        }
      }
      if (group.every((box) => box.getAttribute('data-landed-status') === 'filled')) continue;
    }

    const open = group.filter((el) => el.getAttribute('data-landed-status') !== 'filled');
    const sensitive = isSensitiveLabel(question) || kind === 'consent';
    open.forEach((el) => markField(el, 'review'));
    addManual(manual, open[0], question, sensitive ? '敏感信息' : '选择题', null);
    if (answers && first.type === 'radio' && !sensitive) {
      aiChoices.push({ id: fieldId(first), question, options: group.map(optionText), apply: (i) => clickChoice(group[i]), group });
    }
  }

  tagFilled('answers');

  // Phase 7：user-learned custom fields and label→resumeKey mappings.
  // customFields: { section: { label: literalValue } } — value is fixed.
  // labelMappings: { label: resumeKey } — value comes from the current
  // resume so it stays in sync as the user updates fields.
  const labelMappings = await new Promise((resolve) => {
    try {
      chrome.storage.local.get('labelMappings', (res) => resolve(res?.labelMappings || {}));
    } catch {
      resolve({});
    }
  });
  const allCustom = customFields && typeof customFields === 'object'
    ? Object.values(customFields).reduce(
      (acc, section) => (typeof section === 'object' ? Object.assign(acc, section) : acc),
      {}
    )
    : {};
  const customEntries = Object.entries(allCustom);
  const mappingEntries = Object.entries(labelMappings);
  if (customEntries.length > 0 || mappingEntries.length > 0) {
    for (const el of getVisibleInputs()) {
      if (sections.owned.has(el)) continue;
      const label = getFieldLabel(el);
      if (!label) continue;
      const norm = normalize(label);

      let matched = false;
      // Literal-value custom fields take priority — most explicit.
      for (const [cfLabel, cfValue] of customEntries) {
        if (normalize(cfLabel) === norm && cfValue) {
          fillField(el, String(cfValue));
          filled.push('custom:' + cfLabel);
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Then label→resumeKey mappings (#10): fill from current resume.
      for (const [lmLabel, lmKey] of mappingEntries) {
        if (normalize(lmLabel) === norm && flat[lmKey]) {
          fillField(el, String(flat[lmKey]));
          filled.push('mapped:' + lmLabel);
          break;
        }
      }
    }
  }

  tagFilled('saved');

  // Explicit custom answers and learned mappings run after the generic scan.
  // If one resolved a field, do not keep its earlier review entry or send it
  // to either model fallback.
  for (let i = manual.length - 1; i >= 0; i--) {
    const target = deepAll(`[data-landed-field-id="${manual[i].id}"]`)[0];
    if (target?.getAttribute('data-landed-status') === 'filled') manual.splice(i, 1);
  }

  // Phase 8 (optional, #9): typed local-model fallback for unmatched
  // labels. Failures degrade silently — the user sees the manual list.
  if (opts.aiTakeover) {
    const aiFilled = await runLLMFallback(manual, flat, answers ? CA.answerFlat(answers) : {});
    if (aiFilled.length > 0) {
      filled.push(...aiFilled);
      // Drop AI-filled entries from the manual list so the popup UI
      // doesn't ask the user to handle them again.
      const filledIdSet = new Set(aiFilled.map((s) => s.replace(/^ai:/, '')));
      for (let i = manual.length - 1; i >= 0; i--) {
        if (filledIdSet.has(manual[i].id)) manual.splice(i, 1);
      }
    }
    // Choice questions the saved answers don't cover by rule: the local
    // model picks an option from the user's answers, or leaves it.
    const chosen = await runChoiceFallback(aiChoices, answers, flat);
    if (chosen.length > 0) {
      filled.push(...chosen.map((id) => 'ai-choice:' + id));
      const done = new Set(chosen);
      for (let i = manual.length - 1; i >= 0; i--) {
        if (done.has(manual[i].id)) manual.splice(i, 1);
      }
    }
  }

  tagFilled('model');

  // Phase 9: the user's own agent reviews the filled form (local Ollama, else
  // their Claude Code). Changed fields turn yellow; sensitive ones aren't sent.
  const review = opts.aiTakeover ? await runFillReview(manual, answers, flat) : null;

  // What's still empty and worth asking the user once (the Extension page).
  const unanswered = unansweredQuestions(manual);

  return { filled, manual, missing_files: Array.from(missingFiles), review, unanswered };
}
