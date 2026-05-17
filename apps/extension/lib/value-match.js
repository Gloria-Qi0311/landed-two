// lib/value-match.js — value-to-option fuzzy matching
//
// Powers tryFillSelect and tryFillCombobox in content.js. Centralises
// the abbreviation, synonym, and range matching that cross-border ATS
// forms demand (Bachelor ↔ BS, Native ↔ 母语, "3 years" ↔ "3-5 years",
// etc.).
//
// Loaded after lib/field-detect.js and before content.js.
// Exposes window.ResumeFillerValueMatch.

(function (global) {
  // Bidirectional alias table. Each input string is mapped to a Set of
  // every alias in its group (including itself, lowercased + trimmed).
  // Two strings are aliases iff their alias sets intersect.
  const ALIASES = Object.create(null);

  function addAliasGroup(items) {
    const lower = items.map((s) => String(s).trim().toLowerCase());
    for (const item of lower) {
      if (!ALIASES[item]) ALIASES[item] = new Set();
      for (const other of lower) ALIASES[item].add(other);
    }
  }

  // ── Degrees (cross-border core) ────────────────────────────────────────
  addAliasGroup(['Bachelor', 'Bachelors', "Bachelor's", "Bachelor's degree", 'BS', 'BSc', 'BA', 'B.S.', 'B.A.', 'B.Sc.', '学士', '本科', '学士学位']);
  // MBA is grouped with Master so a Chinese-only "硕士" dropdown still
  // accepts MBA as a graceful fallback. When a form has both "Master"
  // and "MBA" as separate options, exact match (1.0) wins over alias
  // (0.9), so the right one is still picked.
  addAliasGroup(['Master', 'Masters', "Master's", "Master's degree", 'MS', 'MSc', 'MA', 'M.S.', 'M.A.', 'M.Sc.', '硕士', '研究生', '硕士学位', 'MBA', 'M.B.A.', '工商管理硕士']);
  addAliasGroup(['PhD', 'Ph.D.', 'Doctorate', 'Doctoral', 'Doctor', '博士', '博士学位']);
  addAliasGroup(['Associate', 'Associates', "Associate's", "Associate's degree", '专科', '副学士', '大专']);
  addAliasGroup(['High School', 'Highschool', 'High school diploma', '高中']);

  // ── Language proficiency (LinkedIn / common ATS scales) ────────────────
  addAliasGroup(['Native', 'Native or bilingual', 'Native speaker', 'Mother tongue', '母语']);
  addAliasGroup(['Fluent', 'Full professional proficiency', 'Full professional', '流利', '精通']);
  addAliasGroup(['Professional', 'Professional working proficiency', 'Professional working', 'Business', '商务', '工作流利']);
  addAliasGroup(['Conversational', 'Limited working proficiency', 'Limited working', 'Intermediate', '日常', '会话', '一般']);
  addAliasGroup(['Beginner', 'Elementary proficiency', 'Elementary', 'Basic', '入门', '基础']);

  // ── Yes / No (frequent on yes-no questions across locales) ─────────────
  addAliasGroup(['Yes', 'Y', 'True', '是', '有', '√']);
  addAliasGroup(['No', 'N', 'False', '否', '没有', '无']);

  // ── Employment-status booleans ─────────────────────────────────────────
  addAliasGroup(['Currently employed', 'Currently working', 'Active', '在职']);
  addAliasGroup(['Open to work', 'Looking', 'Job seeking', '求职中', '待业']);

  // Hyphens are preserved deliberately: "1-2 years" must not normalize
  // to the same string as "12 years". Compound terms like "e-mail" stay
  // distinct from "email" — those equivalences are handled by the alias
  // table instead.
  function normalize(str) {
    return String(str || '').toLowerCase().replace(/[\s_.]/g, '');
  }

  function getAliasSet(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return new Set();
    return ALIASES[key] || new Set([key]);
  }

  // Years-of-experience range parsing. Recognises:
  //   "3-5 years", "3–5", "3~5"           → { min: 3, max: 5 }
  //   "5+ years", "5+"                    → { min: 5, max: 999 }
  //   "less than 1", "under 2"            → { min: 0, max: n-1 }
  //   "3 years", "3"                      → { min: 3, max: 3 }
  //   bare integer                        → { min: n, max: n }
  function parseYearsValue(str) {
    if (str == null) return null;
    const s = String(str);
    const m = s.match(/(\d+)\s*[-–—~到至]\s*(\d+)/);
    if (m) return { min: +m[1], max: +m[2] };
    const plus = s.match(/(\d+)\s*\+/);
    if (plus) return { min: +plus[1], max: 999 };
    const more = s.match(/(?:more\s+than|over|above|greater\s+than|超过|大于)\s*(\d+)/i);
    if (more) return { min: +more[1] + 1, max: 999 };
    const less = s.match(/(?:less\s+than|under|fewer\s+than|<\s*|少于|不足)\s*(\d+)/i);
    if (less) return { min: 0, max: Math.max(0, +less[1] - 1) };
    const lone = s.match(/^\s*(\d+)\s*(?:years?|yrs?|年|岁)?\s*$/i);
    if (lone) return { min: +lone[1], max: +lone[1] };
    const anyDigit = s.match(/(\d+)/);
    if (anyDigit && /year|yr|年|experience|exp|工龄|经验/i.test(s)) {
      const n = +anyDigit[1];
      return { min: n, max: n };
    }
    return null;
  }

  function rangesOverlap(a, b) {
    return a && b && a.min <= b.max && b.min <= a.max;
  }

  // candidates: [{ text: string, value: string, raw?: any }]
  // Returns the best { candidate, confidence, reason } or null.
  // Reasons:
  //   exact      — normalized text or value equals target  (1.0)
  //   alias      — alias-table match                       (0.9)
  //   range      — both target and candidate are years     (0.8)
  //                of-experience and their ranges overlap
  //   substring  — one normalized form contains the other  (0.5..0.65)
  // Always returns the BEST candidate even if low-confidence; callers
  // decide whether to act. #9 will use the score to choose between
  // accepting the rule-based pick and escalating to the LLM matcher.
  function pickBestOption(target, candidates) {
    if (target == null || target === '') return null;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const targetStr = String(target).trim();
    if (!targetStr) return null;

    const tNorm = normalize(targetStr);
    const tAliases = getAliasSet(targetStr);
    const tRange = parseYearsValue(targetStr);

    let best = null;
    function consider(candidate, confidence, reason) {
      if (!best || confidence > best.confidence) {
        best = { candidate, confidence, reason };
      }
    }

    for (const cand of candidates) {
      if (!cand) continue;
      const candText = String(cand.text || '').trim();
      const candValue = String(cand.value || '').trim();
      const cTextNorm = normalize(candText);
      const cValueNorm = normalize(candValue);

      // 1. Exact normalized match on text or value
      if ((cTextNorm && cTextNorm === tNorm) || (cValueNorm && cValueNorm === tNorm)) {
        consider(cand, 1.0, 'exact');
        continue; // Cannot improve on 1.0
      }

      let matched = false;

      // 2. Alias / abbreviation / synonym
      const cAliases = getAliasSet(candText);
      for (const alias of cAliases) {
        if (tAliases.has(alias)) {
          consider(cand, 0.9, 'alias');
          matched = true;
          break;
        }
      }

      // 3. Years-of-experience range
      if (!matched && tRange) {
        const cRange = parseYearsValue(candText) || parseYearsValue(candValue);
        if (rangesOverlap(tRange, cRange)) {
          consider(cand, 0.8, 'range');
          matched = true;
        }
      }

      // 4. Substring containment (legacy fallback)
      if (!matched && cTextNorm && tNorm) {
        if (cTextNorm.includes(tNorm) || tNorm.includes(cTextNorm)) {
          const overlap =
            Math.min(tNorm.length, cTextNorm.length) /
            Math.max(tNorm.length, cTextNorm.length);
          consider(cand, 0.5 + overlap * 0.15, 'substring');
        }
      }
    }

    return best;
  }

  global.ResumeFillerValueMatch = {
    pickBestOption,
    parseYearsValue,
    addAliasGroup,
    normalize,
    ALIASES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
