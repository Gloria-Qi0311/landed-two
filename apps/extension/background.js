// background.js — MV3 service worker.
//
// Responsibilities:
//   1. Open the side panel when the toolbar icon is clicked.
//   2. Maintain a 6-hour 'landed-portal-poll' alarm. When the alarm
//      fires, query every open tab on a known portal host, ask the tab's
//      content script to parse + return any portal events it can detect,
//      then run the result through the snapshot-store. New + changed
//      events land in chrome.storage.local under the
//      `landed:pending-portal-events` key for #35 to push to the Landed API.
//   3. Accept real-time `portal-event` messages from content.js (the
//      auto-parse-on-page-load fast path) and ingest the same way.
//
// MV3 service workers are short-lived: any state held in module scope
// disappears between invocations. All persistence goes through
// chrome.storage.local via the snapshot-store. Alarms survive SW death;
// chrome.runtime.onStartup re-arms on browser restart in case the
// onInstalled handler never ran.

importScripts('lib/snapshot-store.js', 'lib/config.js', 'lib/storage-adapter.js', 'lib/portal-events-push.js', 'lib/portal-sentinels.js', 'lib/bridge-handler.js', 'lib/apply-assist-bridge.js', 'lib/resume-pick.js', 'lib/choice-answers.js')

// Every read-modify-write of the pending-event queue (ingest, Cloud push,
// web-bridge take) runs under this lock so none of them clobbers another —
// e.g. an event ingested mid-push no longer gets cleared unsent.
const withQueueLock = self.LandedBridge.createQueueLock()

const ALARM_NAME = 'landed-portal-poll'
const POLL_PERIOD_MIN = 360  // 6 hours

const PUSH_ALARM = 'landed-portal-push'
const PUSH_PERIOD_MIN = 1    // drain pending queue every minute when signed in
const NATIVE_HOST = 'dev.landed.assist'
let nativeAssistQueue = Promise.resolve()
const ASSIST_SESSION_KEY = 'landed:apply-assist-session'
let assistPort = null
let assistReconnectTimer = null
let assistPublishTimer = null
let assistResumes = []
const IS_SAFARI = self.LandedApplyAssistBridge.isSafariUserAgent(navigator.userAgent)

// chrome.storage.local key for #36's expired-login flow. Centralized in
// lib/portal-sentinels.js since 3+ callers now read/write it (this file,
// the popup banner hook, and #36.1's badge-counter).
const NEEDS_AUTH_KEY = self.LandedPortalSentinels.NEEDS_AUTH_KEY
const BACKOFF_STATE_KEY = self.LandedPortalSentinels.BACKOFF_STATE_KEY
const FATAL_STATE_KEY = self.LandedPortalSentinels.FATAL_STATE_KEY

// Hosts the polling sweep should touch. Mirrors GREENHOUSE_HOSTS in the
// parser but framed as URL-match patterns chrome.tabs.query accepts.
// When Lever / Workday / Ashby parsers land (#33.1-#33.3) they add their
// own host-pattern arrays here.
const PORTAL_HOSTS = {
  greenhouse: [
    '*://boards.greenhouse.io/*',
    '*://boards.eu.greenhouse.io/*',
    '*://job-boards.greenhouse.io/*',
    '*://job-boards.eu.greenhouse.io/*',
    '*://my.greenhouse.io/*',
  ],
  lever: [
    '*://jobs.lever.co/*',
    '*://jobs.eu.lever.co/*',
  ],
  workday: [
    '*://*.myworkdayjobs.com/*',
    '*://*.myworkdaysite.com/*',
    '*://*.myworkday.com/*',
  ],
  ashby: [
    '*://*.ashbyhq.com/*',
    '*://ashbyhq.com/*',
  ],
}

// ── Side panel (preserved from earlier behaviour) ────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open) await chrome.sidePanel.open({ windowId: tab.windowId })
  else if (chrome.runtime.openOptionsPage) await chrome.runtime.openOptionsPage()
})

// ── Toolbar badge: at-a-glance sync status (#36.1) ───────────────────────
//
// Reads two pieces of state:
//   1. needs-auth sentinel — server rejected push on auth grounds; user
//      must re-sign-in for the queue to drain
//   2. pending-queue length — events staged for push but not yet sent
//
// Priority: needs-auth wins ("!" red) over pending-count ("N" slate). When
// both are clear, badge is empty (no chrome clutter).
//
// Last-writer-wins is the right semantic: this is purely visual state,
// chrome.action.setBadgeText is fire-and-forget, and concurrent updates
// from drain + ingest paths converge on the truth within ms.

