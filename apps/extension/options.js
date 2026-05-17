const I18N = window.ResumeFillerI18n;
const V = window.ResumeFillerValidators;
const PROFILES = window.ResumeFillerProfiles;
let state = window.emptyResume();

// In-memory copy of the multi-profile store. `state` (above) always points
// at the currently-active profile's data. Saving persists both: state into
// the active profile, then the whole store back to chrome.storage.local
// under `resumes`.
let profileStore = PROFILES.emptyStore();

// Reads `resumes` (the new shape) and migrates the legacy single-resume
// key in place if it's the only thing present. Mirrors popup.js's helper
// — both surfaces need to handle a cold-start with v2.x data.
function loadProfileStore(cb) {
  chrome.storage.local.get(['resumes', 'resume'], ({ resumes, resume }) => {
    if (resumes && resumes.profiles) {
      cb(resumes);
      return;
    }
    if (resume && typeof resume === 'object') {
      const migrated = PROFILES.migrateLegacyResume(resume);
      chrome.storage.local.set({ resumes: migrated }, () => {
        chrome.storage.local.remove('resume', () => cb(migrated));
      });
      return;
    }
    cb(PROFILES.emptyStore());
  });
}

// Mirrors popup.js's serialization: rapid duplicate → rename in the profile
// bar can interleave reads and writes if these calls run as plain async
// fire-and-forget. Chaining on a per-surface Promise queue keeps every
// chrome.storage.local.set ordered.
let _storageWriteChain = Promise.resolve();
function saveProfileStore(store, cb) {
  profileStore = store;
  _storageWriteChain = _storageWriteChain.then(() => new Promise((resolve) => {
    chrome.storage.local.set({ resumes: store }, () => {
      if (cb) cb();
      resolve();
    });
  }));
  return _storageWriteChain;
}

// Refreshes the rename input + delete button enabled-state. Called whenever
// the active profile changes or the store is reloaded. The delete button
// stays disabled when there's only one profile so users can't accidentally
// wipe themselves into the empty-state path.
function renderProfileBar() {
  const input = document.getElementById('profileNameInput');
  const delBtn = document.getElementById('btnProfileDelete');
  const active = PROFILES.getActiveProfile(profileStore);
  if (!input || !delBtn) return;
  input.value = active ? active.name : '';
  const count = Object.keys(profileStore.profiles || {}).length;
  delBtn.disabled = count <= 1;
  delBtn.style.opacity = count <= 1 ? '0.4' : '';
  delBtn.style.cursor = count <= 1 ? 'not-allowed' : '';
}

function commitProfileRename() {
  const input = document.getElementById('profileNameInput');
  if (!input) return;
  const active = PROFILES.getActiveProfile(profileStore);
  if (!active) return;
  const next = PROFILES.renameProfile(profileStore, active.id, input.value);
  if (next === profileStore) {
    // Empty/whitespace name was rejected — restore the input to current name.
    input.value = active.name;
    return;
  }
  saveProfileStore(next, () => {
    renderProfileBar();
    toast(I18N.t('options.profile_renamed'), 'success');
  });
}

function handleProfileDuplicate() {
  const active = PROFILES.getActiveProfile(profileStore);
  if (!active) return;
  // Source keeps its last-saved data untouched. The duplicate is seeded
  // from the source's stored data, then the editor's current edits
  // (including unsaved ones) are written into the duplicate only — this
  // matches the common "I want a copy of what I'm working on" intent
  // without silently committing edits back to the original.
  collectFlatFields();
  const normalized = window.normalizeResume(state);
  let store = PROFILES.duplicateProfile(profileStore, active.id);
  const newId = store.activeProfileId;
  store = PROFILES.updateProfileData(store, newId, normalized);
  saveProfileStore(store, () => {
    const newActive = PROFILES.getActiveProfile(profileStore);
    state = newActive ? window.normalizeResume(newActive.data || window.emptyResume()) : window.emptyResume();
    hydrate();
    renderProfileBar();
    toast(I18N.t('options.profile_duplicated'), 'success');
  });
}

