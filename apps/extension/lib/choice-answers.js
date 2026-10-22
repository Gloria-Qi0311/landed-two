// lib/choice-answers.js — answer form questions from the user's saved
// application answers (Landed → My Resume → Application answers; schema:
// packages/schema/src/application-answers.ts).
//
//   classify(label)            which question a label asks ("needs_sponsorship"…)
//   answerFor(kind, answers)   what to answer: yes/no, decline, agree, or text
//   pickOption(answer, opts)   which of a radio group's / dropdown's options that is
//   answerFlat(answers)        extra keys the local model may map unknown text fields to
//   answerFacts(answers, flat) plain facts for the local model to pick options from
//
// Rules only — no guessing. A question without a saved answer returns null
// and the field stays yellow for the user. Consent is answered only when the
// user turned on "Tick consent boxes for me". Submit is never touched here.
//
// Loaded before content.js (manifest content_scripts); required by Jest.

(function (global) {
  const ANSWERS_KEY = 'landed:application-answers';
  const FILES_KEY = 'landed:application-files';

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/^[\s*:：?？.]+|[\s*:：?？.!]+$/g, '')
      .trim();
  }

  // [kind, pattern, longest label it applies to]. Order matters: the first
  // match wins (sponsorship before authorization — one question often
  // mentions both; "preferred name" before plain names).
  const RULES = [
    ['consent', /(privacy (policy|notice|statement)|terms (and|&) conditions|terms of (use|service)|\bi (have read|agree|consent|acknowledge|accept|certify|confirm|authori[sz]e)\b|\bconsent\b|data (processing|protection)|隐私|同意.{0,8}(条款|政策|协议))/],
    ['needs_sponsorship', /(sponsor|签证担保|visa support|h-?1b)/],
    ['work_authorized', /((authori[sz]ed|eligible|permitted|entitled) (to work|for employment)|right to work|work authori[sz]ation|work permit|工作许可|合法.{0,6}工作)/],
    ['adult', /((18|eighteen) (years|yrs)( of age)?( or older| and older| or over|\+)|at least (18|eighteen)|legal (working )?age|年满 ?18|成年)/],
    ['has_preferred_name', /((have|has) (a )?preferred name|preferred name (that is |which is )?different|different (from|than) your legal name)/],
    ['preferred_first_name', /(preferred (first|given) name|^preferred name$)/, 60],
    ['preferred_last_name', /(preferred (last|family) name|preferred surname)/, 60],
    ['legal_middle_name', /middle name/, 60],
    ['legal_first_name', /^((legal|official) )?(first|given) name|^名$|^名字$/, 40],
    ['legal_last_name', /^((legal|official) )?(last|family) name|^surname|^姓$|^姓氏$/, 40],
    ['date_of_birth', /(date of birth|birth ?date|day and month of birth|birthday|出生日期|生日)/],
    ['address_line2', /(address line 2|^apt|apartment|^suite|^unit)/, 40],
    ['address_line1', /(^address( line 1)?$|address line 1|^street|^home address|^permanent address$|^地址)/, 40],
    ['city', /(^city|^town|^location \(city\)|城市)/, 30],
    ['state', /(^state|province|^region|州$|^省)/, 30],
    ['postal_code', /(zip|postal|post ?code|邮编|邮政编码)/, 30],
    ['country', /(^country|^nation|^国家)/, 30],
    ['earliest_start', /(start date|available to start|earliest (start|date|available)|availability date|when can you start|date (are|would) you (be )?available|入职)/],
    ['previously_employed', /((worked|been employed) (at|for|by|with) .{1,40}(before|previously|in the past)|ever worked|previously (worked|employed)|former employee|曾.{0,4}(工作|任职))/],
    ['open_to_other_locations', /(other locations|considered for (positions|roles|opportunities) (in|at) other)/],
    ['relocate', /(relocat|搬迁|异地工作)/],
    ['travel', /(\btravel\b|出差)/],
    ['onsite', /(on-?site|in[- ]office|in the office|office \d+ days|days a week in|return to (the )?office|work arrangement|到岗|坐班)/],
    ['preferred_location_1', /(first choice|1st choice|first preference)/, 40],
    ['preferred_location_2', /(second choice|2nd choice|second preference)/, 40],
    ['preferred_location_3', /(third choice|3rd choice|third preference)/, 40],
    ['non_compete', /(non-?compete|restrictive covenant|竞业)/],
    ['heard_from', /(how did you (hear|find out|learn|discover)|where did you (hear|find|learn|see)|referral source|source of (application|referral)|how.{0,20}(hear|learn) about|如何得知|从哪里.{0,4}(得知|了解)|渠道)/],
    ['talent_network', /(talent (network|community|pool)|job alerts)/],
    ['linkedin', /linkedin|领英/, 60],
    ['github', /github/, 60],
    ['website', /(^website|^web site|personal (website|site|page)|portfolio|^blog|个人网站|作品集)/, 60],
    ['hispanic_latino', /(hispanic|latino|latinx|^ethnicity)/],
    ['race', /(\brace\b|种族)/],
    ['gender', /(gender|^sex$|性别)/],
    ['veteran', /(veteran|退伍)/],
    ['disability', /(disabilit|残疾|残障)/],
    ['today', /(today'?s date|^date$|current date|signature date|date signed)/, 30],
    ['signature_name', /(^your (full )?name$|signature|^full legal name$|^legal name$)/, 40],
  ];

  function classify(label) {
    const n = norm(label);
    if (!n) return null;
    for (const [kind, pattern, maxLen] of RULES) {
      if (maxLen && n.length > maxLen) continue;
      if (pattern.test(n)) return kind;
    }
    return null;
  }

  const YES_NO_KINDS = new Set([
    'adult', 'onsite', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations', 'previously_employed',
    'non_compete', 'talent_network',
  ]);
  const TEXT_KINDS = new Set([
    'legal_first_name', 'legal_middle_name', 'legal_last_name', 'preferred_first_name', 'preferred_last_name',
    'date_of_birth', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'earliest_start', 'heard_from',
    'linkedin', 'github', 'website',
  ]);

  function pad(n) { return String(n).padStart(2, '0'); }

  /** What to answer, or null to leave it for the user. `ctx.today` (a Date)
   *  and `ctx.dateInput` (an <input type=date>) shape "today". */
  // ── "Have you worked here before?" is about one company ────────────────
  // The saved answer can't say it for every company: a Yes saved from one
  // form once made every company's question Yes. The resume decides: a
  // company it lists (named in the question, or the careers site's host) is
  // Yes; any other is No when the saved answer is No or blank. A saved Yes
  // for a company the resume doesn't show leaves the question to the user.

  function companyNorm(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|the|n a|s a|ag|nv|bv)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Does the question, or the site it's on, name one of these employers? */
  function namesEmployer(question, employers, site) {
    const q = ` ${companyNorm(question)} `;
    const host = String(site || '').toLowerCase().split('.');
    return (Array.isArray(employers) ? employers : []).some((e) => {
      const n = companyNorm(e);
      if (n.length < 2) return false;
      if (q.includes(` ${n} `)) return true;
      const compact = n.replace(/ /g, '');
      return compact.length >= 4 && host.some((part) => part === compact || part.startsWith(compact));
    });
  }

  function previouslyEmployed(answers, ctx) {
    const employers = Array.isArray(ctx.employers) ? ctx.employers : null;
    if (employers && ctx.question && namesEmployer(ctx.question, employers, ctx.site)) return { type: 'yesno', value: 'yes' };
    if (answers.previously_employed === 'no') return { type: 'yesno', value: 'no' };
    if (answers.previously_employed == null && employers && employers.length > 0 && ctx.question) return { type: 'yesno', value: 'no' };
    return null;
  }

  function answerFor(kind, answers, ctx) {
    if (!kind || !answers || typeof answers !== 'object') return null;
    ctx = ctx || {};
    const text = (v) => (typeof v === 'string' && v.trim() ? { type: 'text', value: v.trim() } : null);
    const yn = (v) => (v === 'yes' || v === 'no' ? { type: 'yesno', value: v } : null);
    if (kind === 'consent') return answers.agree_to_terms === true ? { type: 'agree' } : null;
    if (kind === 'previously_employed') return previouslyEmployed(answers, ctx);
    if (kind === 'work_authorized' && /(without (any )?restrictions?.{0,80}(length|period)|non-immigrant status|including (opt|cpt))/i.test(ctx.question || '')) {
      // This is stricter than the ordinary "authorized to work" question:
      // Workday explicitly says a time-limited non-immigrant status is No.
      // Needing sponsorship (or not being authorized) proves No; the saved
      // generic authorization answer alone cannot safely prove Yes.
      if (answers.work_authorized === 'no' || answers.needs_sponsorship === 'yes') return { type: 'yesno', value: 'no' };
      return null;
    }
    if (YES_NO_KINDS.has(kind)) return yn(answers[kind]);
    if (TEXT_KINDS.has(kind)) return text(answers[kind]);
    if (kind === 'has_preferred_name') {
      if (text(answers.preferred_first_name) || text(answers.preferred_last_name)) return { type: 'yesno', value: 'yes' };
      return text(answers.legal_first_name) ? { type: 'yesno', value: 'no' } : null;
    }
    if (kind.startsWith('preferred_location_')) {
      const list = Array.isArray(answers.preferred_locations) ? answers.preferred_locations : [];
      return text(list[Number(kind.slice(-1)) - 1]);
    }
    // Voluntary self-identification: blank means "I don't wish to answer".
    if (kind === 'gender' || kind === 'race') return text(answers[kind]) || { type: 'decline' };
    if (kind === 'hispanic_latino' || kind === 'veteran' || kind === 'disability') return yn(answers[kind]) || { type: 'decline' };
    if (kind === 'signature_name') {
      // How people sign: legal first + last name.
      const first = text(answers.legal_first_name);
      const last = text(answers.legal_last_name);
      return first && last ? { type: 'text', value: `${first.value} ${last.value}` } : null;
    }
    if (kind === 'today') {
      const d = ctx.today instanceof Date ? ctx.today : new Date();
      return {
        type: 'text',
        value: ctx.dateInput ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
      };
    }
    return null;
  }

  // ── options ──────────────────────────────────────────────────────────────

  const DECLINE = /(decline|don't wish|do not wish|prefer not|choose not|rather not|not (to )?(disclose|answer|say|specify|self-identify|provide)|i don't want|不愿|不透露|不想|不提供)/;
  const NEGATION = /(\bnot\b|\bno\b|\bnon-?|\bdon't\b|\bdo not\b|\bdoesn't\b|\bnever\b|不是|没有|否)/;
  const DISAGREE = /(\bnot\b|\bdon't\b|\bdo not\b|\bdecline\b|\bdisagree\b|不同意|不接受)/;
  const AGREE = /(\bagree\b|\bconsent\b|\baccept\b|\backnowledge\b|\bauthori[sz]e\b|\bconfirm\b|^yes\b|^i do\b|同意|接受)/;

  const ALIAS_GROUPS = [
    ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'america', '美国'],
    ['china', "people's republic of china", 'prc', 'mainland china', 'china (mainland)', 'china mainland', '中国', '中国大陆'],
    ['united kingdom', 'uk', 'great britain', 'england', '英国'],
    ['canada', '加拿大'], ['hong kong', 'hong kong sar', 'hong kong, china', '香港'], ['singapore', '新加坡'],
    ['male', 'man', '男', '男性'], ['female', 'woman', '女', '女性'],
    ['non-binary', 'nonbinary', 'non binary', 'gender non-conforming'],
    ['asian', 'asian (not hispanic or latino)', 'asian american', '亚裔'],
    ['white', 'white (not hispanic or latino)', 'caucasian'],
    ['black or african american', 'black', 'african american', 'black or african american (not hispanic or latino)'],
  ];
  const US_STATES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware',
    dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
    ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
    ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
    nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon',
    pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
    vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  };
  for (const [abbr, name] of Object.entries(US_STATES)) ALIAS_GROUPS.push([name, abbr]);

  const ALIASES = new Map();
  for (const group of ALIAS_GROUPS) for (const item of group) ALIASES.set(item, group);

  const words = (s) => norm(s).replace(/[^\p{L}\p{N}' -]+/gu, ' ').split(/[\s-]+/).filter(Boolean);
  const isPlaceholder = (s) => {
    const n = norm(s);
    return !n || /^(select|choose|please select|please choose|--|—|请选择|选择)/.test(n);
  };

  function sameText(want, option) {
    const a = norm(want);
    const b = norm(option);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const group = ALIASES.get(a);
    if (group && group.includes(b)) return 0.95;
    // Option names it and adds a qualifier: "Asian" ↔ "Asian (Not Hispanic or Latino)".
    const ow = words(b);
    const ww = words(a);
    if (ww.length && ww.every((w) => ow.includes(w))) return 0.85 - Math.min(ow.length - ww.length, 10) * 0.01;
    // The saved text is the longer one: "IBM Careers website" ↔ "Careers website".
    if (ow.length >= 2 && ow.every((w) => ww.includes(w))) return 0.8;
    return 0;
  }

  function yesNoScore(want, option) {
    const n = norm(option);
    if (!n || DECLINE.test(n)) return 0;
    if (want === 'yes') {
      if (/^(yes|y|是|有)\b/.test(n) || n === '是' || n === '有') return 1;
      if (/\b(i am|i identify|i have|i will|i do)\b/.test(n) && !NEGATION.test(n)) return 0.8;
      return 0;
    }
    if (/^(no|n|否|没有|不)\b/.test(n) || n === '否' || n === '无') return 1;
    if (NEGATION.test(n)) return 0.8;
    return 0;
  }

  /** Index of the option that says `answer`, or -1. A tie between two
   *  equally good options is no answer (the user picks). */
  function pickOption(answer, options) {
    if (!answer || !Array.isArray(options) || options.length === 0) return -1;
    const scores = options.map((opt) => {
      if (isPlaceholder(opt)) return 0;
      const n = norm(opt);
      if (answer.type === 'decline') return DECLINE.test(n) ? 1 : 0;
      if (answer.type === 'agree') return AGREE.test(n) && !DISAGREE.test(n) ? 1 : 0;
      if (answer.type === 'yesno') return yesNoScore(answer.value, opt);
      if (answer.type === 'text') return sameText(answer.value, opt);
      return 0;
    });
    const best = Math.max(...scores);
    if (best < 0.75) return -1;
    const at = scores.indexOf(best);
    return scores.indexOf(best, at + 1) === -1 ? at : -1;
  }

  // ── for the local model ──────────────────────────────────────────────────

  /** Text answers as extra keys an unknown text field may be mapped to
   *  (by name — the model never sees the values), plus "other questions"
   *  keyed by their own wording. */
  function answerFlat(answers) {
    const out = {};
    if (!answers || typeof answers !== 'object') return out;
    for (const kind of TEXT_KINDS) {
      if (typeof answers[kind] === 'string' && answers[kind].trim()) out[kind] = answers[kind].trim();
    }
    const locations = Array.isArray(answers.preferred_locations) ? answers.preferred_locations : [];
    locations.forEach((l, i) => { if (typeof l === 'string' && l.trim()) out[`preferred_location_${i + 1}`] = l.trim(); });
    for (const c of Array.isArray(answers.custom) ? answers.custom : []) {
      if (c && typeof c.question === 'string' && typeof c.answer === 'string' && c.question.trim() && c.answer.trim()) {
        out[c.question.trim().slice(0, 120)] = c.answer.trim();
      }
    }
    return out;
  }

  const FACT_LABELS = {
    country: 'Country of residence', city: 'City', state: 'State', work_authorized: 'Legally authorized to work in the US',
    needs_sponsorship: 'Needs visa sponsorship now or in the future', earliest_start: 'Earliest full-time start',
    relocate: 'Willing to relocate', travel: 'Willing to travel', open_to_other_locations: 'Open to other locations',
    non_compete: 'Bound by a non-compete', heard_from: 'Heard about the job from',
    talent_network: 'Wants to join the talent network', adult: '18 years of age or older',
    onsite: 'Open to working onsite / in the office full time',
  };

  /** Facts the local model may use to pick an option (never sent anywhere
   *  else): the saved answers that aren't sensitive, "other questions", and
   *  a few plain resume facts. */
  function answerFacts(answers, flat, employers) {
    const facts = [];
    if (answers && typeof answers === 'object') {
      for (const [key, label] of Object.entries(FACT_LABELS)) {
        const v = answers[key];
        if (typeof v === 'string' && v.trim()) facts.push(`${label}: ${v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v.trim()}`);
      }
      const locations = (Array.isArray(answers.preferred_locations) ? answers.preferred_locations : []).filter((l) => typeof l === 'string' && l.trim());
      if (locations.length) facts.push(`Preferred locations: ${locations.join('; ')}`);
      for (const c of Array.isArray(answers.custom) ? answers.custom : []) {
        if (c && c.question && c.answer) facts.push(`${String(c.question).slice(0, 300)}: ${String(c.answer).slice(0, 500)}`);
      }
    }
    flat = flat || {};
    const pick = (label, ...keys) => {
      for (const k of keys) {
        if (typeof flat[k] === 'string' && flat[k].trim()) {
          facts.push(`${label}: ${flat[k].trim().slice(0, 200)}`);
          return;
        }
      }
    };
    pick('School', 'edu_school', 'school');
    pick('Degree', 'edu_degree', 'degree');
    pick('Major', 'edu_major', 'major');
    pick('Current or most recent employer', 'current_company', 'company');
    // Whether they worked at a company comes from here, not a saved yes/no.
    const past = (Array.isArray(employers) ? employers : []).filter((e) => typeof e === 'string' && e.trim()).slice(0, 15);
    if (past.length) facts.push(`Employers on the resume (the only ones they have worked for): ${past.join('; ')}`);
    pick('Current or most recent title', 'current_title', 'title');
    pick('Location', 'location');
    return facts.slice(0, 60);
  }

  /** Which saved file an upload field wants, from its label. */
  function fileKind(label) {
    const n = norm(label);
    if (!n) return null;
    if (/(cover ?letter|motivation letter|求职信|自荐信)/.test(n)) return 'cover_letter';
    if (/(resume|résumé|\bcv\b|curriculum vitae|简历|履历)/.test(n)) return 'resume';
    return null;
  }

  // ── "other questions": the same question, however a form words it ──────
  // Mirrors questionKey / sameQuestion in packages/schema/src/application-answers.ts
  // (keep the two in step): the Extension page saves an answer under the
  // question as one form asked it, and every form after that gets it.

  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'do', 'does', 'did', 'you', 'your', 'are', 'is', 'am',
    'have', 'has', 'how', 'many', 'what', 'which', 'please', 'we', 'us', 'our', 'this', 'that', 'any', 'be', 'will', 'would', 'if', 'can',
    'select', 'enter', 'provide', 'required', 'optional', 'yes', 'no', 'currently', 'company',
  ]);

  function questionKey(question) {
    return String(question || '').toLowerCase().replace(/\((?:required|optional)\)|\*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function sameQuestion(a, b) {
    const ka = questionKey(a);
    const kb = questionKey(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    const words = (k) => new Set(k.split(' ').filter((w) => w.length >= 2 && !STOP_WORDS.has(w)));
    const wa = words(ka);
    const wb = words(kb);
    if (wa.size < 2 || wb.size < 2) return false;
    let both = 0;
    for (const w of wa) if (wb.has(w)) both++;
    return both / (wa.size + wb.size - both) >= 0.8;
  }

  /** The saved "other question" this label asks, as a text answer; null when none. */
  function customAnswerFor(label, answers) {
    if (!label || !answers || !Array.isArray(answers.custom)) return null;
    const hit = answers.custom.find((c) => c && typeof c.question === 'string' && typeof c.answer === 'string' && c.answer.trim() && sameQuestion(c.question, label));
    return hit ? { type: 'text', value: hit.answer.trim() } : null;
  }

  /** Answers a pending question can be saved to on the Extension page
   *  (ANSWER_KEYS in application-answers.ts, without the sensitive ones).
   *  Not previously_employed: that follows the resume, one company at a time. */
  const ASKABLE_KEYS = new Set([
    'legal_first_name', 'legal_middle_name', 'legal_last_name', 'preferred_first_name', 'preferred_last_name',
    'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'earliest_start', 'heard_from', 'linkedin', 'github', 'website',
    'adult', 'onsite', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations',
    'non_compete', 'talent_network',
  ]);

  /** Questions only the user's answers can answer: with none saved, a fill
   *  leaves them for the user instead of a resume field that happens to
   *  match ("How did you hear about us?" once got the resume summary). */
  const ANSWER_ONLY = new Set([
    'heard_from', 'adult', 'onsite', 'work_authorized', 'needs_sponsorship', 'relocate', 'travel', 'open_to_other_locations',
    'previously_employed', 'non_compete', 'talent_network',
  ]);

  const api = { namesEmployer, ANSWERS_KEY, FILES_KEY, fileKind, sameText, norm, classify, answerFor, pickOption, answerFlat, answerFacts, questionKey, sameQuestion, customAnswerFor, ASKABLE_KEYS, ANSWER_ONLY };
  global.LandedChoiceAnswers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