const BADGE_NEEDS_AUTH_TEXT = '!'
const BADGE_NEEDS_AUTH_COLOR = '#dc2626'   // red-600 — clear warning
const BADGE_PENDING_COLOR = '#4b5563'      // slate-600 — neutral count

async function updateBadge() {
  const store = self.LandedSnapshotStore
  if (!store) return
  const storage = store.chromeStorageAdapter(chrome.storage.local)

  // Read both signals in parallel; either can win the next render.
  const [pendingQueue, needsAuthAt] = await Promise.all([
    store.loadPending(storage).catch(() => ({ events: [] })),
    new Promise((resolve) => {
      try { chrome.storage.local.get(NEEDS_AUTH_KEY, (res) => resolve(res && res[NEEDS_AUTH_KEY])) }
      catch { resolve(null) }
    }),
  ])

  if (needsAuthAt) {
    chrome.action.setBadgeText({ text: BADGE_NEEDS_AUTH_TEXT })
    chrome.action.setBadgeBackgroundColor({ color: BADGE_NEEDS_AUTH_COLOR })
    return
  }
  const count = (pendingQueue && pendingQueue.events && pendingQueue.events.length) || 0
  if (count > 0) {
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) })
    chrome.action.setBadgeBackgroundColor({ color: BADGE_PENDING_COLOR })
    return
  }
  // Clear — nothing pending, nothing wrong.
  chrome.action.setBadgeText({ text: '' })
}

// Fire-and-forget wrapper so call sites can be one-liners + don't have
// to handle a rejected promise (the function itself swallows internal
// errors — we never want a badge update to crash the SW).
function refreshBadge() {
  updateBadge().catch((err) => console.warn('[landed] badge update failed', err))
}

// ── Alarm lifecycle ──────────────────────────────────────────────────────

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (existing) return
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN })
  })
}

function ensurePushAlarm() {
  chrome.alarms.get(PUSH_ALARM, (existing) => {
    if (existing) return
    chrome.alarms.create(PUSH_ALARM, { periodInMinutes: PUSH_PERIOD_MIN })
  })
}

function ensureAllAlarms() { ensureAlarm(); ensurePushAlarm() }
// Also refresh the badge on SW boot so a returning user sees current
// state immediately (chrome.action badge survives SW eviction but a
// fresh install / browser restart starts blank).
function ensureBootState() { ensureAllAlarms(); refreshBadge() }
chrome.runtime.onInstalled.addListener(ensureBootState)
chrome.runtime.onStartup.addListener(ensureBootState)

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollAllPortals().catch((err) => console.warn('[landed] portal poll failed', err))
    return
  }
  if (alarm.name === PUSH_ALARM) {
    drainPendingEvents().catch((err) => console.warn('[landed] portal push failed', err))
  }
})

// ── Portal polling ───────────────────────────────────────────────────────

function queryTabs(urlPatterns) {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: urlPatterns }, (tabs) => resolve(tabs || []))
  })
}

function askTabToParse(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'parse-portal' }, (response) => {
        if (chrome.runtime.lastError) {
          // Tab may not have content script injected (e.g. reload pending,
          // or it loaded before the extension was enabled). Treat as no
          // event rather than an error — next poll will catch it.
          resolve(null)
          return
        }
        resolve(response || null)
      })
    } catch {
      resolve(null)
    }
  })
}

async function pollAllPortals() {
  const store = self.LandedSnapshotStore
  if (!store) return
  const storage = store.chromeStorageAdapter(chrome.storage.local)

  // Note: with only `activeTab` permission, `chrome.tabs.query` still
  // honors the URL pattern filter; the returned tab entries may have
  // `url: undefined` but `tab.id` is always populated. The content
  // script is already injected on every Greenhouse host via the
  // manifest content_scripts match list, so messaging by id works
  // without ever needing to read `tab.url` from the SW.
  for (const [portal, urlPatterns] of Object.entries(PORTAL_HOSTS)) {
    const tabs = await queryTabs(urlPatterns)
    if (tabs.length === 0) continue
    const results = await Promise.all(tabs.map((t) => askTabToParse(t.id)))
    const events = results.filter((r) => r && r.app_url)
    if (events.length === 0) continue
    await withQueueLock(() => store.ingest(storage, portal, events))
  }
}

// ── Real-time path: content.js auto-detects + pushes a single event ──────