function handleProfileDelete() {
  const active = PROFILES.getActiveProfile(profileStore);
  if (!active) return;
  const count = Object.keys(profileStore.profiles || {}).length;
  if (count <= 1) return;
  if (!confirm(I18N.t('options.profile_delete_confirm', { name: active.name }))) return;
  const store = PROFILES.deleteProfile(profileStore, active.id);
  saveProfileStore(store, () => {
    const newActive = PROFILES.getActiveProfile(profileStore);
    state = newActive ? window.normalizeResume(newActive.data || window.emptyResume()) : window.emptyResume();
    hydrate();
    renderProfileBar();
    toast(I18N.t('options.profile_deleted'), 'success');
  });
}

// Section + field combinations that have format validation. Map (section,
// key) → i18n label key, so the save-time banner can render
// "Basic · Email: invalid email format" with localized strings.
const VALIDATION_FIELD_LABEL_KEYS = {
  basic: {
    name: 'options.basic.name_label',
    email: 'options.basic.email_label',
    phone: 'options.basic.phone_label',
    linkedin: 'options.basic.linkedin_label',
    github: 'options.basic.github_label',
    portfolio: 'options.basic.portfolio_label',
  },
  education: { school: 'options.education.school_label' },
  experience: { company: 'options.experience.company_label' },
  internship: { company: 'options.internship.company_label' },
  projects: { name: 'options.projects.name_label', link: 'options.projects.link_label' },
};
const SECTION_NAME_KEYS = {
  basic: 'popup.section.basic',
  education: 'popup.section.education',
  experience: 'popup.section.experience',
  internship: 'popup.section.internship',
  projects: 'popup.section.projects',
};

// Toggle the per-input inline error state. errorKey === null clears the
// error; otherwise we add the `.invalid` class and insert a sibling
// `.field-error` <span>. The error <span> is reused across calls so
// repeated blur events don't accumulate DOM nodes.
function setInlineError(input, errorKey) {
  const wrap = input.parentElement;
  if (!wrap) return;
  let errEl = wrap.querySelector('.field-error');
  if (!errorKey) {
    input.classList.remove('invalid');
    if (errEl) errEl.remove();
    return;
  }
  input.classList.add('invalid');
  if (!errEl) {
    errEl = document.createElement('span');
    errEl.className = 'field-error';
    wrap.appendChild(errEl);
  }
  errEl.textContent = I18N.t(errorKey);
}

// Wire a blur listener that runs the given pure validator and updates the
// inline error state. Validators return null on success or an i18n key
// on failure (matching the contract in lib/validators.js).
function attachBlurValidator(input, validator) {
  input.addEventListener('blur', () => {
    setInlineError(input, validator(input.value.trim()));
  });
}

// Render the save-time top banner from validateResume's issue list. Empty
// list hides the banner; non-empty list shows a count plus a per-issue
// bullet so the user knows what to fix.
function renderValidationBanner(issues) {
  const banner = document.getElementById('validationBanner');
  if (!banner) return;
  if (!issues || issues.length === 0) {
    banner.classList.remove('show');
    banner.innerHTML = '';
    return;
  }
  const title = document.createElement('div');
  title.className = 'validation-banner-title';
  title.textContent = I18N.t('validation.banner_title', { count: issues.length });
  const list = document.createElement('ul');
  issues.forEach((issue) => {
    const li = document.createElement('li');
    const sectionName = I18N.t(SECTION_NAME_KEYS[issue.section] || ('popup.section.' + issue.section));
    const fieldKeyMap = VALIDATION_FIELD_LABEL_KEYS[issue.section] || {};
    const fieldLabel = fieldKeyMap[issue.key] ? I18N.t(fieldKeyMap[issue.key]) : issue.key;
    const idxLabel = issue.idx != null ? ' #' + (issue.idx + 1) : '';
    li.textContent = sectionName + idxLabel + ' · ' + fieldLabel + ' — ' + I18N.t(issue.errorKey);
    list.appendChild(li);
  });
  banner.innerHTML = '';
  banner.appendChild(title);
  banner.appendChild(list);
  banner.classList.add('show');
}

