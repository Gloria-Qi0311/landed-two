// background.js — MV3 service worker.
//
// Responsibilities:
//   1. Open the side panel when the toolbar icon is clicked.
//   2. Maintain a 6-hour 'landed-portal-poll' alarm. When the alarm
//      fires, query every open tab on a known portal host, ask the tab's
//      content script to parse + return any portal events it can detect,
//      then run the result through the snapshot-store. New + changed
//      events land in chrome.storage.local under the
//      `landed:pending-portal-events` key for #35 to push to Supabase.
//   3. Accept real-time `portal-event` messages from content.js (the
//      auto-parse-on-page-load fast path) and ingest the same way.
//
// MV3 service workers are short-lived: any state held in module scope
// disappears between invocations. All persistence goes through
// chrome.storage.local via the snapshot-store. Alarms survive SW death;
// chrome.runtime.onStartup re-arms on browser restart in case the
// onInstalled handler never ran.

importScripts('lib/snapshot-store.js')

const ALARM_NAME = 'landed-portal-poll'
const POLL_PERIOD_MIN = 360  // 6 hours

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
}

// ── Side panel (preserved from earlier behaviour) ────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId })
})

// ── Alarm lifecycle ──────────────────────────────────────────────────────

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (existing) return
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN })
  })
}

chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  pollAllPortals().catch((err) => {
    console.warn('[landed] portal poll failed', err)
  })
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
    await store.ingest(storage, portal, events)
  }
}

// ── Real-time path: content.js auto-detects + pushes a single event ──────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'portal-event') return
  const store = self.LandedSnapshotStore
  if (!store || !msg.event || !msg.portal) {
    sendResponse({ ok: false, error: 'invalid' })
    return true
  }
  const storage = store.chromeStorageAdapter(chrome.storage.local)
  store.ingest(storage, msg.portal, [msg.event])
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }))
  return true
})
