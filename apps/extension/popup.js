const I18N = window.ResumeFillerI18n;
const LC = window.ResumeFillerLabelClassifier;
const PROFILES = window.ResumeFillerProfiles;

// Cached after the most recent fill so the AI takeover button can re-issue
// the same fill with aiTakeover: true (no new user click needed).
let lastFillManual = [];

// In-memory cache of the multi-profile store. Refreshed on load and after
// every save; the dropdown + summary card read from this. The source of
// truth still lives in chrome.storage.local under the `resumes` key.
let profileStore = PROFILES.emptyStore();

// Tracks how the next step-2 paste should be applied: 'replace' updates
// the active profile's data (re-pasting a corrected JSON for the same
// resume), 'new' creates a fresh profile and switches active to it
// (uploading a second resume variant). The two footer links each set
// this before showing step 2, so the paste handler doesn't have to
// inspect button-specific state.
let importIntent = 'replace';

// Reads `resumes` (the new shape) and, if absent, migrates the legacy
// single-resume key in-place. The callback receives the store; second arg
// `didMigrate` lets the caller know it can clean up old state.
function loadProfileStore(cb) {
  chrome.storage.local.get(['resumes', 'resume'], ({ resumes, resume }) => {
    if (resumes && resumes.profiles) {
      cb(resumes, false);
      return;
    }
    if (resume && typeof resume === 'object') {
      const migrated = PROFILES.migrateLegacyResume(resume);
      chrome.storage.local.set({ resumes: migrated }, () => {
        chrome.storage.local.remove('resume', () => cb(migrated, true));
      });
      return;
    }
    cb(PROFILES.emptyStore(), false);
  });
}

function saveProfileStore(store, cb) {
  profileStore = store;
  // Routes through the same Promise chain as customFields/labelMappings so
  // a rapid duplicate → rename sequence can't interleave reads and writes
  // (each write awaits the previous one to land).
  _storageWriteChain = _storageWriteChain.then(() => new Promise((resolve) => {
    chrome.storage.local.set({ resumes: store }, () => {
      if (cb) cb();
      resolve();
    });
  }));
  return _storageWriteChain;
}

function getActiveResume() {
  const active = PROFILES.getActiveProfile(profileStore);
  return active ? active.data : null;
}

// ─── 未匹配字段 → 板块映射（新增，不覆盖现有内容）────────────────────────────

// Section dropdown options: keys are stable storage IDs, labels flow through
// i18n so the dropdown switches with uiLang. Resolved at render time, not
// module load, because I18N may not have loaded its dictionaries yet here.
function getResumeSectionOptions() {
  return [
    { key: 'basic', label: I18N.t('popup.section.basic') },
    { key: 'intent', label: I18N.t('popup.section.intent') },
    { key: 'education', label: I18N.t('popup.section.education') },
    { key: 'experience', label: I18N.t('popup.section.experience') },
    { key: 'internship', label: I18N.t('popup.section.internship') },
    { key: 'projects', label: I18N.t('popup.section.projects') },
    { key: 'skills', label: I18N.t('popup.section.skills') },
    { key: 'languages', label: I18N.t('popup.section.languages') },
    { key: 'other', label: I18N.t('popup.section.other') },
  ];
}

// Serializes chrome.storage.local read-modify-write so two rapid clicks on
// adjacent unmatched cards can't drop a write (the second get would otherwise
// race the first set). All mutating writes from popup.js go through this.
let _storageWriteChain = Promise.resolve();
function mutateStorage(key, mutator) {
  _storageWriteChain = _storageWriteChain.then(() => new Promise((resolve) => {
    chrome.storage.local.get(key, (current) => {
      const next = mutator(current[key]);
      chrome.storage.local.set({ [key]: next }, resolve);
    });
  }));
  return _storageWriteChain;
}

// 把字段标签+值保存到 customFields（独立于 resume，不覆盖任何已有内容）
function saveCustomField(section, fieldLabel, value, btn, cardEl) {
  mutateStorage('customFields', (cf) => {
    const out = cf || {};
    if (!out[section]) out[section] = {};
    out[section][fieldLabel] = value;
    return out;
  }).then(() => {
    btn.textContent = I18N.t('popup.unmatched_saved');
    btn.classList.add('saved');
    // 短暂显示成功状态后，让卡片消失
    setTimeout(() => {
      if (!cardEl) return;
      cardEl.style.transition = 'opacity 0.24s ease, transform 0.24s ease';
      cardEl.style.opacity = '0';
      cardEl.style.transform = 'scale(0.95)';
      setTimeout(() => {
        cardEl.style.overflow = 'hidden';
        cardEl.style.transition = 'max-height 0.26s ease, margin-top 0.26s ease, padding 0.26s ease';
        cardEl.style.maxHeight = cardEl.offsetHeight + 'px';
        requestAnimationFrame(() => {
          cardEl.style.maxHeight = '0';
          cardEl.style.marginTop = '0';
          cardEl.style.paddingTop = '0';
          cardEl.style.paddingBottom = '0';
        });
        setTimeout(() => cardEl.remove(), 280);
      }, 240);
    }, 700);
  });
}