function renderCustomFields(cf) {
  // 清空所有 data-custom-for 容器
  document.querySelectorAll('[data-custom-for]').forEach(el => { el.innerHTML = ''; });

  // 隐藏"其他"独立 section（有内容时再显示）
  const otherSection = document.getElementById('section-other');
  if (otherSection) otherSection.style.display = 'none';

  if (!cf || typeof cf !== 'object') return;

  Object.entries(cf).forEach(([sectionKey, fields]) => {
    if (!fields || typeof fields !== 'object') return;
    const entries = Object.entries(fields);
    if (entries.length === 0) return;

    const container = document.querySelector(`[data-custom-for="${sectionKey}"]`);
    if (!container) return;

    // 分隔标题
    const header = document.createElement('div');
    header.className = 'cf-sub-label';
    header.textContent = I18N.t('options.custom_sub_label');
    container.appendChild(header);

    entries.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'custom-field-row';

      const delBtn = document.createElement('button');
      delBtn.className = 'mini-btn danger';
      delBtn.type = 'button';
      delBtn.textContent = I18N.t('common.delete');
      delBtn.addEventListener('click', () => deleteCustomField(sectionKey, label));

      // eslint-disable-next-line no-unsanitized/property -- label/value escaped via escapeHtml
      row.innerHTML = `
        <span class="cf-label">${escapeHtml(label)}</span>
        <span class="cf-value">${escapeHtml(value)}</span>
      `;
      row.appendChild(delBtn);
      container.appendChild(row);
    });

    // 如果是 other，显示该独立 section
    if (sectionKey === 'other' && otherSection) {
      otherSection.style.display = '';
    }
  });
}

function deleteCustomField(sectionKey, label) {
  if (!confirm(I18N.t('common.confirm_delete'))) return;
  chrome.storage.local.get('customFields', ({ customFields }) => {
    const cf = customFields || {};
    if (cf[sectionKey]) {
      delete cf[sectionKey][label];
      if (Object.keys(cf[sectionKey]).length === 0) delete cf[sectionKey];
    }
    chrome.storage.local.set({ customFields: cf }, () => {
      renderCustomFields(cf);
    });
  });
}