// Apply Assist: page content scripts never call Ollama or a network API.
// Chrome starts Landed.app's registered Native Messaging host and hands it
// field labels plus the selected resume's flat values (and, to review a fill,
// the filled form with sensitive questions left out). The host returns typed
// key or option selections; content.js remains the only code that touches DOM.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'native-assist') return
  const request = msg.request
  if (!request || !['ping', 'match_fields', 'choose_options', 'review_fill'].includes(request.type)) {
    sendResponse({ ok: false, error: 'invalid native request' })
    return true
  }
  const turn = nativeAssistQueue.catch(() => {}).then(() => new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, request, (response) => {
      const error = chrome.runtime.lastError
      if (error) resolve({ ok: false, error: error.message || 'Landed for Mac is not installed' })
      else resolve(response || { ok: false, error: 'Landed for Mac returned no response' })
    })
  }))
  nativeAssistQueue = turn.then(() => undefined, () => undefined)
  turn.then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  })
  return true
})

// ── macOS menu-bar bridge ────────────────────────────────────────────────
//
// Landed.app is the control surface. The extension keeps this native port
// open so the app can list browser pages and request a fill even when the
// extension side panel is closed. Only tab metadata + resume names cross the
// bridge; the selected resume contents stay in chrome.storage and are sent
// directly to the selected page's content script.

function chromeGet(keys) {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(keys, (value) => resolve(value || {})) }
    catch { resolve({}) }
  })
}

function chromeSet(value) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set(value, resolve) }
    catch { resolve() }
  })
}

function allTabs() {
  return new Promise((resolve) => {
    try { chrome.tabs.query({}, (tabs) => resolve(tabs || [])) }
    catch { resolve([]) }
  })
}

// Kept in memory too: when storage isn't readable (Safari, before the
// extension is fully allowed) a new id on every publish left thousands of
// one-off sessions for the menu app to read.
let assistSessionIdCache = null

async function assistSessionId() {
  if (assistSessionIdCache) return assistSessionIdCache
  const stored = await chromeGet(ASSIST_SESSION_KEY)
  if (typeof stored[ASSIST_SESSION_KEY] === 'string') return (assistSessionIdCache = stored[ASSIST_SESSION_KEY])
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
  assistSessionIdCache = id
  await chromeSet({ [ASSIST_SESSION_KEY]: id })
  return id
}

async function loadAssistResumes() {
  const cfg = self.LandedConfig
  const stored = await chromeGet([cfg.LOCAL_RESUMES_KEY, cfg.SESSION_STORAGE_KEY])
  let resumes = stored[cfg.LOCAL_RESUMES_KEY]?.resumes
  if (!Array.isArray(resumes) || resumes.length === 0) {
    const session = stored[cfg.SESSION_STORAGE_KEY]
    if (session?.token) {
      try {
        const response = await fetch(`${cfg.API_URL}/api/resumes`, {
          headers: { Authorization: `Bearer ${session.token}` },
        })
        if (response.ok) resumes = await response.json()
      } catch {
        // The Landed page bridge is the offline/local-first fallback.
      }
    }
  }
  assistResumes = Array.isArray(resumes)
    ? resumes.filter((resume) => resume && typeof resume.id === 'string' && resume.parsed_json)
    : []
  return assistResumes
}

async function assistSnapshot(type = 'bridge_state') {
  const mod = self.LandedApplyAssistBridge
  const [sessionId, tabs, resumes] = await Promise.all([assistSessionId(), allTabs(), loadAssistResumes()])
  let brave = false
  try { brave = !!navigator.brave } catch { /* not Brave */ }
  return {
    type,
    session_id: sessionId,
    browser: mod.browserLabel(navigator.userAgent, brave),
    tabs: mod.publicTabs(tabs),
    resumes: mod.publicResumes(resumes),
  }
}

async function publishAssistState(type = 'bridge_state') {
  const port = assistPort
  if (!port) return
  const snapshot = await assistSnapshot(type)
  if (IS_SAFARI) {
    const response = await sendSafariNative(snapshot)
    for (const message of Array.isArray(response?.messages) ? response.messages : []) {
      if (message?.type === 'assist_fill') void runAssistCommand(message)
    }
    return
  }
  try { port.postMessage(snapshot) } catch { /* reconnect path handles it */ }
}

function sendSafariNative(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const error = chrome.runtime.lastError
        resolve(error ? { ok: false, error: error.message } : (response || { ok: false, error: 'No response from Landed' }))
      })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

