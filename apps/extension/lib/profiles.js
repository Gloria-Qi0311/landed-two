// Multi-resume profile store. Pure functions, no DOM, no chrome.* — loaded
// by popup.html and options.html via <script>, and exercised in unit tests.
//
// Storage shape (new key `resumes` in chrome.storage.local):
//   { profiles: { [id]: { id, name, data: ResumeData } }, activeProfileId: string }
//
// The legacy `resume` key (a single ResumeData) is migrated into this shape
// on first load by migrateLegacyResume(). Migration runs once per user;
// callers should write the new shape and remove the old key afterwards.
//
// Helpers operate immutably (return a new store) so callers can compare
// references / trigger renders without worrying about hidden mutation.

(function (global) {
  function emptyStore() {
    return { profiles: {}, activeProfileId: '' };
  }

  // Profile IDs only need to be unique within a single user's storage. A
  // short random suffix is enough; no need for a crypto-grade ID.
  function generateProfileId() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // Inference for the auto-name when a new profile is created from imported
  // JSON or migrated from the legacy single-resume key. Returns the trimmed
  // apply_position if present, else null (caller chooses a fallback so the
  // module stays UI-string-agnostic).
  function inferProfileName(resumeData) {
    if (!resumeData || typeof resumeData !== 'object') return null;
    const intent = resumeData.intent || {};
    const pos = (intent.apply_position || '').trim();
    return pos || null;
  }

  function listProfiles(store) {
    if (!store || typeof store !== 'object') return [];
    return Object.values(store.profiles || {});
  }

  function getActiveProfile(store) {
    if (!store || !store.activeProfileId) return null;
    return (store.profiles || {})[store.activeProfileId] || null;
  }

  function setActiveProfile(store, profileId) {
    if (!store || !store.profiles || !store.profiles[profileId]) return store;
    return Object.assign({}, store, { activeProfileId: profileId });
  }

  // Adds a new profile. Falls back to "Resume N" (N = profile count + 1) if
  // name is empty. New profile becomes active if no profile was active yet
  // OR if the existing activeProfileId points at a profile that no longer
  // exists (orphan active — observed in paste-import paths where the active
  // id outlives its profile).
  function createProfile(store, name, data) {
    const base = (store && store.profiles) ? store : emptyStore();
    const id = generateProfileId();
    const count = Object.keys(base.profiles).length;
    const trimmed = String(name == null ? '' : name).trim();
    const finalName = trimmed || ('Resume ' + (count + 1));
    const profiles = Object.assign({}, base.profiles, {
      [id]: { id, name: finalName, data: data || null },
    });
    const activeIsValid = base.activeProfileId && base.profiles[base.activeProfileId];
    const activeProfileId = activeIsValid ? base.activeProfileId : id;
    return { profiles, activeProfileId };
  }

  // Deep-clones the source profile's data, creates a new profile under a
  // fresh id, and switches active to the new copy. If newName is empty,
  // falls back to "<source name> (copy)". Returns store unchanged when
  // sourceId is missing.
  function duplicateProfile(store, sourceId, newName) {
    if (!store || !store.profiles) return store;
    const src = store.profiles[sourceId];
    if (!src) return store;
    const id = generateProfileId();
    const dataCopy = src.data ? JSON.parse(JSON.stringify(src.data)) : null;
    const trimmed = String(newName == null ? '' : newName).trim();
    const finalName = trimmed || (src.name + ' (copy)');
    const profiles = Object.assign({}, store.profiles, {
      [id]: { id, name: finalName, data: dataCopy },
    });
    return { profiles, activeProfileId: id };
  }

  // Empty / whitespace-only names are ignored (returns store unchanged) so
  // the UI can't accidentally lose a profile's label.
  function renameProfile(store, profileId, newName) {
    if (!store || !store.profiles || !store.profiles[profileId]) return store;
    const trimmed = String(newName == null ? '' : newName).trim();
    if (!trimmed) return store;
    const src = store.profiles[profileId];
    const profiles = Object.assign({}, store.profiles, {
      [profileId]: Object.assign({}, src, { name: trimmed }),
    });
    return Object.assign({}, store, { profiles });
  }

  // When the active profile is deleted we pick the first remaining profile
  // as the new active. If no profiles remain, activeProfileId is cleared
  // and the caller is expected to render the import wizard rather than
  // the fill screen.
  function deleteProfile(store, profileId) {
    if (!store || !store.profiles || !store.profiles[profileId]) return store;
    const profiles = Object.assign({}, store.profiles);
    delete profiles[profileId];
    let activeProfileId = store.activeProfileId;
    if (activeProfileId === profileId) {
      activeProfileId = Object.keys(profiles)[0] || '';
    }
    return { profiles, activeProfileId };
  }

  // Replaces the data of an existing profile (e.g. user re-imports JSON for
  // the currently-active profile). Returns store unchanged when profileId
  // is missing — callers re-importing into a fresh store should use
  // createProfile instead.
  function updateProfileData(store, profileId, data) {
    if (!store || !store.profiles || !store.profiles[profileId]) return store;
    const src = store.profiles[profileId];
    const profiles = Object.assign({}, store.profiles, {
      [profileId]: Object.assign({}, src, { data }),
    });
    return Object.assign({}, store, { profiles });
  }

  // One-shot migration: takes the legacy single-resume value (ResumeData
  // or null/undefined) and wraps it as the sole profile in a new store.
  // The default name comes from inferProfileName, with a hardcoded
  // "Resume 1" fallback (one-time migration — users can rename freely
  // afterwards via the editor).
  //
  // Uses a deterministic profile id so that if popup and options both
  // trigger migration concurrently, the two writes are identical (random
  // ids would have produced inconsistent stores depending on which write
  // landed last).
  const MIGRATED_PROFILE_ID = 'p_migrated';
  function migrateLegacyResume(legacyResume) {
    if (!legacyResume || typeof legacyResume !== 'object') return emptyStore();
    const name = inferProfileName(legacyResume) || 'Resume 1';
    return {
      profiles: { [MIGRATED_PROFILE_ID]: { id: MIGRATED_PROFILE_ID, name, data: legacyResume } },
      activeProfileId: MIGRATED_PROFILE_ID,
    };
  }

  global.ResumeFillerProfiles = {
    emptyStore,
    generateProfileId,
    inferProfileName,
    listProfiles,
    getActiveProfile,
    setActiveProfile,
    createProfile,
    duplicateProfile,
    renameProfile,
    deleteProfile,
    updateProfileData,
    migrateLegacyResume,
  };
})(typeof window !== 'undefined' ? window : globalThis);