const SECTION_FIELDS = {
  education: [
    { key: 'school', labelKey: 'options.education.school_label', placeholderKey: 'options.education.school_placeholder', col: 2 },
    { key: 'location', labelKey: 'options.education.location_label', placeholderKey: 'options.education.location_placeholder' },
    { key: 'degree', labelKey: 'options.education.degree_label', placeholderKey: 'options.education.degree_placeholder' },
    { key: 'major', labelKey: 'options.education.major_label', placeholderKey: 'options.education.major_placeholder' },
    { key: 'gpa', labelKey: 'options.education.gpa_label', placeholderKey: 'options.education.gpa_placeholder' },
    { key: 'start_date', labelKey: 'options.education.start_label', placeholderKey: 'options.education.start_placeholder' },
    { key: 'end_date', labelKey: 'options.education.end_label', placeholderKey: 'options.education.end_placeholder' },
    { key: 'description', labelKey: 'options.education.desc_label', type: 'textarea', col: 2 }
  ],
  experience: [
    { key: 'company', labelKey: 'options.experience.company_label', placeholderKey: 'options.experience.company_placeholder', col: 2 },
    { key: 'title', labelKey: 'options.experience.title_label', placeholderKey: 'options.experience.title_placeholder' },
    { key: 'location', labelKey: 'options.experience.location_label', placeholderKey: 'options.experience.location_placeholder' },
    { key: 'start_date', labelKey: 'options.experience.start_label', placeholderKey: 'options.experience.start_placeholder' },
    { key: 'end_date', labelKey: 'options.experience.end_label', placeholderKey: 'options.experience.end_placeholder' },
    { key: 'description', labelKey: 'options.experience.desc_label', type: 'textarea', col: 2 }
  ],
  internship: [
    { key: 'company', labelKey: 'options.internship.company_label', placeholderKey: 'options.internship.company_placeholder', col: 2 },
    { key: 'title', labelKey: 'options.internship.title_label', placeholderKey: 'options.internship.title_placeholder' },
    { key: 'location', labelKey: 'options.internship.location_label', placeholderKey: 'options.internship.location_placeholder' },
    { key: 'start_date', labelKey: 'options.internship.start_label', placeholderKey: 'options.internship.start_placeholder' },
    { key: 'end_date', labelKey: 'options.internship.end_label', placeholderKey: 'options.internship.end_placeholder' },
    { key: 'description', labelKey: 'options.internship.desc_label', type: 'textarea', col: 2 }
  ],
  projects: [
    { key: 'name', labelKey: 'options.projects.name_label', placeholderKey: 'options.projects.name_placeholder', col: 2 },
    { key: 'role', labelKey: 'options.projects.role_label', placeholderKey: 'options.projects.role_placeholder' },
    { key: 'link', labelKey: 'options.projects.link_label', placeholderKey: 'options.projects.link_placeholder' },
    { key: 'start_date', labelKey: 'options.projects.start_label', placeholderKey: 'options.projects.start_placeholder' },
    { key: 'end_date', labelKey: 'options.projects.end_label', placeholderKey: 'options.projects.end_placeholder' },
    { key: 'description', labelKey: 'options.projects.desc_label', type: 'textarea', col: 2 }
  ]
};

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => (acc[key] = acc[key] || {}), obj);
  target[last] = value;
}

function toast(text, type) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { el.className = 'toast'; }, 1800);
}

function labelForSection(section) {
  if (section === 'education') return I18N.t('common.card_default_education');
  if (section === 'experience') return I18N.t('common.card_default_experience');
  if (section === 'internship') return I18N.t('common.card_default_internship');
  return I18N.t('common.card_default_project');
}

function renderArraySection(section) {
  const container = document.querySelector(`[data-list="${section}"]`);
  container.innerHTML = '';

  const items = state[section] || [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color: #8d96ab; font-size: 12px; padding: 10px 2px;';
    empty.textContent = I18N.t('common.empty_list');
    container.appendChild(empty);
    return;
  }

  items.forEach((item, idx) => {
    container.appendChild(buildArrayCard(section, idx));
  });
}