// ── frames that hold a form (content.js reports them) ─────────────────────
// A tab's form may be in an iframe; each frame with 3+ fields says so, and
// a fill goes to the page plus those frames. Kept in session storage so a
// restarted service worker still knows them.

const FORM_FRAMES_KEY = 'landed:form-frames'

function loadFormFrames() {
  return new Promise((resolve) => {
    try { tabArea().get(FORM_FRAMES_KEY, (v) => resolve((v && v[FORM_FRAMES_KEY]) || {})) }
    catch { resolve({}) }
  })
}

let formFramesLock = Promise.resolve()
function updateFormFrames(fn) {
  const run = formFramesLock.then(async () => {
    const all = await loadFormFrames()
    fn(all)
    await new Promise((resolve) => {
      try { tabArea().set({ [FORM_FRAMES_KEY]: all }, resolve) }
      catch { resolve() }
    })
  })
  formFramesLock = run.catch(() => {})
  return run
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.action !== 'frame-form') return
  const tabId = sender && sender.tab && sender.tab.id
  const frameId = sender && sender.frameId
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId === 0) return
  void updateFormFrames((all) => {
    const frames = new Set(all[tabId] || [])
    if (msg.hasForm) frames.add(frameId)
    else frames.delete(frameId)
    if (frames.size) all[tabId] = [...frames]
    else delete all[tabId]
  })
})

try {
  chrome.tabs.onRemoved.addListener((tabId) => { void updateFormFrames((all) => { delete all[tabId] }) })
  // A new page in the tab means new frames.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void updateFormFrames((all) => { delete all[tabId] })
  })
} catch { /* tabs API unavailable */ }

function fillFrame(tabId, frameId, resume) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, {
        action: 'fill',
        resume: resume.parsed_json,
        // A tailored version's own PDF goes into the resume upload (lib/fill/files.js).
        resumeId: typeof resume.id === 'string' ? resume.id : null,
        aiTakeover: true,
      }, { frameId }, (response) => {
        const error = chrome.runtime.lastError
        if (error || !response) resolve({ error: error?.message || 'No response from page' })
        else resolve(response)
      })
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** Fill the page and every frame in it that holds a form; add them up. */
async function fillTab(tabId, resume) {
  const frames = [0, ...((await loadFormFrames())[tabId] || []).filter((id) => id !== 0)]
  const responses = await Promise.all(frames.map((frameId) => fillFrame(tabId, frameId, resume)))
  const answered = responses.filter((r) => !r.error)
  if (answered.length === 0) return { tabId, error: responses[0]?.error || 'No response from page' }
  const count = (key) => answered.reduce((sum, r) => sum + (Array.isArray(r[key]) ? r[key].length : 0), 0)
  const attached = new Set(answered.flatMap((r) => (Array.isArray(r.filled) ? r.filled : [])).filter((f) => String(f).startsWith('file:')).map((f) => String(f).slice(5)))
  const missing = [...new Set(answered.flatMap((r) => (Array.isArray(r.missing_files) ? r.missing_files : [])))].filter((kind) => !attached.has(kind))
  const unanswered = answered.flatMap((r) => (Array.isArray(r.unanswered) ? r.unanswered : []))
  await queueQuestions(tabId, unanswered)
  return {
    tabId, filled: count('filled'), review: count('manual'), missing_files: missing, frames: answered.length, agent_review: addReviews(answered),
    unanswered: unanswered.length,
  }
}

// ── questions a fill had to leave empty (lib/fill/unanswered.js) ──────────
// Queued in local storage until the open Landed tab takes them to the
// Extension page (bridge 'take-questions'). The tabs they came from are
// remembered for the session: when the answers come back ('sync-answers'),
// those pages fill the fields the answers now cover.

const QUESTION_TABS_KEY = 'landed:question-tabs'
const MAX_QUEUED_QUESTIONS = 60

function readArea(area, key) {
  return new Promise((resolve) => {
    try { area.get(key, (v) => resolve((v && v[key]) ?? null)) } catch { resolve(null) }
  })
}
function writeArea(area, values) {
  return new Promise((resolve) => {
    try { area.set(values, resolve) } catch { resolve() }
  })
}

