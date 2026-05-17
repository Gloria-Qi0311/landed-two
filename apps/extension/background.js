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

importScripts('lib/snapshot-store.js', 'lib/config.js', 'lib/storage-adapter.js', 'lib/portal-events-push.js')

const ALARM_NAME = 'landed-portal-poll'
const POLL_PERIOD_MIN = 360  // 6 hours

const PUSH_ALARM = 'landed-portal-push'
const PUSH_PERIOD_MIN = 1    // drain pending queue every minute when signed in

// chrome.storage.local key we set when push fails with 401/403 so #36's
// expired-login flow can wake the user up via the popup. Value is an
// ISO timestamp of the most recent auth failure.
const NEEDS_AUTH_KEY = 'landed:portal-push-needs-auth'

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
  await chrome.sidePanel.open({ windowId: tab.windowId })
})

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
chrome.runtime.onInstalled.addListener(ensureAllAlarms)
chrome.runtime.onStartup.addListener(ensureAllAlarms)

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
    .then((result) => {
      // Real-time fast path: don't wait for the 1-min alarm. Fire-and-
      // forget — if push fails, the alarm catches the leftover queue.
      drainPendingEvents().catch(() => {})
      sendResponse({ ok: true, result })
    })
    .catch((err) => sendResponse({ ok: false, error: String(err) }))
  return true
})

// ── Drain: push staged events to Supabase ────────────────────────────────
//
// Runs every PUSH_PERIOD_MIN minutes AND immediately after each
// real-time portal-event ingest. Reads the user's session out of
// chrome.storage.local (where the supabase-js auth flow stashed it via
// lib/storage-adapter.js — we don't instantiate supabase-js in the SW
// because that would pull MB of bundle into the worker). On 401/403 we
// mark NEEDS_AUTH_KEY so #36's popup re-auth flow can prompt the user.

function deriveSessionStorageKey(supabaseUrl) {
  // supabase-js stores sessions under `sb-<project-ref>-auth-token`.
  // Derive ref from the supabase URL hostname's first subdomain.
  try {
    const ref = new URL(supabaseUrl).hostname.split('.')[0]
    return 'sb-' + ref + '-auth-token'
  } catch {
    return null
  }
}

async function readSession() {
  const cfg = self.LandedConfig
  const adapterMod = self.LandedStorageAdapter
  if (!cfg || !adapterMod) return null
  const key = deriveSessionStorageKey(cfg.SUPABASE_URL)
  if (!key) return null
  const raw = await adapterMod.chromeStorageAdapter.getItem(key)
  if (!raw) return null
  let parsed
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  if (!parsed || !parsed.access_token) return null
  // Reject expired tokens up front rather than getting a 401 from PostgREST.
  // `expires_at` is a Unix-seconds integer.
  if (parsed.expires_at && parsed.expires_at * 1000 < Date.now()) return null
  return parsed
}

async function drainPendingEvents() {
  const store = self.LandedSnapshotStore
  const pushMod = self.LandedPortalEventsPush
  const cfg = self.LandedConfig
  if (!store || !pushMod || !cfg) return

  const storage = store.chromeStorageAdapter(chrome.storage.local)
  const queue = await store.loadPending(storage)
  if (!queue.events || queue.events.length === 0) return

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
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY,
    session.access_token,
    rows,
  )

  if (result.ok) {
    await store.clearPending(storage)
    // Clear any stale "needs auth" sentinel — push just succeeded.
    chrome.storage.local.remove(NEEDS_AUTH_KEY)
    return
  }
  if (result.needsAuth) {
    chrome.storage.local.set({ [NEEDS_AUTH_KEY]: new Date().toISOString() })
    // Queue intact — retry on next alarm after the user re-authenticates.
    return
  }
  if (result.fatal) {
    // Schema mismatch / RLS rejection — code bug, not transient. Log
    // loudly + drop the queue (retrying the same payload would fail
    // forever and grow chrome.storage.local without bound).
    console.error('[landed] portal-events push FATAL — dropping queue', result.error)
    await store.clearPending(storage)
    return
  }
  // retryable — leave queue intact; next alarm tries again.
}