function buildArrayCard(section, idx) {
  const item = state[section][idx];
  const fields = SECTION_FIELDS[section];
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.section = section;
  card.dataset.idx = idx;

  const titleText = (() => {
    if (section === 'education') return item.school || labelForSection(section);
    if (section === 'experience') return item.company || labelForSection(section);
    return item.name || labelForSection(section);
  })();

  const head = document.createElement('div');
  head.className = 'card-head';
  // eslint-disable-next-line no-unsanitized/property -- titleText and i18n string escaped via escapeHtml
  head.innerHTML = `
    <div class="card-title">
      #${idx + 1} · ${escapeHtml(titleText)}
      ${idx === 0 ? `<span class="muted">${escapeHtml(I18N.t('common.priority_note'))}</span>` : ''}
    </div>
  `;

  const controls = document.createElement('div');
  controls.className = 'card-actions';

  if (idx > 0) {
    const up = document.createElement('button');
    up.className = 'mini-btn';
    up.type = 'button';
    up.textContent = I18N.t('common.move_up');
    up.addEventListener('click', () => moveItem(section, idx, -1));
    controls.appendChild(up);
  }

  if (idx < state[section].length - 1) {
    const down = document.createElement('button');
    down.className = 'mini-btn';
    down.type = 'button';
    down.textContent = I18N.t('common.move_down');
    down.addEventListener('click', () => moveItem(section, idx, 1));
    controls.appendChild(down);
  }

  const del = document.createElement('button');
  del.className = 'mini-btn danger';
  del.type = 'button';
  del.textContent = I18N.t('common.delete');
  del.addEventListener('click', () => {
    if (!confirm(I18N.t('common.confirm_delete'))) return;
    state[section].splice(idx, 1);
    renderArraySection(section);
  });
  controls.appendChild(del);
  head.appendChild(controls);
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'grid';
  let endDateInput = null;

  fields.forEach((field) => {
    const wrap = document.createElement('div');
    wrap.className = 'field' + (field.col === 2 ? ' full' : '');
    // eslint-disable-next-line no-unsanitized/property -- i18n string escaped via escapeHtml
    wrap.innerHTML = `<label>${escapeHtml(I18N.t(field.labelKey))}</label>`;
    const input = document.createElement(field.type === 'textarea' ? 'textarea' : 'input');
    input.placeholder = field.placeholderKey ? I18N.t(field.placeholderKey) : '';
    input.value = item[field.key] != null ? item[field.key] : '';
    if (field.key === 'end_date') endDateInput = input;

    input.addEventListener('input', (event) => {
      state[section][idx][field.key] = event.target.value;
      if (['school', 'company', 'name'].includes(field.key)) {
        const cardTitle = card.querySelector('.card-title');
        const display = state[section][idx][field.key] || labelForSection(section);
        const note = idx === 0 ? ` <span class="muted">${escapeHtml(I18N.t('common.priority_note'))}</span>` : '';
        // eslint-disable-next-line no-unsanitized/property -- display and note escaped via escapeHtml
        cardTitle.innerHTML = `#${idx + 1} · ${escapeHtml(display)}${note}`;
      }
    });

    wrap.appendChild(input);
    if (section === 'projects' && field.key === 'link') {
      attachBlurValidator(input, V.validateUrl);
    }
    grid.appendChild(wrap);
  });

  if (section === 'experience' || section === 'internship') {
    const row = document.createElement('div');
    row.className = 'field full';
    // eslint-disable-next-line no-unsanitized/property -- section/idx are internal identifiers, i18n escaped via escapeHtml
    row.innerHTML = `
      <div class="checkbox-row">
        <input type="checkbox" id="cur-${section}-${idx}" ${item.current ? 'checked' : ''}>
        <label for="cur-${section}-${idx}" style="text-transform:none; letter-spacing:0; color:inherit; margin:0;">${escapeHtml(I18N.t('common.current_job'))}</label>
      </div>
    `;
    row.querySelector('input').addEventListener('change', (event) => {
      state[section][idx].current = event.target.checked;
      if (event.target.checked) {
        state[section][idx].end_date = '';
        if (endDateInput) endDateInput.value = '';
      }
    });
    grid.appendChild(row);
  }

  card.appendChild(grid);
  return card;
}

function moveItem(section, idx, dir) {
  const arr = state[section];
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  renderArraySection(section);
}

function renderTags(listName, editorId, inputId) {
  const editor = document.getElementById(editorId);
  const input = document.getElementById(inputId);
  editor.querySelectorAll('.tag').forEach((tag) => tag.remove());

  (state[listName] || []).forEach((value, index) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = value;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state[listName].splice(index, 1);
      renderTags(listName, editorId, inputId);
    });

    tag.appendChild(remove);
    editor.insertBefore(tag, input);
  });
}

function bindTagInput(listName, editorId, inputId) {
  const input = document.getElementById(inputId);

  function commit() {
    const parts = input.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) return;
    state[listName] = (state[listName] || []).concat(parts);
    input.value = '';
    renderTags(listName, editorId, inputId);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && input.value === '' && (state[listName] || []).length) {
      state[listName].pop();
      renderTags(listName, editorId, inputId);
    }
  });

  input.addEventListener('blur', commit);
  document.getElementById(editorId).addEventListener('click', () => input.focus());
}