function buildUnmatchedItem(item) {
  const div = document.createElement('div');
  div.className = 'manual-item unmatched';

  const top = document.createElement('div');
  top.className = 'unmatched-top';
  // eslint-disable-next-line no-unsanitized/property -- hint and label escaped via escapeHtml
  top.innerHTML = `
    <span class="field-tag tag-other">${escapeHtml(translateManualHint(item.hint))}</span>
    <div class="field-info"><div class="field-label">${escapeHtml(item.label)}</div></div>
  `;
  div.appendChild(top);

  // Form: input + section dropdown + Save Value button.
  const form = document.createElement('div');
  form.className = 'unmatched-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'unmatched-input';
  input.placeholder = I18N.t('popup.unmatched_placeholder');

  const select = document.createElement('select');
  select.className = 'unmatched-select';
  getResumeSectionOptions().forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.key;
    option.textContent = opt.label;
    select.appendChild(option);
  });
  // Pre-select the inferred section so users only need to retarget
  // when the heuristic guesses wrong.
  const inferred = LC.inferSection(item.label);
  if (inferred && Array.from(select.options).some((o) => o.value === inferred)) {
    select.value = inferred;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'save-field-btn';
  btn.textContent = I18N.t('popup.unmatched_save');

  btn.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) return;
    saveCustomField(select.value, item.label, value, btn, div);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });

  form.appendChild(input);
  form.appendChild(select);
  form.appendChild(btn);
  div.appendChild(form);

  // Action row: Skip | Map to resume field
  const actions = document.createElement('div');
  actions.className = 'unmatched-actions';

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'action-link danger';
  skipBtn.textContent = I18N.t('popup.unmatched_skip');
  skipBtn.addEventListener('click', () => collapseAndRemove(div));

  const mapWrap = document.createElement('span');
  mapWrap.style.display = 'inline-flex';
  mapWrap.style.gap = '6px';
  mapWrap.style.alignItems = 'center';
  mapWrap.style.marginLeft = 'auto';

  const mapHint = document.createElement('span');
  mapHint.style.fontSize = '11px';
  mapHint.style.color = '#7a8093';
  mapHint.textContent = I18N.t('popup.unmatched_map_label');

  const mapSelect = document.createElement('select');
  mapSelect.className = 'unmatched-select';
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = I18N.t('popup.unmatched_map_choose');
  mapSelect.appendChild(placeholderOpt);
  LC.RESUME_KEY_OPTIONS.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.key;
    option.textContent = (I18N.getLanguage() === 'en' ? opt.labelEn : opt.labelZh) +
      '  (' + opt.key + ')';
    mapSelect.appendChild(option);
  });
  mapSelect.addEventListener('change', () => {
    const target = mapSelect.value;
    if (!target) return;
    saveLabelMapping(item.label, target, () => collapseAndRemove(div));
  });

  mapWrap.appendChild(mapHint);
  mapWrap.appendChild(mapSelect);

  actions.appendChild(skipBtn);
  actions.appendChild(mapWrap);
  div.appendChild(actions);

  return div;
}

function saveLabelMapping(label, resumeKey, done) {
  mutateStorage('labelMappings', (lm) => {
    const out = lm || {};
    out[label] = resumeKey;
    return out;
  }).then(() => {
    if (typeof done === 'function') done();
  });
}

function collapseAndRemove(cardEl) {
  if (!cardEl) return;
  cardEl.style.transition = 'opacity 0.18s ease';
  cardEl.style.opacity = '0';
  setTimeout(() => cardEl.remove(), 180);
}

function refreshAiTakeoverBanner() {
  const banner = document.getElementById('aiTakeoverBanner');
  if (!banner) return;
  chrome.storage.local.get('aiSettings', ({ aiSettings }) => {
    const enabled = aiSettings && aiSettings.enabled && aiSettings.apiKey;
    banner.style.display = enabled ? 'flex' : 'none';
  });
}

