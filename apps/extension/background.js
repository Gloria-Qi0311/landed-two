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

importScripts('lib/snapshot-store.js', 'lib/config.js', 'lib/storage-adapter.js', 'lib/portal-events-push.js', 'lib/portal-sentinels.js', 'lib/bridge-handler.js')

// Every read-modify-write of the pending-event queue (ingest, Cloud push,
// web-bridge take) runs under this lock so none of them clobbers another —
// e.g. an event ingested mid-push no longer gets cleared unsent.
const withQueueLock = self.LandedBridge.createQueueLock()

const ALARM_NAME = 'landed-portal-poll'
const POLL_PERIOD_MIN = 360  // 6 hours

const PUSH_ALARM = 'landed-portal-push'
const PUSH_PERIOD_MIN = 1    // drain pending queue every minute when signed in

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
  await chrome.sidePanel.open({ windowId: tab.windowId })
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'portal-event') return
  const store = self.LandedSnapshotStore
  if (!store || !msg.event || !msg.portal) {
    sendResponse({ ok: false, error: 'invalid' })
    return true
  }
  const storage = store.chromeStorageAdapter(chrome.storage.local)
  withQueueLock(() => store.ingest(storage, msg.portal, [msg.event]))
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