function hydrate() {
  document.title = I18N.t('options.document_title');
  I18N.applyText();

  document.querySelectorAll('[data-path]').forEach((el) => {
    el.value = getPath(state, el.dataset.path) || '';
    // Refresh any pre-existing inline error message so it picks up the new
    // language. The validator itself is path-keyed and language-agnostic.
    if (el.classList.contains('invalid')) {
      const validator = V.validatorForPath(el.dataset.path);
      if (validator) setInlineError(el, validator(el.value.trim()));
    }
  });

  renderArraySection('education');
  renderArraySection('experience');
  renderArraySection('internship');
  renderArraySection('projects');
  renderTags('skills', 'skills-editor', 'skills-input');
  renderTags('languages', 'languages-editor', 'languages-input');
}

// Attach blur validators to the static [data-path] inputs once at startup.
// Static elements aren't rebuilt by hydrate() (only their values are
// reset), so a single attach is enough — no need for an "already attached"
// guard.
function initStaticFieldValidation() {
  document.querySelectorAll('[data-path]').forEach((el) => {
    const validator = V.validatorForPath(el.dataset.path);
    if (validator) attachBlurValidator(el, validator);
  });
}

function collectFlatFields() {
  document.querySelectorAll('[data-path]').forEach((el) => {
    setPath(state, el.dataset.path, el.value.trim());
  });
}

function save() {
  collectFlatFields();
  const resume = window.normalizeResume(state);
  state = resume;

  // Persist into the active profile inside the multi-resume store. If no
  // profile exists yet (e.g. first ever open of the options page with no
  // legacy resume), create one named from intent.apply_position.
  const active = PROFILES.getActiveProfile(profileStore);
  let nextStore;
  if (active) {
    nextStore = PROFILES.updateProfileData(profileStore, active.id, resume);
  } else {
    const inferred = PROFILES.inferProfileName(resume);
    nextStore = PROFILES.createProfile(profileStore, inferred || '', resume);
  }

  // Non-blocking: persist first, then surface issues. Users can save a
  // draft with format errors (acceptance criterion in #11).
  saveProfileStore(nextStore, () => {
    const btn = document.getElementById('btn-save');
    const defaultText = I18N.t('options.btn_save');
    btn.textContent = I18N.t('options.saved');
    btn.classList.add('saved');
    setTimeout(() => {
      btn.textContent = defaultText;
      btn.classList.remove('saved');
    }, 1600);
    renderProfileBar();
    const issues = V.validateResume(resume);
    renderValidationBanner(issues);
    if (issues.length === 0) {
      toast(I18N.t('options.toast_saved'), 'success');
    } else {
      toast(I18N.t('validation.banner_title', { count: issues.length }), 'warn');
    }
  });
}