async function queueQuestions(tabId, questions) {
  const CA = self.LandedChoiceAnswers
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)
  const list = questions.flatMap((q) => {
    const question = q && text(q.question, 300)
    if (!question) return []
    return [{
      question,
      key: text(q.key, 40),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => text(o, 200)).filter(Boolean).slice(0, 20),
      site: text(q.site, 120),
    }]
  })
  if (list.length === 0) return
  const key = self.LandedConfig.LOCAL_QUESTIONS_KEY
  await withQueueLock(async () => {
    const queued = (await readArea(chrome.storage.local, key)) || []
    // One entry per question per site until the Landed tab takes them.
    const id = (q) => `${CA.questionKey(q.question)}@${q.site || ''}`
    const have = new Set(queued.map(id))
    for (const q of list) if (!have.has(id(q))) queued.unshift(q)
    await writeArea(chrome.storage.local, { [key]: queued.slice(0, MAX_QUEUED_QUESTIONS) })
  })
  if (Number.isInteger(tabId)) {
    const tabs = (await readArea(tabArea(), QUESTION_TABS_KEY)) || {}
    tabs[tabId] = Date.now()
    await writeArea(tabArea(), { [QUESTION_TABS_KEY]: tabs })
  }
}

/** The answers changed: pages that had empty questions fill what they now cover. */
async function fillAnsweredTabs() {
  const tabs = (await readArea(tabArea(), QUESTION_TABS_KEY)) || {}
  const frames = await loadFormFrames()
  for (const tabId of Object.keys(tabs).map(Number)) {
    for (const frameId of [0, ...(frames[tabId] || []).filter((id) => id !== 0)]) {
      try {
        chrome.tabs.sendMessage(tabId, { action: 'fill-answers' }, { frameId }, () => { void chrome.runtime.lastError })
      } catch { /* the tab is gone */ }
    }
  }
}

try {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const tabs = (await readArea(tabArea(), QUESTION_TABS_KEY)) || {}
    if (!(tabId in tabs)) return
    delete tabs[tabId]
    await writeArea(tabArea(), { [QUESTION_TABS_KEY]: tabs })
  })
} catch { /* tabs API unavailable */ }

/** The agent review of each frame (lib/fill/review.js), added up. */
function addReviews(responses) {
  const reviews = responses.map((r) => r.review).filter((r) => r && typeof r === 'object')
  if (reviews.length === 0) return null
  const sum = (key) => reviews.reduce((total, r) => total + (Number(r[key]) || 0), 0)
  const ran = reviews.filter((r) => !r.error)
  return {
    checked: sum('checked'), fixed: sum('fixed'), flagged: sum('flagged'), left_out: sum('left_out'),
    model: ran.map((r) => r.model).find((m) => typeof m === 'string') || null,
    error: ran.length === 0 ? reviews.map((r) => r.error).find(Boolean) || null : null,
  }
}

// The popup's Fill: same frame-aware fill, with the resume it picked.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'fill-tab') return
  if (sender && sender.tab) return // extension pages only, never a web page
  if (!Number.isInteger(msg.tabId) || !msg.resume || typeof msg.resume !== 'object') {
    sendResponse({ error: 'invalid fill request' })
    return true
  }
  fillTab(msg.tabId, { parsed_json: msg.resume, id: typeof msg.resume_id === 'string' ? msg.resume_id : null }).then(sendResponse, (error) => sendResponse({ error: String(error) }))
  return true
})

function getTab(tabId) {
  return new Promise((resolve) => {
    try { chrome.tabs.get(tabId, (tab) => { void chrome.runtime.lastError; resolve(tab || null) }) }
    catch { resolve(null) }
  })
}

/** "auto": the resume lib/resume-pick.js picks for this page — the version
 *  tailored for its job (or the application Landed opened it for), else the
 *  current one. */
async function autoResumeFor(tabId) {
  const [tab, tabs] = await Promise.all([getTab(tabId), loadAssistTabs()])
  const opened = tabs[tabId]
  const pick = self.LandedResumePick.pickResumeForPage({
    url: tab?.url || '', title: tab?.title || '', applicationId: opened?.application_id || null,
  }, assistResumes)
  return pick ? pick.resume : null
}

async function runAssistCommand(command) {
  if (!assistPort || command?.type !== 'assist_fill') return
  await loadAssistResumes()
  const auto = command.resume_id === 'auto'
  const resume = auto ? null : assistResumes.find((item) => item.id === command.resume_id)
  const tabIds = Array.isArray(command.tab_ids)
    ? [...new Set(command.tab_ids.filter(Number.isInteger))].slice(0, 5)
    : []
  let results
  if (tabIds.length === 0 || (!auto && !resume)) {
    results = tabIds.map((tabId) => ({ tabId, error: resume || auto ? 'No pages selected' : 'Resume is not available in this browser' }))
  } else {
    results = await Promise.all(tabIds.map(async (tabId) => {
      const chosen = auto ? await autoResumeFor(tabId) : resume
      return chosen ? fillTab(tabId, chosen) : { tabId, error: 'Resume is not available in this browser' }
    }))
  }
  const summary = self.LandedApplyAssistBridge.fillSummary(results)
  const result = {
    type: 'bridge_result',
    session_id: await assistSessionId(),
    command_id: command.command_id,
    ...summary,
  }
  if (IS_SAFARI) {
    await sendSafariNative(result)
    return
  }
  try {
    assistPort.postMessage(result)
  } catch { /* browser/native host disconnected */ }
}