async function handleAiTakeover() {
  const btn = document.getElementById('aiTakeoverBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = I18N.t('popup.ai_takeover_running');

  const resume = getActiveResume();
  if (!resume) {
    btn.disabled = false;
    btn.textContent = originalText;
    showStatus('warn', I18N.t('popup.status_no_resume'));
    return;
  }
  chrome.storage.local.get('customFields', ({ customFields }) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'fill', resume, customFields: customFields || {}, aiTakeover: true },
        (response) => {
          btn.disabled = false;
          btn.textContent = originalText;
          if (chrome.runtime.lastError || !response) {
            showStatus('warn', I18N.t('popup.status_connect_error'));
            return;
          }
          const { filled, manual } = response;
          const aiCount = (filled || []).filter((s) => typeof s === 'string' && s.startsWith('ai:')).length;
          if (aiCount > 0) {
            showStatus('success', I18N.t('popup.ai_takeover_done', { count: aiCount }));
          } else {
            showStatus('warn', I18N.t('popup.ai_takeover_empty'));
          }
          renderManual(manual || []);
        }
      );
    });
  });
}

const screens = {
  intro: document.getElementById('screen-intro'),
  step1: document.getElementById('screen-step1'),
  step2: document.getElementById('screen-step2'),
  fill: document.getElementById('screen-fill')
};

let step1Ready = false;

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove('active'));
  screens[name].classList.add('active');
}

function buildPrompt(lang) {
  if (lang === 'en') {
    return `You are a resume parsing assistant. Parse the "resume text" below into the following JSON structure, and output JSON only (no explanation, no markdown code block).

Rules:
1. Use empty strings "" or empty arrays [] for anything not found. Do not invent values.
2. Dates must use "YYYY-MM" or "YYYY-MM-DD". If the role is ongoing, leave end_date empty and set current to true.
3. education / experience / projects should be sorted in reverse chronological order (most recent first).
4. skills and languages must be arrays of strings.
5. Split name into firstName / lastName when possible.
6. Escape any double quotes inside string values as \\"; do not use special quotation marks — replace them with plain text.
7. Separate multiple points in description fields with a period; do not use newline characters.
8. Ensure the output passes JSON.parse() without errors — verify syntax before outputting.

Target schema:
${JSON.stringify(window.RESUME_SCHEMA, null, 2)}

(Please also upload your resume PDF and send it together with this prompt.)`;
  }

  return `你是简历解析助手。请把下方"简历原文"解析成以下 JSON 结构，并 **只** 输出 JSON（不要任何解释文字、不要 markdown 代码块）。

规则：
1. 未提取到的字段用空字符串 "" 或空数组 []，不要编造。
2. 日期统一为 "YYYY-MM" 或 "YYYY-MM-DD"；"至今"时 end_date 留空并把 current 设为 true。
3. education / experience / projects 按时间倒序排列（最近的在前）。
4. skills、languages 是字符串数组。
5. name 尽量拆成 firstName / lastName；中文姓名可把姓放 lastName、名放 firstName。
6. 所有字符串值中，如含双引号请转义为 \\"；禁止使用「」『』等特殊引号，一律改为普通文字描述。
7. description 字段内容用句号分隔多个要点，不使用换行符。
8. 不得出现任何会导致 JSON.parse() 失败的字符，输出前请自检确认语法正确。

目标 schema：
${JSON.stringify(window.RESUME_SCHEMA, null, 2)}

（请同时上传你的简历 PDF 文件，将以上内容作为提示词一起发送）`;
}

function setPromptText() {
  document.getElementById('promptBox').textContent = buildPrompt(I18N.getLanguage());
  document.title = I18N.t('popup.document_title');
}

function defaultFillButtonText() {
  return I18N.t('popup.fill_button');
}

function updateStep1State() {
  document.getElementById('step1NextBtn').disabled = !step1Ready;
}

function markStep1Done() {
  step1Ready = true;
  updateStep1State();
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = I18N.t('popup.copy_ok');
    markStep1Done();
    setTimeout(() => { btn.textContent = old; }, 1500);
  });
}

function showStatus(type, text) {
  const bar = document.getElementById('statusBar');
  bar.className = `status-bar ${type}`;
  bar.textContent = text;
}