function exportJson() {
  collectFlatFields();
  const resume = window.normalizeResume(state);
  const text = JSON.stringify(resume, null, 2);

  navigator.clipboard.writeText(text).then(() => {
    toast(I18N.t('options.toast_exported'), 'success');
  }, () => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'resume.json';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function openImport() {
  document.getElementById('importText').value = '';
  document.getElementById('importErr').textContent = '';
  // Reset the "import as new" toggle so reopening the modal always
  // starts from the safe default (replace current). Users tick it
  // intentionally for each multi-resume add.
  const asNewBox = document.getElementById('importAsNew');
  if (asNewBox) {
    asNewBox.checked = false;
    syncImportOkLabel();
  }
  document.getElementById('importModal').classList.add('open');
  setTimeout(() => document.getElementById('importText').focus(), 40);
}

// Reflects the checkbox state on the import button label so the user
// reads "Import & overwrite" or "Import as new" depending on intent.
function syncImportOkLabel() {
  const btn = document.getElementById('importOk');
  const box = document.getElementById('importAsNew');
  if (!btn || !box) return;
  btn.textContent = I18N.t(box.checked ? 'options.import_modal_ok_new' : 'options.import_modal_ok');
}

function closeImport() {
  document.getElementById('importModal').classList.remove('open');
}

function doImport() {
  const raw = document.getElementById('importText').value.trim();
  const errorNode = document.getElementById('importErr');

  if (!raw) {
    errorNode.textContent = I18N.t('options.import_empty');
    return;
  }

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (error) {
    errorNode.textContent = I18N.t('options.import_error', { message: error.message });
    return;
  }

  const normalized = window.normalizeResume(parsed);
  state = normalized;

  // "Import as new" creates a fresh profile, switches active to it, and
  // persists immediately so the new profile is visible in the popup
  // dropdown without requiring a Save click. The editor is re-hydrated
  // from the new active profile (which holds the just-parsed data).
  const asNewBox = document.getElementById('importAsNew');
  if (asNewBox && asNewBox.checked) {
    const inferred = PROFILES.inferProfileName(normalized);
    let store = PROFILES.createProfile(profileStore, inferred || '', normalized);
    // createProfile preserves an already-valid active id; re-anchor to
    // the newly-created profile so subsequent saves target it.
    const newId = Object.keys(store.profiles).find((id) => !profileStore.profiles[id]);
    if (newId) store = PROFILES.setActiveProfile(store, newId);
    saveProfileStore(store, () => {
      hydrate();
      renderProfileBar();
      closeImport();
      toast(I18N.t('options.toast_imported'), 'success');
    });
    return;
  }

  hydrate();
  closeImport();
  toast(I18N.t('options.toast_imported'), 'success');
}

document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const section = btn.dataset.add;
    state[section] = state[section] || [];
    state[section].push(window.blankEntry(section));
    renderArraySection(section);
    const container = document.querySelector(`[data-list="${section}"]`);
    container.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

document.getElementById('btn-save').addEventListener('click', save);
document.getElementById('btn-export').addEventListener('click', exportJson);
document.getElementById('btn-import').addEventListener('click', openImport);
document.getElementById('importCancel').addEventListener('click', closeImport);
document.getElementById('importOk').addEventListener('click', doImport);
document.getElementById('importAsNew').addEventListener('change', syncImportOkLabel);
document.getElementById('importModal').addEventListener('click', (event) => {
  if (event.target.id === 'importModal') closeImport();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    save();
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset && el.dataset.path) {
    setPath(state, el.dataset.path, el.value);
  }
});

window.addEventListener('resumefiller:languagechange', () => {
  hydrate();
  const saveBtn = document.getElementById('btn-save');
  if (!saveBtn.classList.contains('saved')) {
    saveBtn.textContent = I18N.t('options.btn_save');
  }
  // Re-render banner contents in the new language if a previous save left
  // it visible. Re-running validateResume keeps the displayed issues in
  // sync with the current state too.
  const banner = document.getElementById('validationBanner');
  if (banner && banner.classList.contains('show')) {
    renderValidationBanner(V.validateResume(state));
  }
  chrome.storage.local.get('customFields', ({ customFields }) => {
    renderCustomFields(customFields || {});
  });
});

bindTagInput('skills', 'skills-editor', 'skills-input');
bindTagInput('languages', 'languages-editor', 'languages-input');

I18N.init().then(() => {
  loadProfileStore((store) => {
    profileStore = store;
    const active = PROFILES.getActiveProfile(store);
    state = active && active.data ? window.normalizeResume(active.data) : window.emptyResume();
    hydrate();
    initStaticFieldValidation();
    renderProfileBar();
    chrome.storage.local.get('customFields', ({ customFields }) => {
      renderCustomFields(customFields || {});
    });
  });
  initAiSettings();
});

document.getElementById('btnProfileDuplicate').addEventListener('click', handleProfileDuplicate);
document.getElementById('btnProfileDelete').addEventListener('click', handleProfileDelete);
document.getElementById('profileNameInput').addEventListener('blur', commitProfileRename);
document.getElementById('profileNameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  }
});