function connectAssistBridge() {
  if (assistPort) return
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST)
    assistPort = port
    port.onMessage.addListener((message) => {
      if (message?.type === 'assist_fill') void runAssistCommand(message)
      else if (IS_SAFARI) void publishAssistState()
    })
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (assistPort === port) assistPort = null
      if (assistPublishTimer) clearInterval(assistPublishTimer)
      assistPublishTimer = null
      if (assistReconnectTimer) clearTimeout(assistReconnectTimer)
      assistReconnectTimer = setTimeout(connectAssistBridge, 5000)
    })
    void publishAssistState('bridge_hello')
    assistPublishTimer = setInterval(() => void publishAssistState(), 5000)
  } catch {
    assistPort = null
    if (assistReconnectTimer) clearTimeout(assistReconnectTimer)
    assistReconnectTimer = setTimeout(connectAssistBridge, 5000)
  }
}

function scheduleAssistPublish() {
  if (!assistPort) return connectAssistBridge()
  setTimeout(() => void publishAssistState(), 100)
}

for (const event of [chrome.tabs.onCreated, chrome.tabs.onUpdated, chrome.tabs.onRemoved, chrome.tabs.onActivated]) {
  try { event.addListener(scheduleAssistPublish) } catch { /* older browser */ }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (self.LandedConfig.LOCAL_RESUMES_KEY in changes || self.LandedConfig.SESSION_STORAGE_KEY in changes) scheduleAssistPublish()
})
connectAssistBridge()

// ── Open & autofill from Landed ──────────────────────────────────────────
//
// "Open & autofill" on a lead or application in Landed (bridge request
// assist-open): open its posting, fill the form once it has loaded with the
// resume version Landed picked — again on the next page if the form isn't
// on this one (an "Apply" button that leads to it) — and remember which
// application/lead the tab is for, so the "thanks for applying" page lands
// on that one. Same fill as the menu bar: it never submits.

const ASSIST_TABS_KEY = 'landed:assist-tabs'
const FILL_RETRIES_MS = [1500, 3000, 6000]

function tabArea() {
  // Session storage outlives the service worker but not the browser.
  try { return chrome.storage.session || chrome.storage.local } catch { return chrome.storage.local }
}

function loadAssistTabs() {
  return new Promise((resolve) => {
    try { tabArea().get(ASSIST_TABS_KEY, (v) => resolve((v && v[ASSIST_TABS_KEY]) || {})) }
    catch { resolve({}) }
  })
}

let assistTabsLock = Promise.resolve()
function updateAssistTabs(fn) {
  const run = assistTabsLock.then(async () => {
    const tabs = await loadAssistTabs()
    const next = fn(tabs) || tabs
    await new Promise((resolve) => {
      try { tabArea().set({ [ASSIST_TABS_KEY]: next }, resolve) }
      catch { resolve() }
    })
    return next
  })
  assistTabsLock = run.catch(() => {})
  return run
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fill a Landed-opened tab, retrying while the page builds its form. */
async function fillAssistTab(tabId) {
  for (const wait of FILL_RETRIES_MS) {
    await delay(wait)
    const entry = (await loadAssistTabs())[tabId]
    if (!entry || entry.filled) return
    await loadAssistResumes()
    const resume = assistResumes.find((item) => item.id === entry.resume_id)
    if (!resume) return
    const result = await fillTab(tabId, resume)
    if (result.filled > 0 || result.review > 0) {
      await updateAssistTabs((tabs) => { if (tabs[tabId]) tabs[tabId].filled = true })
      return
    }
  }
}

async function openAndFill({ url, resume_id, application_id, lead_id }) {
  await loadAssistResumes()
  const resume = assistResumes.find((item) => item.id === resume_id)
  if (!resume) return { ok: false, error: "That resume isn't in this browser yet. Reload Landed so it syncs, then try again." }
  const tab = await new Promise((resolve) => {
    try { chrome.tabs.create({ url, active: true }, (t) => { void chrome.runtime.lastError; resolve(t || null) }) }
    catch { resolve(null) }
  })
  if (!tab || !Number.isInteger(tab.id)) return { ok: false, error: 'Could not open the posting' }
  await updateAssistTabs((tabs) => {
    tabs[tab.id] = { resume_id, application_id, lead_id, filled: false, opened_at: Date.now() }
  })
  return { ok: true, data: { tab_id: tab.id, resume: resume.name } }
}

try {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return
    loadAssistTabs().then((tabs) => {
      if (tabs[tabId] && !tabs[tabId].filled) void fillAssistTab(tabId)
    })
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    loadAssistTabs().then((tabs) => {
      if (tabs[tabId]) void updateAssistTabs((next) => { delete next[tabId] })
    })
  })
} catch { /* tabs API unavailable */ }