function renderManual(items) {
  const section = document.getElementById('manualSection');
  const list = document.getElementById('manualList');
  const seen = new Set();
  const unique = items.filter((item) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  lastFillManual = unique;

  if (unique.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';
  refreshAiTakeoverBanner();

  const groups = LC.groupBySection(unique);
  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'manual-group';

    const titleEl = document.createElement('div');
    titleEl.className = 'manual-group-title';
    titleEl.textContent = sectionDisplayName(group.section);
    groupEl.appendChild(titleEl);

    for (const item of group.items) {
      if (item.hint === '未匹配') {
        groupEl.appendChild(buildUnmatchedItem(item));
      } else {
        groupEl.appendChild(buildHintedItem(item));
      }
    }
    list.appendChild(groupEl);
  }
}

function sectionDisplayName(section) {
  const key = 'popup.section.' + section;
  const translated = I18N.t(key);
  // Fall back to the raw section id if the key isn't in the dictionary
  // (lets new sections render without crashing the page).
  return translated && translated !== key ? translated : section;
}

function buildHintedItem(item) {
  const tagClass = {
    '日期': 'tag-date',
    '下拉框': 'tag-select',
    '富文本': 'tag-rich',
  }[item.hint] || 'tag-other';
  const hintText = translateManualHint(item.hint);
  const valueHtml = item.value
    ? `<div class="field-value">${escapeHtml(I18N.t('popup.manual_value', { value: item.value }))}</div>`
    : '';
  const div = document.createElement('div');
  div.className = 'manual-item';
  // eslint-disable-next-line no-unsanitized/property -- tagClass from internal map; hint/label/valueHtml all escaped via escapeHtml
  div.innerHTML = `
    <span class="field-tag ${tagClass}">${escapeHtml(hintText)}</span>
    <div class="field-info">
      <div class="field-label">${escapeHtml(item.label)}</div>
      ${valueHtml}
    </div>
  `;
  return div;
}

function translateManualHint(hint) {
  if (I18N.getLanguage() !== 'en') return hint;
  return {
    '日期': 'Date',
    '下拉框': 'Select',
    '富文本': 'Rich text',
    '未匹配': 'Manual'
  }[hint] || hint;
}

function showFillScreen(resume) {
  const basic = resume.basic || {};
  const intent = resume.intent || {};
  const job = (resume.experience && resume.experience[0]) || {};

  document.getElementById('sumName').textContent =
    basic.name || [basic.firstName, basic.lastName].filter(Boolean).join(' ') || I18N.t('popup.no_name');

  const meta = document.getElementById('sumMeta');
  meta.innerHTML = '';
  const chips = [];
  if (intent.apply_position) chips.push(intent.apply_position);
  else if (job.title) chips.push(job.title);
  if (job.company) chips.push('@ ' + job.company);
  if (intent.years_exp) chips.push(intent.years_exp);
  if (basic.location) chips.push(basic.location);

  chips.forEach((chip) => {
    const node = document.createElement('span');
    node.textContent = chip;
    meta.appendChild(node);
  });

  document.getElementById('fillBtn').textContent = defaultFillButtonText();
  renderProfileStrip();
  showScreen('fill');
}

// Populates the popup-top profile dropdown from the current store. Hidden
// when there's only one profile so the strip doesn't add chrome for the
// single-resume case — the dropdown only earns its keep once the user has
// more than one variant.
function renderProfileStrip() {
  const strip = document.getElementById('profileStrip');
  const select = document.getElementById('profileSelect');
  if (!strip || !select) return;
  const list = PROFILES.listProfiles(profileStore);
  if (list.length <= 1) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = 'flex';
  select.innerHTML = '';
  list.forEach((profile) => {
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = profile.name;
    if (profile.id === profileStore.activeProfileId) opt.selected = true;
    select.appendChild(opt);
  });
}

function handleProfileSwitch(event) {
  const newId = event.target.value;
  if (!newId || newId === profileStore.activeProfileId) return;
  const next = PROFILES.setActiveProfile(profileStore, newId);
  saveProfileStore(next, () => {
    const active = PROFILES.getActiveProfile(profileStore);
    if (active && active.data) showFillScreen(active.data);
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.getElementById('startFlowBtn').addEventListener('click', () => {
  showScreen('step1');
});

document.getElementById('step1BackBtn').addEventListener('click', () => {
  showScreen('intro');
});

document.getElementById('step1NextBtn').addEventListener('click', () => {
  // Onboarding flow defaults to replace semantics. Reset so a stale 'new'
  // intent (left over from a prior aborted "Import new resume" click)
  // can't bleed into this paste.
  importIntent = 'replace';
  showScreen('step2');
});

document.getElementById('step2BackBtn').addEventListener('click', () => {
  showScreen('step1');
});

document.getElementById('fillBackBtn').addEventListener('click', () => {
  // Same reset rationale as step1NextBtn — both are entries to step 2 that
  // bypass the two intent-setting links.
  importIntent = 'replace';
  showScreen('step2');
});

document.getElementById('copyPromptBtn').addEventListener('click', (event) => {
  copy(buildPrompt(I18N.getLanguage()), event.currentTarget);
});

document.getElementById('copySchemaBtn').addEventListener('click', (event) => {
  copy(JSON.stringify(window.RESUME_SCHEMA, null, 2), event.currentTarget);
});

document.getElementById('importBtn').addEventListener('click', () => {
  const raw = document.getElementById('jsonInput').value.trim();
  const hint = document.getElementById('importHint');

  if (!raw) {
    hint.className = 'hint error';
    hint.textContent = I18N.t('popup.import_empty');
    return;
  }

  let data;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    data = JSON.parse(cleaned);
  } catch (error) {
    hint.className = 'hint error';
    hint.textContent = I18N.t('popup.import_error', { message: error.message });
    return;
  }

  const resume = window.normalizeResume(data);
  // Three cases, in order:
  // - 'new' intent: create a new profile and explicitly switch active to
  //   it so subsequent Fill / Save target the just-imported resume.
  // - active profile exists + 'replace' intent: update the active profile's
  //   data in place (common re-paste-corrected-JSON flow).
  // - no active profile: create one (first-time onboarding).
  let nextStore;
  const hasActive = profileStore.activeProfileId && profileStore.profiles[profileStore.activeProfileId];
  if (importIntent === 'new' || !hasActive) {
    const inferred = PROFILES.inferProfileName(resume);
    nextStore = PROFILES.createProfile(profileStore, inferred || '', resume);
    // createProfile preserves an already-valid active id, so we re-anchor
    // here. The new id is whichever key wasn't in the prior store.
    const newId = Object.keys(nextStore.profiles).find((id) => !profileStore.profiles[id]);
    if (newId) nextStore = PROFILES.setActiveProfile(nextStore, newId);
  } else {
    nextStore = PROFILES.updateProfileData(profileStore, profileStore.activeProfileId, resume);
  }
  // Reset intent so the next entry to step 2 (e.g. via re-import link)
  // starts from the safe default.
  importIntent = 'replace';
  saveProfileStore(nextStore, () => {
    hint.className = 'hint ok';
    hint.textContent = I18N.t('popup.import_ok');
    setTimeout(() => {
      showFillScreen(resume);
    }, 450);
  });
});

document.getElementById('openEditor').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL('options.html'));
});