// ─── AI settings (issue #8) ─────────────────────────────────────────────
const LP = window.ResumeFillerLLMProviders;

function initAiSettings() {
  if (!LP) return;
  const sel = document.getElementById('ai-provider');
  if (!sel) return;
  sel.innerHTML = '';
  LP.listProviders().forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  loadAiSettings();
  sel.addEventListener('change', () => updateAiPlaceholders());
  document.getElementById('ai-show-key').addEventListener('click', toggleKeyVisibility);
  document.getElementById('ai-test-btn').addEventListener('click', testAiKey);
  document.getElementById('ai-save-btn').addEventListener('click', saveAiSettings);
}

function loadAiSettings() {
  chrome.storage.local.get('aiSettings', ({ aiSettings }) => {
    const settings = aiSettings || LP.defaultSettings();
    document.getElementById('ai-enabled').checked = !!settings.enabled;
    document.getElementById('ai-provider').value = settings.provider || 'openai';
    document.getElementById('ai-endpoint').value = settings.endpoint || '';
    document.getElementById('ai-model').value = settings.model || '';
    document.getElementById('ai-api-key').value = LP.decodeKey(settings.apiKey || '');
    updateAiPlaceholders();
  });
}

function updateAiPlaceholders() {
  const provider = LP.getProvider(document.getElementById('ai-provider').value);
  if (!provider) return;
  document.getElementById('ai-endpoint').placeholder =
    provider.defaultEndpoint || I18N.t('options.ai.endpoint_placeholder');
  document.getElementById('ai-model').placeholder =
    provider.defaultModel || I18N.t('options.ai.model_placeholder');
}

function toggleKeyVisibility() {
  const input = document.getElementById('ai-api-key');
  const btn = document.getElementById('ai-show-key');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = I18N.t('options.ai.hide_key');
  } else {
    input.type = 'password';
    btn.textContent = I18N.t('options.ai.show_key');
  }
}

function readAiFormSettings() {
  return {
    enabled: document.getElementById('ai-enabled').checked,
    provider: document.getElementById('ai-provider').value,
    endpoint: document.getElementById('ai-endpoint').value.trim(),
    model: document.getElementById('ai-model').value.trim(),
    apiKey: LP.encodeKey(document.getElementById('ai-api-key').value),
  };
}

function saveAiSettings() {
  const settings = readAiFormSettings();
  chrome.storage.local.set({ aiSettings: settings }, () => {
    setAiStatus(I18N.t('options.ai.saved'), 'success');
  });
}

function setAiStatus(text, kind) {
  const el = document.getElementById('ai-test-status');
  el.textContent = text;
  el.style.color = kind === 'success' ? '#3b8a5d' : kind === 'error' ? '#b54141' : '#7d8194';
}

async function testAiKey() {
  setAiStatus(I18N.t('options.ai.testing'), 'info');
  const settings = readAiFormSettings();
  const reasons = LP.validateSettings(settings);
  if (reasons.length > 0) {
    setAiStatus(I18N.t('options.ai.test_invalid', { reason: reasons.join(', ') }), 'error');
    return;
  }
  let req;
  try {
    req = LP.buildTestRequest(settings);
  } catch (err) {
    setAiStatus(I18N.t('options.ai.test_invalid', { reason: err.message }), 'error');
    return;
  }
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (res.ok || res.status === 400) {
      // 400 from a "ping" body is acceptable: we only care that the API
      // accepted the auth header (a 401 would mean bad key).
      setAiStatus(I18N.t('options.ai.test_ok'), 'success');
    } else if (res.status === 401 || res.status === 403) {
      setAiStatus(I18N.t('options.ai.test_unauth'), 'error');
    } else {
      setAiStatus(I18N.t('options.ai.test_failed', { status: res.status }), 'error');
    }
  } catch (err) {
    setAiStatus(I18N.t('options.ai.test_network', { message: err.message }), 'error');
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
