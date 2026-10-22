// lib/field-detect.js — field detection module
//
// Extracted from content.js so the matching logic can be unit-tested in
// jsdom and (in #9) augmented with an optional LLM fallback.
//
// Loaded as a content script before content.js (see manifest.json
// content_scripts.js order). Exposes window.ResumeFillerFieldDetect.
//
// Behavior preserved verbatim from the original content.js implementation:
// the matching algorithm joins all signal sources into one string and
// returns the first FIELD_MAP rule whose key appears in it. The new API
// surfaces a confidence score and the source attribute that contained the
// match; callers that only need the resume key can read .key.

(function (global) {
  const FIELD_MAP = [
    { keys: ['firstname', 'first_name', 'given', '名字', '名（', '（名）', 'first name'], resumeKey: 'firstName' },
    { keys: ['lastname', 'last_name', 'family', 'surname', '姓氏', '（姓）', 'last name'], resumeKey: 'lastName' },
    { keys: ['name', 'fullname', 'full_name', '姓名', 'your name', 'applicant'], resumeKey: 'name' },
    { keys: ['email', 'e-mail', '邮箱', '电子邮件', 'mail'], resumeKey: 'email' },
    { keys: ['phone', 'mobile', 'tel', '电话', '手机', 'contact'], resumeKey: 'phone' },
    { keys: ['wechat', '微信'], resumeKey: 'wechat' },
    // A resume location is safe for a location/city field, but it is not a
    // street address.  The latter comes from the user's saved application
    // answers; putting "Seattle, WA" into Address line 1 is worse than
    // leaving the field for review.
    { keys: ['location', 'city', '城市', '所在地', 'residence', '期望城市', '工作城市'], resumeKey: 'location' },
    { keys: ['linkedin'], resumeKey: 'linkedin' },
    { keys: ['github'], resumeKey: 'github' },
    { keys: ['portfolio', 'website', '个人网站'], resumeKey: 'portfolio' },
    { keys: ['school', 'university', 'college', '学校', '院校', '毕业院校', '学校名称'], resumeKey: 'edu_school' },
    { keys: ['major', 'field of study', '专业', '专业名称'], resumeKey: 'edu_major' },
    { keys: ['degree', '学历', '学位'], resumeKey: 'edu_degree' },
    { keys: ['gpa', '绩点'], resumeKey: 'edu_gpa' },
    { keys: ['apply position', 'applied position', 'desired position', 'desired role', 'job title', 'jobtitle', '应聘职位', '求职意向', '期望职位', '目标岗位'], resumeKey: 'apply_position' },
    { keys: ['salary', 'expectation', 'expected salary', 'desired salary', '期望薪资', '薪资期望', '薪酬', '期望工资'], resumeKey: 'salary' },
    { keys: ['available', 'notice period', '到岗', '入职', '最早到岗', '到岗时间'], resumeKey: 'available_date' },
    { keys: ['years of experience', 'years experience', 'work experience years', '工作年限', '经验年限', '工龄'], resumeKey: 'years_exp' },
    { keys: ['company', 'employer', 'company name', '公司', '公司名称', '当前公司', '现公司', '工作单位'], resumeKey: 'current_company' },
    { keys: ['job title', 'position title', 'role title', '职位', '职位名称', '岗位名称', '担任职位'], resumeKey: 'current_title' },
    { keys: ['job description', 'work description', 'responsibilities', 'duties', '工作职责', '工作描述', '职责描述', '工作内容', '岗位职责'], resumeKey: 'job_description' },
    { keys: ['skills', 'skill', '技能', '专业技能'], resumeKey: 'skills' },
    { keys: ['language', 'languages', '语言'], resumeKey: 'languages' },
    { keys: ['summary', 'intro', 'introduction', 'about', 'self', '自我介绍', '个人简介', '自我描述', 'bio'], resumeKey: 'summary' },
    { keys: ['project name', '项目名称', '项目名'], resumeKey: 'project_name' },
    { keys: ['project description', 'project_desc', '项目描述'], resumeKey: 'project_description' },
  ];

  const NAME_CONTEXT_BLOCKLIST_LATIN = [
    'company', 'employer', 'organization', 'org', 'school', 'university',
    'college', 'institution', 'project', 'username', 'user', 'team', 'group',
    'job', 'position', 'role', 'product', 'brand', 'title', 'middle', 'preferred',
  ];

  const PHONE_CONTEXT_BLOCKLIST_LATIN = [
    'extension', 'ext', 'country phone code', 'country code', 'device type',
  ];

  const NAME_CONTEXT_BLOCKLIST_CJK = [
    '名称', '公司', '职位', '岗位', '专业', '学校', '项目',
  ];

  // Confidence per signal source where the matched keyword was found.
  // Visible labels are the strongest signal; id is the weakest because
  // it's often a generic auto-generated string.
  const SOURCE_CONFIDENCE = {
    label: 0.95,
    // Workday exposes stable, meaningful identifiers even when the visible
    // label lives several React wrappers away from the actual input.
    'data-automation-id': 0.9,
    'aria-label': 0.85,
    placeholder: 0.75,
    name: 0.65,
    id: 0.55,
    fallback: 0.4,
  };

  let registeredFallback = null;

  function normalize(str) {
    return (str || '').toLowerCase().replace(/[\s_\-.]/g, '');
  }

  function normalizeSpaced(str) {
    return (str || '').toLowerCase().replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isCJKKey(str) {
    return /[一-鿿]/.test(str);
  }

  // jsdom (used by tests) does not implement CSS.escape; provide a fallback.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    return String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~]/g, '\\$&');
  }

  function visibleText(el, max = 300) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function byId(scope, id) {
    if (!scope || !id) return null;
    if (typeof scope.getElementById === 'function') return scope.getElementById(id);
    return typeof scope.querySelector === 'function' ? scope.querySelector(`#${cssEscape(id)}`) : null;
  }

  const CONTROL_SELECTOR = 'input, textarea, select, button, [role="combobox"], [contenteditable="true"]';

  // Strict label: only label[for], aria-labelledby, or sibling text. Used as
  // the "label" signal source so it doesn't double-count aria-label /
  // placeholder / name / id (which have their own slots).
  const POPUP = /dropdown|listbox|popover|suggest|autocomplete|typeahead|results|\bmenu\b/i;

  function getStrictLabel(el) {
    if (!el) return '';
    // A field inside a web component has its label in the same shadow root.
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    const scope = rootNode && rootNode.querySelector ? rootNode : document;
    if (el.id) {
      const lbl = scope.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lbl) return visibleText(lbl);
    }
    // Native label association also covers a control wrapped by <label>.
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((label) => visibleText(label)).filter(Boolean).join(' ');
      if (text) return text.slice(0, 300);
    }
    const wrappingLabel = el.closest && el.closest('label');
    if (wrappingLabel) {
      const text = visibleText(wrappingLabel);
      if (text) return text;
    }
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      // aria-labelledby is an IDREF list. Workday commonly uses one id for
      // the question and another for "Required" / the current value.
      const text = labelledBy.split(/\s+/).map((id) => visibleText(byId(scope, id))).filter(Boolean).join(' ');
      if (text) return text.slice(0, 300);
    }
    let parent = el.parentElement;
    for (let depth = 0; depth < 8 && parent; depth++) {
      for (const child of parent.children) {
        if (child.contains(el)) continue;
        if (['LABEL', 'DIV', 'SPAN', 'P', 'DT', 'LEGEND', 'H4', 'H5', 'H6'].includes(child.tagName)) {
          if (child.querySelector(CONTROL_SELECTOR)) continue;
          // Only text a person sees: a widget's hidden helper next to the
          // field (Lever's "No location found…") is not its question.
          if (child.hidden || child.getAttribute('aria-hidden') === 'true') continue;
          // Nor is a suggestion list or menu that pops up by it.
          if (POPUP.test(`${typeof child.className === 'string' ? child.className : ''} ${child.getAttribute('role') || ''}`)) continue;
          // In a browser innerText leaves hidden text out (jsdom has none).
          if (typeof child.innerText === 'string' && !child.innerText.trim() && (child.textContent || '').trim()) continue;
          const text = visibleText(child);
          // Application questions are often much longer than an ordinary
          // field label. Workday's U.S. Bank questionnaire, for example,
          // puts a 100–300 character question beside a button whose own
          // aria-label is only "Select One Required".
          if (text) return text;
        }
      }
      parent = parent.parentElement;
    }
    return '';
  }

  // Public: returns whatever non-empty label text we can find, falling back
  // through aria-label, placeholder, name, id. Callers like content.js use
  // this for human-readable display strings.
  function getFieldLabel(el) {
    if (!el) return '';
    const strict = getStrictLabel(el);
    if (strict) return strict;
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    const generic = /^(?:select|choose|please select|please choose|select one)(?:\s+required)?[.…]*$/i;
    if (ariaLabel && !generic.test(ariaLabel.trim())) return ariaLabel.trim();
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.length < 80 && !generic.test(ph.trim())) return ph;
    const automationId = el.getAttribute && el.getAttribute('data-automation-id');
    if (automationId) {
      const human = String(automationId)
        .replace(/[_\-.]+/g, ' ')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
      if (human && !generic.test(human)) return human;
    }
    if (el.name) return el.name;
    if (el.id) return el.id;
    // A generic prompt is still better than no label for diagnostics, but
    // only after every meaningful source above has been exhausted.
    return (ariaLabel || ph || '').trim();
  }

  function collectSources(el) {
    return [
      { name: 'label', value: getStrictLabel(el) },
      { name: 'data-automation-id', value: (el.getAttribute && el.getAttribute('data-automation-id')) || '' },
      { name: 'aria-label', value: (el.getAttribute && el.getAttribute('aria-label')) || '' },
      { name: 'placeholder', value: (el.getAttribute && el.getAttribute('placeholder')) || '' },
      { name: 'name', value: el.name || '' },
      { name: 'id', value: el.id || '' },
    ];
  }

  function findWinningSource(matchedKey, sources) {
    const cjk = isCJKKey(matchedKey);
    const normalizedKey = cjk ? normalize(matchedKey) : null;
    const escaped = cjk ? null : normalizeSpaced(matchedKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = cjk ? null : new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
    for (const source of sources) {
      if (!source.value) continue;
      if (cjk) {
        if (normalize(source.value).includes(normalizedKey)) return source.name;
      } else if (re.test(normalizeSpaced(source.value))) {
        return source.name;
      }
    }
    return null;
  }

  // Returns { key, confidence, source } or null.
  // Behavior of the matching algorithm is identical to the original
  // content.js: signal sources are joined into one string per
  // normalization mode and the first FIELD_MAP rule that hits wins.
  // The returned source/confidence reflects which source contained the
  // matched keyword (used by #9 to decide LLM fallback thresholds).
  const SUMMARY_QUESTION_LATIN = /\b(why|interest(s|ed)?|excite[sd]?|exciting|motivat\w*|project|challenge|proud|a time|this (role|position|job|team|opportunity)|our (company|team|mission|product))\b/;
  const SUMMARY_QUESTION_CJK = /为什么|动机|兴趣|项目|挑战/;

  function matchResumeKey(el) {
    if (!el) return null;
    const sources = collectSources(el);
    const rawValues = sources.map((s) => s.value);
    const signalsCJK = rawValues.map(normalize).join(' ');
    const signalsLatin = rawValues.filter(Boolean).map(normalizeSpaced);
    const signalsLatinJoined = signalsLatin.join(' ');

    for (const rule of FIELD_MAP) {
      for (const key of rule.keys) {
        let matched = false;
        if (isCJKKey(key)) {
          if (signalsCJK.includes(normalize(key))) matched = true;
        } else {
          const escaped = normalizeSpaced(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
          if (signalsLatin.some((s) => re.test(s))) matched = true;
        }
        if (!matched) continue;

        if (rule.resumeKey === 'name' || rule.resumeKey === 'firstName' || rule.resumeKey === 'lastName') {
          const blocked = NAME_CONTEXT_BLOCKLIST_LATIN.some((w) => signalsLatinJoined.includes(w));
          const blockedCJK = NAME_CONTEXT_BLOCKLIST_CJK.some((w) => signalsCJK.includes(w));
          if (blocked || blockedCJK) continue;
        }

        if (rule.resumeKey === 'phone') {
          const blocked = PHONE_CONTEXT_BLOCKLIST_LATIN.some((w) => signalsLatinJoined.includes(w));
          if (blocked) continue;
        }

        // "What interests you about this role?", "Tell us about a project…":
        // a question about the job or one experience, not "about you". The
        // summary doesn't answer it (lib/fill/open-answers.js does).
        if (rule.resumeKey === 'summary' && (SUMMARY_QUESTION_LATIN.test(signalsLatinJoined) || SUMMARY_QUESTION_CJK.test(signalsCJK))) continue;

        const sourceName = findWinningSource(key, sources) || 'unknown';
        return {
          key: rule.resumeKey,
          confidence: SOURCE_CONFIDENCE[sourceName] || 0.5,
          source: sourceName,
        };
      }
    }

    if (registeredFallback) {
      try {
        const result = registeredFallback(el, FIELD_MAP);
        if (result && result.key) {
          return {
            key: result.key,
            confidence: typeof result.confidence === 'number' ? result.confidence : SOURCE_CONFIDENCE.fallback,
            source: 'fallback',
          };
        }
      } catch {
        // fallback is best-effort; failures must not break filling
      }
    }

    return null;
  }

  // Register an optional fallback (e.g. an LLM matcher in #9) that runs
  // only when no FIELD_MAP rule hits. Receives (el, FIELD_MAP) and may
  // return { key, confidence } or null.
  function registerFallback(fn) {
    registeredFallback = typeof fn === 'function' ? fn : null;
  }

  global.ResumeFillerFieldDetect = {
    FIELD_MAP,
    SOURCE_CONFIDENCE,
    normalize,
    normalizeSpaced,
    isCJKKey,
    getFieldLabel,
    matchResumeKey,
    registerFallback,
  };
})(typeof window !== 'undefined' ? window : globalThis);
