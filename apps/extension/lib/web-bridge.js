// lib/web-bridge.js — content script on the Landed web app's own pages.
//
// Relays window.postMessage requests from the page to the service worker
// (bridge-handler.js) and posts the reply back. Only injected on Landed
// origins (manifest content_scripts), and the service worker re-checks the
// sender origin. Protocol:
//
//   page → here:  { source: 'landed-web', id, type, payload }
//   here → page:  { source: 'landed-extension', id, ok, data, error }
//   on load:      { source: 'landed-extension', type: 'ready', version }

(function () {
  const OUT = 'landed-extension'
  const target = window.location.origin

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'landed-web') return
    const { id, type, payload } = e.data
    try {
      chrome.runtime.sendMessage({ action: 'landed-bridge', type, payload }, (res) => {
        const err = chrome.runtime.lastError
        window.postMessage({
          source: OUT,
          id,
          ok: !err && !!res && res.ok === true,
          data: res && res.data,
          error: err ? err.message : res && res.error,
        }, target)
      })
    } catch (err) {
      // Extension reloaded under the page ("context invalidated").
      window.postMessage({ source: OUT, id, ok: false, error: String(err) }, target)
    }
  })

  window.postMessage({ source: OUT, type: 'ready', version: chrome.runtime.getManifest().version }, target)
})()
