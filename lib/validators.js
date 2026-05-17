// Resume field validators. Pure functions, no DOM, no chrome.* — safe to
// import from tests and from options.js. Hand-rolled regex (issue #11 explicitly
// rules out a validation library — extension ships unbundled so every dep is
// load weight).
//
// Each per-field validator returns null when the value is acceptable, or an
// i18n key (string) describing the error. Empty strings are acceptable here —
// "required" is checked separately in validateResume() so that the field-level
// blur handler doesn't yell at users who haven't typed yet.

(function (global) {
  // Pragmatic email check: local part, @, then one-or-more domain labels
  // followed by a 2+ char TLD. Not RFC 5322 (unimplementable in a single
  // regex) — but rejects the typos that actually happen: no @, no TLD,
  // consecutive dots ("foo@bar..com"), empty domain label ("foo@.com").
  const EMAIL_RE = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

  // International phone: optional leading +, then 7–20 chars of digits and
  // common separators (space, dash, parens, dot). Rejects letters and overly
  // short numbers. Doesn't enforce country-specific formats — too brittle.
  const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

  // URL: accepts http(s):// prefix or bare host. Requires a dot in the host
  // so "linkedin" alone fails but "linkedin.com/in/foo" passes. After the host
  // any of /path, ?query, or #fragment may follow ("linkedin.com?ref=share"
  // is a real share-link shape).
  const URL_RE = /^(https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}([/?#][^\s]*)?$/i;

  function validateEmail(value) {
    if (!value) return null;
    return EMAIL_RE.test(value) ? null : 'validation.email_format';
  }

  function validatePhone(value) {
    if (!value) return null;
    return PHONE_RE.test(value) ? null : 'validation.phone_format';
  }

  function validateUrl(value) {
    if (!value) return null;
    return URL_RE.test(value) ? null : 'validation.url_format';
  }

  // Map a top-level resume path to the appropriate validator. Used by the
  // editor's per-input blur handler. Returns null when the path has no
  // format constraint (so the caller can skip).
  function validatorForPath(path) {
    if (path === 'basic.email') return validateEmail;
    if (path === 'basic.phone') return validatePhone;
    if (path === 'basic.linkedin' || path === 'basic.github' || path === 'basic.portfolio') {
      return validateUrl;
    }
    return null;
  }

  // Returns true when the entry has at least one non-empty string field
  // (other than `current`, which is a boolean default). Used to decide
  // whether a partially-filled array entry should trigger "required"
  // warnings or be treated as an empty slot.
  function entryHasContent(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return Object.keys(entry).some((k) => {
      const v = entry[k];
      return typeof v === 'string' && v.trim().length > 0;
    });
  }

  // Full-resume validation. Returns an array of issue records:
  //   { section, idx, key, errorKey }
  // where:
  //   section  — 'basic' | 'education' | 'experience' | 'internship' | 'projects'
  //   idx      — array index (null for basic)
  //   key      — field within the section (e.g. 'email', 'school')
  //   errorKey — i18n key for the error message
  // Empty array means clean. Used by options.js save() to render the top
  // banner; per-field inline errors are surfaced separately at blur time.
  function validateResume(resume) {
    const issues = [];
    if (!resume || typeof resume !== 'object') return issues;

    const basic = resume.basic || {};
    const name = (basic.name || '').trim();
    const firstName = (basic.firstName || '').trim();
    const lastName = (basic.lastName || '').trim();
    const englishName = (basic.englishName || '').trim();
    const chineseName = (basic.chineseName || '').trim();
    const hasAnyName = name || (firstName && lastName) || englishName || chineseName;
    if (!hasAnyName) {
      issues.push({ section: 'basic', idx: null, key: 'name', errorKey: 'validation.required' });
    }
    if (!basic.email) {
      issues.push({ section: 'basic', idx: null, key: 'email', errorKey: 'validation.required' });
    } else {
      const emailErr = validateEmail(basic.email);
      if (emailErr) issues.push({ section: 'basic', idx: null, key: 'email', errorKey: emailErr });
    }
    if (!basic.phone) {
      issues.push({ section: 'basic', idx: null, key: 'phone', errorKey: 'validation.required' });
    } else {
      const phoneErr = validatePhone(basic.phone);
      if (phoneErr) issues.push({ section: 'basic', idx: null, key: 'phone', errorKey: phoneErr });
    }
    ['linkedin', 'github', 'portfolio'].forEach((k) => {
      const err = validateUrl(basic[k] || '');
      if (err) issues.push({ section: 'basic', idx: null, key: k, errorKey: err });
    });

    const arrayRequiredKey = {
      education: 'school',
      experience: 'company',
      internship: 'company',
      projects: 'name',
    };
    Object.keys(arrayRequiredKey).forEach((section) => {
      const items = Array.isArray(resume[section]) ? resume[section] : [];
      items.forEach((item, idx) => {
        if (!entryHasContent(item)) return;
        const reqKey = arrayRequiredKey[section];
        if (!item[reqKey] || !item[reqKey].trim()) {
          issues.push({ section, idx, key: reqKey, errorKey: 'validation.required' });
        }
        if (section === 'projects') {
          const err = validateUrl(item.link || '');
          if (err) issues.push({ section, idx, key: 'link', errorKey: err });
        }
      });
    });

    return issues;
  }

  global.ResumeFillerValidators = {
    validateEmail,
    validatePhone,
    validateUrl,
    validatorForPath,
    validateResume,
    entryHasContent,
  };
})(typeof window !== 'undefined' ? window : globalThis);
