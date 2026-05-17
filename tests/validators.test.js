require('../lib/validators.js');
const V = globalThis.ResumeFillerValidators;

describe('validateEmail', () => {
  test('accepts empty (handled by required check)', () => {
    expect(V.validateEmail('')).toBeNull();
  });
  test.each([
    'foo@bar.com',
    'a.b+tag@example.co.uk',
    'user_123@sub.domain.io',
  ])('accepts valid: %s', (e) => {
    expect(V.validateEmail(e)).toBeNull();
  });
  test.each([
    'foo',
    'foo@bar',
    '@bar.com',
    'foo@.com',
    'foo @bar.com',
    'foo@bar..com',
  ])('rejects invalid: %s', (e) => {
    expect(V.validateEmail(e)).toBe('validation.email_format');
  });
});

describe('validatePhone', () => {
  test('accepts empty', () => {
    expect(V.validatePhone('')).toBeNull();
  });
  test.each([
    '+1 (415) 555-1234',
    '+86 138-0000-0000',
    '13800001234',
    '(415) 555-1234',
    '+44 20 7946 0958',
  ])('accepts valid: %s', (p) => {
    expect(V.validatePhone(p)).toBeNull();
  });
  test.each([
    '123',          // too short
    'abc-def-ghij', // letters
    '+1 (415) 555-1234 ext. 99', // contains letters
    '+1234567890123456789012',   // too long (>20 chars)
  ])('rejects invalid: %s', (p) => {
    expect(V.validatePhone(p)).toBe('validation.phone_format');
  });
});

describe('validateUrl', () => {
  test('accepts empty', () => {
    expect(V.validateUrl('')).toBeNull();
  });
  test.each([
    'https://linkedin.com/in/foo',
    'http://github.com/foo',
    'linkedin.com/in/foo',
    'github.com/foo',
    'sub.domain.example.io/path/to/thing?query=1#frag',
    'foo.bar.co.uk',
    'linkedin.com?ref=share',
    'example.com#anchor',
  ])('accepts valid: %s', (u) => {
    expect(V.validateUrl(u)).toBeNull();
  });
  test.each([
    'linkedin',          // no dot
    'http://',           // no host
    'foo bar.com',       // space in host
    '.com',              // empty label
    'foo.',              // empty TLD
  ])('rejects invalid: %s', (u) => {
    expect(V.validateUrl(u)).toBe('validation.url_format');
  });
});

describe('validatorForPath', () => {
  test('maps known paths', () => {
    expect(V.validatorForPath('basic.email')).toBe(V.validateEmail);
    expect(V.validatorForPath('basic.phone')).toBe(V.validatePhone);
    expect(V.validatorForPath('basic.linkedin')).toBe(V.validateUrl);
    expect(V.validatorForPath('basic.github')).toBe(V.validateUrl);
    expect(V.validatorForPath('basic.portfolio')).toBe(V.validateUrl);
  });
  test('returns null for paths without a format constraint', () => {
    expect(V.validatorForPath('basic.name')).toBeNull();
    expect(V.validatorForPath('intent.salary')).toBeNull();
    expect(V.validatorForPath('basic.location')).toBeNull();
  });
});

describe('entryHasContent', () => {
  test('false for empty / null / array entry with only blanks', () => {
    expect(V.entryHasContent(null)).toBe(false);
    expect(V.entryHasContent({})).toBe(false);
    expect(V.entryHasContent({ school: '', degree: '', current: false })).toBe(false);
    expect(V.entryHasContent({ school: '   ' })).toBe(false);
  });
  test('true when any string field has non-whitespace content', () => {
    expect(V.entryHasContent({ school: 'PKU' })).toBe(true);
    expect(V.entryHasContent({ school: '', description: 'x' })).toBe(true);
  });
  test('ignores boolean fields (current=true alone is not content)', () => {
    expect(V.entryHasContent({ current: true })).toBe(false);
  });
});

describe('validateResume', () => {
  const blank = {
    basic: { name: '', firstName: '', lastName: '', email: '', phone: '', linkedin: '', github: '', portfolio: '' },
    education: [],
    experience: [],
    internship: [],
    projects: [],
  };

  test('null/non-object → no issues', () => {
    expect(V.validateResume(null)).toEqual([]);
    expect(V.validateResume('not an object')).toEqual([]);
  });

  test('blank resume flags required name/email/phone', () => {
    const issues = V.validateResume(blank);
    const required = issues.filter((i) => i.errorKey === 'validation.required');
    expect(required.find((i) => i.key === 'name')).toBeTruthy();
    expect(required.find((i) => i.key === 'email')).toBeTruthy();
    expect(required.find((i) => i.key === 'phone')).toBeTruthy();
  });

  test('fully-filled basic with valid contacts → clean basic', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.name = 'Esther';
    r.basic.email = 'esther@example.com';
    r.basic.phone = '+1 (415) 555-1234';
    r.basic.linkedin = 'linkedin.com/in/esther';
    const issues = V.validateResume(r);
    expect(issues.filter((i) => i.section === 'basic')).toEqual([]);
  });

  test('first+last name satisfies the name requirement (no basic.name)', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.firstName = 'Es';
    r.basic.lastName = 'Yuan';
    r.basic.email = 'a@b.co';
    r.basic.phone = '13800001234';
    const issues = V.validateResume(r);
    expect(issues.find((i) => i.key === 'name')).toBeUndefined();
  });

  test('invalid format errors surface with format key, not required key', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.email = 'not-an-email';
    r.basic.phone = '123';
    r.basic.linkedin = 'linkedin';
    const issues = V.validateResume(r);
    expect(issues.find((i) => i.key === 'email').errorKey).toBe('validation.email_format');
    expect(issues.find((i) => i.key === 'phone').errorKey).toBe('validation.phone_format');
    expect(issues.find((i) => i.key === 'linkedin').errorKey).toBe('validation.url_format');
  });

  test('array entry with only "current=true" is treated as empty (no required errors)', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.name = 'x'; r.basic.email = 'a@b.co'; r.basic.phone = '13800001234';
    r.experience = [{ company: '', title: '', current: true }];
    const issues = V.validateResume(r);
    expect(issues.find((i) => i.section === 'experience')).toBeUndefined();
  });

  test('array entry with content but missing required key', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.name = 'x'; r.basic.email = 'a@b.co'; r.basic.phone = '13800001234';
    r.education = [{ school: '', major: 'CS', degree: 'BS' }];
    r.experience = [{ company: '', title: 'PM' }];
    r.internship = [{ company: '', title: 'Intern' }];
    r.projects = [{ name: '', description: 'Built X' }];
    const issues = V.validateResume(r);
    expect(issues.find((i) => i.section === 'education' && i.key === 'school' && i.errorKey === 'validation.required')).toBeTruthy();
    expect(issues.find((i) => i.section === 'experience' && i.key === 'company' && i.errorKey === 'validation.required')).toBeTruthy();
    expect(issues.find((i) => i.section === 'internship' && i.key === 'company' && i.errorKey === 'validation.required')).toBeTruthy();
    expect(issues.find((i) => i.section === 'projects' && i.key === 'name' && i.errorKey === 'validation.required')).toBeTruthy();
  });

  test('project link with bad URL surfaces url_format', () => {
    const r = JSON.parse(JSON.stringify(blank));
    r.basic.name = 'x'; r.basic.email = 'a@b.co'; r.basic.phone = '13800001234';
    r.projects = [{ name: 'My Project', link: 'not a url' }];
    const issues = V.validateResume(r);
    expect(issues.find((i) => i.section === 'projects' && i.key === 'link').errorKey).toBe('validation.url_format');
  });
});
