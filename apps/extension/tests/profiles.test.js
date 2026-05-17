require('../lib/profiles.js');
const P = globalThis.ResumeFillerProfiles;

const sampleResume = (overrides = {}) => ({
  basic: { name: 'Esther', email: 'a@b.co', phone: '13800001234' },
  intent: { apply_position: 'Product Manager' },
  education: [],
  experience: [],
  internship: [],
  projects: [],
  skills: [],
  languages: [],
  summary: '',
  ...overrides,
});

describe('emptyStore', () => {
  test('returns store with empty profiles and no active id', () => {
    expect(P.emptyStore()).toEqual({ profiles: {}, activeProfileId: '' });
  });
});

describe('generateProfileId', () => {
  test('produces a p_-prefixed string', () => {
    const id = P.generateProfileId();
    expect(typeof id).toBe('string');
    expect(id.startsWith('p_')).toBe(true);
  });
  test('does not collide across 100 calls', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i += 1) ids.add(P.generateProfileId());
    expect(ids.size).toBe(100);
  });
});

describe('inferProfileName', () => {
  test('returns trimmed apply_position when present', () => {
    expect(P.inferProfileName(sampleResume({ intent: { apply_position: '  PM  ' } }))).toBe('PM');
  });
  test('returns null when intent missing or empty', () => {
    expect(P.inferProfileName(sampleResume({ intent: {} }))).toBeNull();
    expect(P.inferProfileName(sampleResume({ intent: { apply_position: '' } }))).toBeNull();
    expect(P.inferProfileName(sampleResume({ intent: { apply_position: '   ' } }))).toBeNull();
  });
  test('returns null for null / non-object input', () => {
    expect(P.inferProfileName(null)).toBeNull();
    expect(P.inferProfileName(undefined)).toBeNull();
    expect(P.inferProfileName('not an object')).toBeNull();
  });
});

describe('createProfile', () => {
  test('creates a profile with provided name + data + auto id', () => {
    const store = P.createProfile(P.emptyStore(), 'PM 简历', sampleResume());
    const ids = Object.keys(store.profiles);
    expect(ids).toHaveLength(1);
    expect(store.profiles[ids[0]].name).toBe('PM 简历');
    expect(store.profiles[ids[0]].id).toBe(ids[0]);
    expect(store.activeProfileId).toBe(ids[0]);
  });
  test('first profile becomes active automatically', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(store.activeProfileId).toBe(Object.keys(store.profiles)[0]);
  });
  test('second profile preserves existing active', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    const firstId = store.activeProfileId;
    store = P.createProfile(store, 'B', sampleResume());
    expect(store.activeProfileId).toBe(firstId);
    expect(Object.keys(store.profiles)).toHaveLength(2);
  });
  test('empty name falls back to Resume N', () => {
    const store = P.createProfile(P.emptyStore(), '', sampleResume());
    expect(Object.values(store.profiles)[0].name).toBe('Resume 1');
  });
  test('whitespace-only name falls back to Resume N', () => {
    const store = P.createProfile(P.emptyStore(), '   ', sampleResume());
    expect(Object.values(store.profiles)[0].name).toBe('Resume 1');
  });
  test('Resume N counter reflects existing profile count', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.createProfile(store, '', sampleResume());
    const names = Object.values(store.profiles).map((p) => p.name);
    expect(names).toContain('A');
    expect(names).toContain('Resume 2');
  });
});

describe('duplicateProfile', () => {
  test('clones data, generates new id, switches active', () => {
    let store = P.createProfile(P.emptyStore(), 'Original', sampleResume({ basic: { name: 'Esther' } }));
    const origId = store.activeProfileId;
    store = P.duplicateProfile(store, origId, 'Copy');
    const ids = Object.keys(store.profiles);
    expect(ids).toHaveLength(2);
    expect(store.activeProfileId).not.toBe(origId);
    expect(store.profiles[store.activeProfileId].name).toBe('Copy');
  });
  test('default copy name is "<source> (copy)"', () => {
    let store = P.createProfile(P.emptyStore(), 'PM 简历', sampleResume());
    store = P.duplicateProfile(store, store.activeProfileId, '');
    expect(store.profiles[store.activeProfileId].name).toBe('PM 简历 (copy)');
  });
  test('deep-clones the data (mutating copy does not affect original)', () => {
    let store = P.createProfile(P.emptyStore(), 'Original', sampleResume());
    const origId = store.activeProfileId;
    store = P.duplicateProfile(store, origId);
    store.profiles[store.activeProfileId].data.basic.name = 'Changed';
    expect(store.profiles[origId].data.basic.name).toBe('Esther');
  });
  test('returns store unchanged when sourceId missing', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(P.duplicateProfile(store, 'bogus-id')).toBe(store);
  });
});

describe('renameProfile', () => {
  test('updates name in place', () => {
    let store = P.createProfile(P.emptyStore(), 'Old', sampleResume());
    const id = store.activeProfileId;
    store = P.renameProfile(store, id, 'New');
    expect(store.profiles[id].name).toBe('New');
  });
  test('trims whitespace', () => {
    let store = P.createProfile(P.emptyStore(), 'Old', sampleResume());
    store = P.renameProfile(store, store.activeProfileId, '   spaced   ');
    expect(store.profiles[store.activeProfileId].name).toBe('spaced');
  });
  test('ignores empty / whitespace-only names', () => {
    let store = P.createProfile(P.emptyStore(), 'Keep me', sampleResume());
    const id = store.activeProfileId;
    expect(P.renameProfile(store, id, '').profiles[id].name).toBe('Keep me');
    expect(P.renameProfile(store, id, '   ').profiles[id].name).toBe('Keep me');
  });
  test('ignores missing profileId', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(P.renameProfile(store, 'bogus', 'X')).toBe(store);
  });
});