/** A portal event from a tab Landed opened carries its application/lead. */
async function withAssistTab(sender, event) {
  const tabId = sender && sender.tab && sender.tab.id
  if (!Number.isInteger(tabId)) return event
  const entry = (await loadAssistTabs())[tabId]
  if (!entry) return event
  return Object.assign({}, event, {
    application_id: entry.application_id || undefined,
    lead_id: entry.lead_id || undefined,
  })
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'portal-event') return
  const store = self.LandedSnapshotStore
  if (!store || !msg.event || !msg.portal) {
    sendResponse({ ok: false, error: 'invalid' })
    return true
  }
  const storage = store.chromeStorageAdapter(chrome.storage.local)
  withAssistTab(sender, msg.event)
    .then((event) => withQueueLock(() => store.ingest(storage, msg.portal, [event])))
    .then((result) => {
      // Real-time fast path: don't wait for the 1-min alarm. Fire-and-
      // forget — if push fails, the alarm catches the leftover queue.
      drainPendingEvents().catch(() => {})
      // Bump the badge immediately so the user sees the new pending
      // count even before the drain attempt resolves.
      refreshBadge()
      sendResponse({ ok: true, result })
    })
    .catch((err) => sendResponse({ ok: false, error: String(err) }))
  return true
})

// ── Web bridge: the open Landed tab pulls events / pushes resumes ────────
//
// See lib/bridge-handler.js. Works with or without a Cloud account; in local
// mode it's the only way portal events reach the user's data.

const handleBridge = self.LandedBridge.createBridgeHandler({
  cfg: self.LandedConfig,
  snapshotStore: self.LandedSnapshotStore,
  pushMod: self.LandedPortalEventsPush,
  storage: self.LandedSnapshotStore.chromeStorageAdapter(chrome.storage.local),
  chromeLocal: chrome.storage.local,
  withLock: withQueueLock,
  onQueueChanged: () => refreshBadge(),
  version: chrome.runtime.getManifest().version,
  openAndFill,
  onAnswersSynced: () => { void fillAnsweredTabs() },
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'landed-bridge') return
  handleBridge(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }))
  return true
})

// ── Drain: push staged events to the Landed API ──────────────────────────
//
// Runs every PUSH_PERIOD_MIN minutes AND immediately after each
// real-time portal-event ingest. Reads the user's session ({ token, user })
// out of chrome.storage.local, where lib/auth.js stores it on sign-in. On
// 401/403 we mark NEEDS_AUTH_KEY so #36's popup re-auth flow can prompt
// the user — expiry is decided server-side, so there's no local check.

async function readSession() {
  const cfg = self.LandedConfig
  const adapterMod = self.LandedStorageAdapter
  if (!cfg || !adapterMod) return null
  const raw = await adapterMod.chromeStorageAdapter.getItem(cfg.SESSION_STORAGE_KEY)
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string') return null
  return raw
}

function drainPendingEvents() {
  return withQueueLock(drainPendingEventsLocked)
}

