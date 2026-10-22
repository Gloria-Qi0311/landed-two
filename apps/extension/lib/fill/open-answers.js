// @ts-check
// lib/fill/open-answers.js — open-ended questions ("Why do you want to work
// here?", "Tell us about a project you're proud of"). Landed is a fully
// automatic service: on an approved application these don't stop it. The
// user's own agent (Landed for Mac: their Claude Code, else local Ollama)
// writes each answer from the posting, the resume this application is filled
// from and the user's own edited answers (their voice), and a second call
// checks every answer against the resume before it goes in
// (apps/daemon/src/native-host.ts, draft_answers). Never invents experience.
//
// No agent, or an answer the check didn't pass: the field stays empty and
// yellow ("needs an answer to an open-ended question"), and an approved
// application stops there with that reason. Optional ones are answered only
// when they ask why (interest, motivation); otherwise left blank.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { deepAll, fillField, isRequired, isShown, neverSent, setSource } = F;

/** Optional ones worth answering anyway: why this company or role. */
const WHY = /\bwhy\b|interest(ed|s)? (you|in)|excite|motivat|draws you|为什么|动机|兴趣/i;
/** A one-line text box asks for an essay only when it plainly says so
 *  ("Why do you want to join us?"); "Which team excites you most?" is the
 *  user's own short answer. */
const ESSAY = /^(why|describe|tell (us|me)|explain|walk (us|me)|share|how would you|what (excites|interests|draws|motivates) you)\b|\bwhy\b/i;
/** Not open-ended, whatever the wording: links, names, numbers, dates. */
const NOT_OPEN = /url|link|linkedin|github|website|portfolio|e-?mail|phone|address|salary|compensation|date|year|gpa|how did you hear|referr/i;

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** The question's length limit: the field's own maxlength, else what its
 *  label or hint says ("max 500 characters", "200 words", "300字以内"). */
function limitsOf(el, label) {
  const hint = clean([label, el.getAttribute('placeholder') || '', ...String(el.getAttribute('aria-describedby') || '').split(/\s+/)
    .filter(Boolean).map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))].join(' '));
  const n = (re) => { const m = hint.match(re); return m ? Number(m[1].replace(/,/g, '')) : 0; };
  const own = el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : 0;
  const chars = n(/([\d,]{2,6})\s*(?:characters?|chars?|字符|字)/i);
  const words = n(/([\d,]{2,5})\s*words?/i);
  const maxChars = [own, chars].filter((x) => x > 0);
  return {
    ...(maxChars.length ? { max_chars: Math.min(...maxChars) } : {}),
    ...(words ? { max_words: words } : {}),
  };
}

/** The open-ended questions nothing answered: an empty textarea (or a text
 *  box asking one), not sensitive, required or asking why. */
function openQuestions(manual) {
  /** @type {{ id: string, el: HTMLTextAreaElement | HTMLInputElement, question: string, required: boolean, max_chars?: number, max_words?: number }[]} */
  const out = [];
  for (const item of manual) {
    if (item.hint !== '未匹配') continue;
    const el = /** @type {any} */ (deepAll(`[data-landed-field-id="${item.id}"]`)[0]);
    if (!el || !isShown(el) || String(el.value || '').trim()) continue;
    const question = clean(item.label).replace(/\s*[*✱]\s*$/, '');
    if (!question || neverSent(question) || NOT_OPEN.test(question)) continue;
    const textarea = el instanceof HTMLTextAreaElement;
    const textbox = el instanceof HTMLInputElement && ['', 'text'].includes((el.getAttribute('type') || '').toLowerCase());
    // A text box only when it plainly asks one ("Why do you want to join us?").
    if (!textarea && !(textbox && ESSAY.test(question) && question.length >= 15)) continue;
    const required = isRequired(el, item.label);
    if (!required && !WHY.test(question)) continue;
    out.push({ id: item.id, el, question, required, ...limitsOf(el, question) });
  }
  return out.slice(0, 8);
}

function askNativeHost(request) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'native-assist', request }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The job this page is for: what Landed knows (the lead), else the page. */
function jobOf(opts) {
  const job = opts.job && typeof opts.job === 'object' ? opts.job : {};
  const heading = document.querySelector('h1, h2');
  const main = /** @type {HTMLElement} */ (document.querySelector('main, [role="main"], #content, .content') || document.body);
  return {
    role: clean(job.role || (heading && heading.textContent) || document.title).slice(0, 200),
    company: clean(job.company).slice(0, 120),
    description: clean(job.description || (main && (main.innerText || main.textContent))).slice(0, 6000),
  };
}

const NOTE = "Landed's agent wrote this from the posting and your resume.";
const MISSING_NOTE = 'needs an answer to an open-ended question: Landed writes these with your agent (Landed for Mac).';

/** Answer the open-ended questions this fill left empty. Answers already
 *  written for this application (`opts.drafted`, by question) go back in as
 *  they were. Returns what was written (for the application's record) and
 *  how many required ones still need an answer. */
async function writeOpenAnswers(manual, resumeData, opts) {
  const summary = { written: /** @type {{ question: string, answer: string }[]} */ ([]), missing: 0, rejected: 0, model: null, error: null };
  const items = openQuestions(manual);
  if (items.length === 0) return summary;
  const drafted = opts.drafted && typeof opts.drafted === 'object' ? opts.drafted : {};
  /** @type {Record<string, string>} */
  const answers = {};
  for (const item of items) if (typeof drafted[item.question] === 'string' && drafted[item.question].trim()) answers[item.id] = drafted[item.question];
  const ask = items.filter((item) => !answers[item.id]);
  if (ask.length) {
    const started = Date.now();
    const response = await askNativeHost({
      type: 'draft_answers',
      job: jobOf(opts),
      resume: resumeData || {},
      examples: Array.isArray(opts.examples) ? opts.examples.slice(0, 4) : [],
      questions: ask.map(({ id, question, max_chars, max_words }) => ({ id, question, max_chars, max_words })),
    });
    if (!response || !response.ok) summary.error = (response && response.error) || 'Landed for Mac did not answer';
    else {
      summary.model = typeof response.model === 'string' ? response.model : null;
      const got = response.answers && typeof response.answers === 'object' ? response.answers : {};
      for (const item of ask) if (typeof got[item.id] === 'string' && got[item.id].trim()) answers[item.id] = got[item.id];
      summary.rejected = response.rejected && typeof response.rejected === 'object' ? Object.keys(response.rejected).length : 0;
    }
    F.traceModel?.('draft_answers', { asked: ask.length, answered: ask.filter((i) => answers[i.id]).length, model: summary.model, error: summary.error, ms: Date.now() - started });
  }
  for (const item of items) {
    const text = answers[item.id];
    const index = manual.findIndex((m) => m.id === item.id);
    if (text) {
      fillField(item.el, text);
      if (item.el.getAttribute('data-landed-status') === 'filled') {
        setSource(item.el, 'draft');
        item.el.setAttribute('data-landed-note', NOTE);
        if (!item.el.getAttribute('title')) item.el.setAttribute('title', `Landed: ${NOTE}`);
        if (index >= 0) manual.splice(index, 1);
        summary.written.push({ question: item.question, answer: text });
        continue;
      }
    }
    // Left for the user; a required one stops an approved application.
    if (item.required && index >= 0) {
      manual[index].hint = '开放题';
      item.el.setAttribute('data-landed-note', MISSING_NOTE);
      summary.missing++;
    }
  }
  return summary;
}

Object.assign(F, { openQuestions, writeOpenAnswers });
})(typeof window !== 'undefined' ? window : globalThis);