describe('deleteProfile', () => {
  test('removes the profile', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.createProfile(store, 'B', sampleResume());
    const ids = Object.keys(store.profiles);
    store = P.deleteProfile(store, ids[1]);
    expect(Object.keys(store.profiles)).toEqual([ids[0]]);
  });
  test('picks new active when deleting the active profile', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.createProfile(store, 'B', sampleResume());
    const activeId = store.activeProfileId;
    const otherId = Object.keys(store.profiles).find((id) => id !== activeId);
    store = P.deleteProfile(store, activeId);
    expect(store.activeProfileId).toBe(otherId);
  });
  test('clears active when last profile removed', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.deleteProfile(store, store.activeProfileId);
    expect(store.activeProfileId).toBe('');
    expect(Object.keys(store.profiles)).toHaveLength(0);
  });
  test('returns unchanged when profileId missing', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(P.deleteProfile(store, 'bogus')).toBe(store);
  });
});

describe('updateProfileData', () => {
  test('replaces data, preserves name + id', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    const id = store.activeProfileId;
    const newData = sampleResume({ basic: { name: 'NewName' } });
    store = P.updateProfileData(store, id, newData);
    expect(store.profiles[id].data.basic.name).toBe('NewName');
    expect(store.profiles[id].name).toBe('A');
    expect(store.profiles[id].id).toBe(id);
  });
  test('returns unchanged when profileId missing', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(P.updateProfileData(store, 'bogus', sampleResume())).toBe(store);
  });
});

describe('setActiveProfile', () => {
  test('switches active when profileId exists', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.createProfile(store, 'B', sampleResume());
    const target = Object.keys(store.profiles).find((id) => id !== store.activeProfileId);
    store = P.setActiveProfile(store, target);
    expect(store.activeProfileId).toBe(target);
  });
  test('ignores unknown profileId', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    expect(P.setActiveProfile(store, 'bogus')).toBe(store);
  });
});

describe('getActiveProfile', () => {
  test('returns the active profile object', () => {
    const store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    const active = P.getActiveProfile(store);
    expect(active).toBeTruthy();
    expect(active.name).toBe('A');
  });
  test('returns null when no profiles', () => {
    expect(P.getActiveProfile(P.emptyStore())).toBeNull();
  });
});

describe('listProfiles', () => {
  test('returns array of profile objects', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    store = P.createProfile(store, 'B', sampleResume());
    const list = P.listProfiles(store);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name).sort()).toEqual(['A', 'B']);
  });
  test('returns empty array for empty / null store', () => {
    expect(P.listProfiles(P.emptyStore())).toEqual([]);
    expect(P.listProfiles(null)).toEqual([]);
  });
});

describe('migrateLegacyResume', () => {
  test('returns empty store for null / undefined input', () => {
    expect(P.migrateLegacyResume(null)).toEqual(P.emptyStore());
    expect(P.migrateLegacyResume(undefined)).toEqual(P.emptyStore());
  });
  test('wraps a single resume as the sole active profile', () => {
    const resume = sampleResume({ intent: { apply_position: 'Senior PM' } });
    const store = P.migrateLegacyResume(resume);
    expect(Object.keys(store.profiles)).toHaveLength(1);
    expect(store.activeProfileId).toBe(Object.keys(store.profiles)[0]);
    expect(P.getActiveProfile(store).name).toBe('Senior PM');
    expect(P.getActiveProfile(store).data).toEqual(resume);
  });
  test('falls back to "Resume 1" when intent.apply_position missing', () => {
    const resume = sampleResume({ intent: {} });
    const store = P.migrateLegacyResume(resume);
    expect(P.getActiveProfile(store).name).toBe('Resume 1');
  });
  test('uses a deterministic id so concurrent migrations converge', () => {
    // Two surfaces (popup + options) calling migrate independently must
    // produce identical stores so last-write-wins doesn't strand one
    // surface with a profile id the other doesn't know about.
    const resume = sampleResume({ intent: { apply_position: 'PM' } });
    const a = P.migrateLegacyResume(resume);
    const b = P.migrateLegacyResume(resume);
    expect(a).toEqual(b);
    expect(a.activeProfileId).toBe(b.activeProfileId);
  });
});

describe('createProfile orphan-active-id handling', () => {
  test('new profile claims active when current active id has no matching profile', () => {
    // Reproduce the orphan-active state: activeProfileId set but the
    // profile it points at is gone (can happen mid-flight in paste-import
    // paths). createProfile should detect and re-anchor active to itself.
    const orphan = { profiles: {}, activeProfileId: 'p_ghost' };
    const next = P.createProfile(orphan, 'New', sampleResume());
    const newId = Object.keys(next.profiles)[0];
    expect(next.activeProfileId).toBe(newId);
    expect(next.activeProfileId).not.toBe('p_ghost');
  });
  test('preserves active when current active id is valid', () => {
    let store = P.createProfile(P.emptyStore(), 'A', sampleResume());
    const aId = store.activeProfileId;
    store = P.createProfile(store, 'B', sampleResume());
    expect(store.activeProfileId).toBe(aId);
  });
});

describe('immutability', () => {
  test('operations do not mutate the input store', () => {
    let original = P.createProfile(P.emptyStore(), 'A', sampleResume());
    const snapshot = JSON.parse(JSON.stringify(original));
    P.createProfile(original, 'B', sampleResume());
    P.renameProfile(original, original.activeProfileId, 'X');
    P.deleteProfile(original, original.activeProfileId);
    P.setActiveProfile(original, 'bogus');
    expect(original).toEqual(snapshot);
  });
});