document.getElementById('reimport').addEventListener('click', () => {
  if (!confirm(I18N.t('popup.reimport_confirm'))) return;
  importIntent = 'replace';
  showScreen('step2');
});

document.getElementById('importNew').addEventListener('click', () => {
  importIntent = 'new';
  showScreen('step2');
});

document.getElementById('fillBtn').addEventListener('click', () => {
  const resume = getActiveResume();
  if (!resume || !window.isResumeFilled(resume)) {
    showStatus('warn', I18N.t('popup.status_no_resume'));
    return;
  }

  const btn = document.getElementById('fillBtn');
  btn.disabled = true;
  btn.textContent = I18N.t('popup.fill_loading');

  chrome.storage.local.get('customFields', ({ customFields }) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(tab.id, { action: 'fill', resume, customFields: customFields || {} }, (response) => {
        btn.disabled = false;
        btn.textContent = defaultFillButtonText();

        if (chrome.runtime.lastError || !response) {
          showStatus('warn', I18N.t('popup.status_connect_error'));
          return;
        }

        const { filled, manual } = response;
        if (filled.length > 0) {
          showStatus('success', I18N.t('popup.status_filled', { count: filled.length }));
        } else {
          showStatus('warn', I18N.t('popup.status_no_match'));
        }
        renderManual(manual);
      });
    });
  });
});

document.getElementById('profileSelect').addEventListener('change', handleProfileSwitch);

document.getElementById('aiTakeoverBtn').addEventListener('click', handleAiTakeover);

window.addEventListener('resumefiller:languagechange', () => {
  setPromptText();
  updateStep1State();
  const fillBtn = document.getElementById('fillBtn');
  if (!fillBtn.disabled) {
    fillBtn.textContent = defaultFillButtonText();
  }
  if (lastFillManual.length > 0) renderManual(lastFillManual);
});

I18N.init().then(() => {
  setPromptText();
  updateStep1State();

  loadProfileStore((store) => {
    profileStore = store;
    const active = PROFILES.getActiveProfile(store);
    if (active && active.data && window.isResumeFilled(active.data)) {
      showFillScreen(active.data);
    } else {
      showScreen('intro');
    }
  });
});