// Only call via drainPendingEvents() — assumes the queue lock is held.
async function drainPendingEventsLocked() {
  const store = self.LandedSnapshotStore
  const pushMod = self.LandedPortalEventsPush
  const cfg = self.LandedConfig
  if (!store || !pushMod || !cfg) return

  const storage = store.chromeStorageAdapter(chrome.storage.local)

  // Backoff gate (#35.2): on sustained retryable failures we don't want
  // to hammer at the 1-min alarm cadence. If we set a future
  // next_retry_at on the last failure, skip until that time. Doesn't
  // gate needsAuth (user re-auth is the unblocker) or fatal (we
  // already dropped the queue).
  const backoffState = await loadBackoffState()
  if (backoffState && backoffState.next_retry_at) {
    const nextRetry = Date.parse(backoffState.next_retry_at)
    if (Number.isFinite(nextRetry) && nextRetry > Date.now()) return
  }

  const queue = await store.loadPending(storage)
  if (!queue.events || queue.events.length === 0) {
    // Queue empty — if backoff state was lingering from a prior outage,
    // clear it so a future event starts at the 1-min step rather than
    // continuing where the (no-longer-relevant) outage left off. The
    // gate above already short-circuited if we were mid-cooldown; this
    // only runs when cooldown has elapsed AND there's nothing to push.
    if (backoffState) chrome.storage.local.remove(BACKOFF_STATE_KEY)
    return
  }

  const session = await readSession()
  if (!session || !session.user || !session.user.id) {
    // Not signed in, token expired, or session shape lost its user. Leave
    // the queue alone — events accumulate until the user signs in, then
    // the next alarm drains. Don't set NEEDS_AUTH here: that flag is for
    // SERVER-side auth rejection (real expiry / revoked session), not
    // local "no session yet." #36's popup decides whether to nudge based
    // on the sentinel.
    return
  }

  const rows = queue.events
    .map((ev) => pushMod.mapEventToRow(ev, session.user.id))
    .filter(Boolean)
  if (rows.length === 0) {
    // Every event mapped to null despite a valid user.id — that means
    // each one was malformed (no kind, etc). Drop them; retrying the
    // same malformed entries would never push.
    await store.clearPending(storage)
    return
  }

  const result = await pushMod.pushEvents(
    fetch.bind(self),
    cfg.API_URL,
    session.token,
    rows,
  )

  if (result.ok) {
    await store.clearPending(storage)
    // Clear any stale sentinels — push just succeeded. Includes the
    // fatal sentinel so a transient deploy-bug that healed doesn't
    // leave the banner visible forever.
    chrome.storage.local.remove([NEEDS_AUTH_KEY, BACKOFF_STATE_KEY, FATAL_STATE_KEY])
    refreshBadge()
    return
  }
  if (result.cloudOff) {
    // Signed in, but the account keeps its data on-device (Landed Cloud sync
    // off). The open Landed tab drains the queue over the page bridge; don't
    // re-ask the server every minute — check again in 30 minutes in case
    // sync gets turned on.
    await saveBackoffState({ consecutive_failures: 0, next_retry_at: new Date(Date.now() + 30 * 60_000).toISOString() })
    return
  }
  if (result.needsAuth) {
    chrome.storage.local.set({ [NEEDS_AUTH_KEY]: new Date().toISOString() })
    // Queue intact — retry on next alarm after the user re-authenticates.
    // No backoff: the user re-auth is the unblocker, not waiting.
    refreshBadge()
    return
  }
  if (result.fatal) {
    // Schema mismatch / RLS rejection — code bug, not transient. Log
    // loudly + drop the queue (retrying the same payload would fail
    // forever and grow chrome.storage.local without bound). Also clear
    // backoff state (queue gone) AND set the fatal sentinel so the
    // popup surfaces a "Sync is misconfigured" banner (#35.4) —
    // console.error alone is invisible to the user.
    console.error('[landed] portal-events push FATAL — dropping queue', result.error)
    await store.clearPending(storage)
    chrome.storage.local.remove(BACKOFF_STATE_KEY)
    chrome.storage.local.set({
      [FATAL_STATE_KEY]: { error: String(result.error || 'unknown'), at: new Date().toISOString() },
    })
    refreshBadge()
    return
  }
  // retryable — leave queue intact; advance backoff state so the next
  // few alarm wakes skip until next_retry_at, then try again. Badge
  // doesn't change (queue length unchanged + no needs-auth flip).
  const prevFailures = (backoffState && backoffState.consecutive_failures) || 0
  const consecutive_failures = prevFailures + 1
  const next_retry_at = new Date(Date.now() + pushMod.nextBackoffMs(consecutive_failures)).toISOString()
  await saveBackoffState({ consecutive_failures, next_retry_at })
}

// ── Backoff state read/write (chrome.storage.local) ──────────────────────

function loadBackoffState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(BACKOFF_STATE_KEY, (res) => {
      const v = res && res[BACKOFF_STATE_KEY]
      resolve(v && typeof v === 'object' ? v : null)
    })
  })
}

function saveBackoffState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BACKOFF_STATE_KEY]: state }, () => resolve())
  })
}
